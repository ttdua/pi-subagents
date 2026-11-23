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
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

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
		return { lines: parts, overflow: false };
	}
}

function isHighSurrogate(code: number): boolean {
	return code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
}

function isLowSurrogate(code: number): boolean {
	return code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;
}

/** Splits input into pieces of at most `max` code units, never between a surrogate pair. */
export function chunkInput(data: string, max = MAX_INPUT_DATA): string[] {
	// max = 1 cannot hold a surrogate pair, so it could never make progress.
	if (!Number.isInteger(max) || max < 2) throw new RangeError(`chunkInput max must be an integer >= 2, got ${max}`);
	const pieces: string[] = [];
	let start = 0;
	while (start < data.length) {
		let end = Math.min(start + max, data.length);
		if (splitsSurrogatePair(data, end)) end -= 1;
		pieces.push(data.slice(start, end));
		start = end;
	}
	return pieces;
}

/** True when cutting at `end` separates a high surrogate from the low surrogate after it. */
function splitsSurrogatePair(data: string, end: number): boolean {
	return (
		end < data.length &&
		isHighSurrogate(data.charCodeAt(end - 1)) &&
		isLowSurrogate(data.charCodeAt(end))
	);
}

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;
const C1_ST = "\x9c";
const C1_CSI = "\x9b";
const C1_OSC = "\x9d";
const C1_STRING_STARTS = new Set(["\x90", "\x98", "\x9e", "\x9f"]);
const SGR_BODY = /^[0-9;:]*m$/;
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** Where a recognized escape sequence ends, and the text to keep (`undefined` drops it). */
interface Sequence {
	end: number;
	keep?: string;
}

interface StringBody {
	end: number;
	body: string;
	terminator: "bel" | "st" | "esc" | "none";
}

const isParamOrIntermediate = (code: number): boolean => code >= 0x20 && code <= 0x3f;
const isCsiFinal = (code: number): boolean => code >= 0x40 && code <= 0x7e;
// Generic ESC finals also include 0x30-0x3f (`ESC 7`, `ESC 8`, `ESC =`, `ESC >`).
const isEscFinal = (code: number): boolean => code >= 0x30 && code <= 0x7e;

/** CSI: parameter and intermediate bytes, then one final byte. Only `ESC [ params m` is kept. */
function scanCsi(line: string, start: number, escaped: boolean): Sequence {
	let end = start;
	while (end < line.length && isParamOrIntermediate(line.charCodeAt(end))) end++;
	if (end < line.length && isCsiFinal(line.charCodeAt(end))) end++;
	const body = line.slice(start, end);
	return { end, keep: escaped && SGR_BODY.test(body) ? `${ESC}[${body}` : undefined };
}

/**
 * Reads a string body up to its terminator. BEL ends it only when `allowBel` (OSC); DCS, SOS, PM
 * and APC end at ST alone. An ESC that is not `ESC \` ends it unterminated.
 */
function scanString(line: string, start: number, allowBel: boolean): StringBody {
	for (let j = start; j < line.length; j++) {
		const ch = line[j];
		if (ch === BEL && allowBel) return { end: j + 1, body: line.slice(start, j), terminator: "bel" };
		if (ch === C1_ST) return { end: j + 1, body: line.slice(start, j), terminator: "st" };
		if (ch !== ESC) continue;
		if (line[j + 1] === "\\") return { end: j + 2, body: line.slice(start, j), terminator: "esc" };
		return { end: j, body: line.slice(start, j), terminator: "none" };
	}
	return { end: line.length, body: line.slice(start), terminator: "none" };
}

/** OSC 8 keeps `8 ; params ; uri` only when no C0/C1 control sits inside and it ends with BEL or `ESC \`. */
function isKeptHyperlink(s: StringBody): boolean {
	if (s.terminator !== "bel" && s.terminator !== "esc") return false;
	if (!s.body.startsWith("8;") || CONTROL.test(s.body)) return false;
	return s.body.indexOf(";", 2) !== -1;
}

function scanOsc(line: string, start: number, escaped: boolean): Sequence {
	const s = scanString(line, start, true);
	if (!escaped || !isKeptHyperlink(s)) return { end: s.end };
	return { end: s.end, keep: `${ESC}]${s.body}${s.terminator === "bel" ? BEL : ST}` };
}

/** Generic escape: intermediate bytes (0x20-0x2f), then an optional final byte. */
function scanTwoByte(line: string, start: number): number {
	let end = start;
	while (end < line.length && line.charCodeAt(end) >= 0x20 && line.charCodeAt(end) <= 0x2f) end++;
	if (end < line.length && isEscFinal(line.charCodeAt(end))) end++;
	return end;
}

/** `next` is the index just after ESC. */
function escapeSequence(line: string, next: number): Sequence {
	const ch = line[next];
	if (ch === "[") return scanCsi(line, next + 1, true);
	if (ch === "]") return scanOsc(line, next + 1, true);
	if (ch === "P" || ch === "X" || ch === "^" || ch === "_") return { end: scanString(line, next + 1, false).end };
	return { end: scanTwoByte(line, next) };
}

/** A recognized escape sequence starting at `i`, or `undefined` when `line[i]` is plain text. */
function sequenceAt(line: string, i: number): Sequence | undefined {
	const ch = line[i];
	if (ch === ESC) return escapeSequence(line, i + 1);
	if (ch === C1_CSI) return scanCsi(line, i + 1, false);
	if (ch === C1_OSC) return scanOsc(line, i + 1, false);
	if (C1_STRING_STARTS.has(ch)) return { end: scanString(line, i + 1, false).end };
	return undefined;
}

function plainChar(ch: string): string {
	if (ch === "\t") return " ";
	return CONTROL.test(ch) ? "" : ch;
}

/** Keeps SGR and OSC 8 from a rendered row; drops other escapes and controls, turns tab into a space. */
export function sanitizeFrameLine(line: string): string {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const seq = sequenceAt(line, i);
		if (seq) {
			out += seq.keep ?? "";
			i = seq.end;
		} else {
			out += plainChar(line[i]);
			i += 1;
		}
	}
	return out;
}

const SGR_MOUSE_REPORT = /\x1b\[<([0-9]+);[0-9]+;[0-9]+[Mm]/g;
const PARTIAL_MOUSE_REPORT = /\x1b(?:\[(?:<[0-9;]*)?)?$/;

function wheelEvent(button: string): InputEvent | undefined {
	if (button === String(WHEEL_UP_BUTTON)) return { type: "wheel", delta: -WHEEL_LINES };
	if (button === String(WHEEL_DOWN_BUTTON)) return { type: "wheel", delta: WHEEL_LINES };
	return undefined;
}

function pushInput(events: InputEvent[], data: string): void {
	if (data !== "") events.push({ type: "input", data });
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

/** Frames viewer stdin: wheel reports and other mouse reports are split out of plain input. */
export class InputFramer {
	private pending = "";

	push(chunk: string): InputEvent[] {
		const text = this.pending + chunk;
		this.pending = "";
		const partial = PARTIAL_MOUSE_REPORT.exec(text);
		if (partial && partial.index + partial[0].length === text.length && partial[0].length <= MAX_MOUSE_PENDING) {
			this.pending = partial[0];
			return eventsOf(text.slice(0, partial.index));
		}
		return eventsOf(text);
	}
}
