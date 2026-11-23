// Wire protocol between the Herdr viewer process and the main Pi process, plus the viewer's
// input framer and frame sanitizer. Shared by a standalone viewer run directly by Bun or Node:
// node: built-ins and erasable syntax only, no Pi packages.

import { StringDecoder } from "node:string_decoder";

/** Lines of scroll per wheel report. */
export const WHEEL_LINES = 3;
/** Byte cap for one line received by the Pi-side server. */
export const MAX_VIEWER_LINE = 65536;
/** Cap for `input.data`, in UTF-16 code units. */
export const MAX_INPUT_DATA = 4096;
/** Byte cap for one frame line received by the viewer. */
export const MAX_FRAME_LINE = 4194304;
/** Bytes of an incomplete SGR mouse report the framer holds across chunks. */
export const MAX_MOUSE_PENDING = 32;

const MAX_GEOMETRY = 1000;
const WHEEL_UP_BUTTON = 64;
const WHEEL_DOWN_BUTTON = 65;
const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

export type ViewerMessage =
	| { type: "hello"; key: string; cols: number; rows: number }
	| { type: "resize"; cols: number; rows: number }
	| { type: "input"; data: string }
	| { type: "wheel"; delta: number };

export type PiMessage = { type: "frame"; lines: string[] };

export type InputEvent = { type: "input"; data: string } | { type: "wheel"; delta: number };

type Json = Record<string, unknown>;

export function encodeMessage(message: ViewerMessage | PiMessage): string {
	return `${JSON.stringify(message)}\n`;
}

function parseObject(line: string): Json | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function isGeometry(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_GEOMETRY;
}

function isKey(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isInputData(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_INPUT_DATA;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseViewerBody(body: Json): ViewerMessage | undefined {
	switch (body.type) {
		case "hello":
			return isKey(body.key) && isGeometry(body.cols) && isGeometry(body.rows)
				? { type: "hello", key: body.key, cols: body.cols, rows: body.rows }
				: undefined;
		case "resize":
			return isGeometry(body.cols) && isGeometry(body.rows)
				? { type: "resize", cols: body.cols, rows: body.rows }
				: undefined;
		case "input":
			return isInputData(body.data) ? { type: "input", data: body.data } : undefined;
		case "wheel":
			return isFiniteNumber(body.delta) ? { type: "wheel", delta: body.delta } : undefined;
		default:
			return undefined;
	}
}

/** Parses one viewer → Pi line; out-of-bounds or malformed input yields `undefined`. */
export function parseViewerMessage(line: string): ViewerMessage | undefined {
	const body = parseObject(line);
	return body === undefined ? undefined : parseViewerBody(body);
}

/** Parses one Pi → viewer line; malformed input yields `undefined`. */
export function parsePiMessage(line: string): PiMessage | undefined {
	const body = parseObject(line);
	if (body?.type !== "frame" || !Array.isArray(body.lines)) return undefined;
	const lines = body.lines;
	return lines.every((l): l is string => typeof l === "string") ? { type: "frame", lines } : undefined;
}

function exceeds(text: string, maxBytes: number): boolean {
	return Buffer.byteLength(text, "utf8") > maxBytes;
}

/** Splits a byte stream into newline-delimited lines; UTF-8 safe across chunks. */
export class MessageSplitter {
	private readonly maxLineBytes: number;
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";

	constructor(maxLineBytes: number) {
		this.maxLineBytes = maxLineBytes;
	}

	/** On overflow, returns no lines and clears the buffer; the caller closes the stream. */
	push(chunk: Buffer | string): { lines: string[]; overflow: boolean } {
		const text = this.pending + (typeof chunk === "string" ? chunk : this.decoder.write(chunk));
		const parts = text.split("\n");
		this.pending = parts.pop() ?? "";
		const overflow = parts.some((l) => exceeds(l, this.maxLineBytes)) || exceeds(this.pending, this.maxLineBytes);
		if (overflow) {
			this.pending = "";
			return { lines: [], overflow: true };
		}
		return { lines: parts.filter((l) => l !== ""), overflow: false };
	}
}

function isHighSurrogate(code: number): boolean {
	return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

/** Splits input into pieces of at most `max` code units, never between a surrogate pair. */
export function chunkInput(data: string, max = MAX_INPUT_DATA): string[] {
	const pieces: string[] = [];
	let start = 0;
	while (start < data.length) {
		let end = Math.min(start + max, data.length);
		if (end < data.length && end - 1 > start && isHighSurrogate(data.charCodeAt(end - 1))) end -= 1;
		pieces.push(data.slice(start, end));
		start = end;
	}
	return pieces;
}

// Alternatives are tried left to right at each position. Group 1 is the only form kept:
// SGR (`ESC [ params m`) and OSC 8 hyperlinks. Everything else is dropped.
const KEPT_SEQUENCE = /\x1b\[[0-9;:]*m|\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/;
const DROPPED_SEQUENCES = [
	/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/, // OSC other than 8
	/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c)?/, // DCS, SOS, PM, APC
	/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?/, // CSI, including C1 CSI
	/\x1b[ -/]*[0-~]?/, // two-byte escape, and a lone ESC
];
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
const SEQUENCE_OR_CONTROL = new RegExp(
	[
		`(${KEPT_SEQUENCE.source})`,
		...DROPPED_SEQUENCES.map((re) => `(?:${re.source})`),
		CONTROL.source,
	].join("|"),
	"g",
);

/** Keeps SGR and OSC 8 from a rendered row; drops other escapes and controls, turns tab into a space. */
export function sanitizeFrameLine(line: string): string {
	return line.replace(SEQUENCE_OR_CONTROL, (match: string, kept?: string) => {
		if (kept !== undefined) return kept;
		return match === "\t" ? " " : "";
	});
}

const SGR_MOUSE_REPORT = /\x1b\[<([0-9]+);[0-9]+;[0-9]+[Mm]/g;
const PARTIAL_MOUSE_REPORT = /\x1b(?:\[(?:<[0-9;]*)?)?$/;

function wheelEvent(button: string): InputEvent | undefined {
	if (button === String(WHEEL_UP_BUTTON)) return { type: "wheel", delta: -WHEEL_LINES };
	if (button === String(WHEEL_DOWN_BUTTON)) return { type: "wheel", delta: WHEEL_LINES };
	return undefined;
}

/** Turns complete text into events: wheel reports become wheel events, other mouse reports vanish. */
function eventsOf(text: string): InputEvent[] {
	const events: InputEvent[] = [];
	let last = 0;
	for (const match of text.matchAll(SGR_MOUSE_REPORT)) {
		const index = match.index ?? 0;
		pushInput(events, text.slice(last, index));
		const wheel = wheelEvent(match[1]);
		if (wheel) events.push(wheel);
		last = index + match[0].length;
	}
	pushInput(events, text.slice(last));
	return events;
}

function pushInput(events: InputEvent[], data: string): void {
	if (data !== "") events.push({ type: "input", data });
}

/** Frames viewer stdin: wheel reports and other mouse reports are split out of plain input. */
export class InputFramer {
	private pending = "";

	push(chunk: string): InputEvent[] {
		const text = this.pending + chunk;
		this.pending = "";
		const partial = PARTIAL_MOUSE_REPORT.exec(text)?.[0] ?? "";
		if (partial !== "" && partial.length <= MAX_MOUSE_PENDING) {
			this.pending = partial;
			return eventsOf(text.slice(0, text.length - partial.length));
		}
		return eventsOf(text);
	}
}
