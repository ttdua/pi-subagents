import { describe, expect, it } from "vitest";
import {
	chunkInput,
	encodeMessage,
	InputFramer,
	MAX_INPUT_DATA,
	MessageSplitter,
	parsePiMessage,
	parseViewerMessage,
	sanitizeFrameLine,
	type ViewerMessage,
} from "#src/herdr/frame-protocol";

const wire = (line: string) => line.replace(/\n$/, "");

describe("frame protocol", () => {
	it("round-trips every message type", () => {
		const viewerMessages: ViewerMessage[] = [
			{ type: "hello", key: "k", cols: 80, rows: 24 },
			{ type: "resize", cols: 120, rows: 40 },
			{ type: "input", data: "\x1b[A" },
			{ type: "wheel", delta: -3 },
		];
		for (const message of viewerMessages) {
			expect(parseViewerMessage(wire(encodeMessage(message)))).toEqual(message);
		}
		const frame = { type: "frame" as const, lines: ["one", "\x1b[1mtwo\x1b[22m"] };
		expect(parsePiMessage(wire(encodeMessage(frame)))).toEqual(frame);
	});

	it("rejects malformed and out-of-bounds lines", () => {
		const rejected = [
			{ type: "hello", key: "k", cols: 0, rows: 5 },
			{ type: "hello", key: "k", cols: 1001, rows: 5 },
			{ type: "hello", key: "", cols: 80, rows: 24 },
			{ type: "resize", cols: 80, rows: 1.5 },
			{ type: "wheel", delta: Number.NaN },
			{ type: "input", data: "x".repeat(MAX_INPUT_DATA + 1) },
		];
		for (const message of rejected) {
			expect(parseViewerMessage(JSON.stringify(message))).toBeUndefined();
		}
		expect(parseViewerMessage("{")).toBeUndefined();
		expect(parseViewerMessage(JSON.stringify({ type: "frame", lines: [1] }))).toBeUndefined();
		expect(parsePiMessage(JSON.stringify({ type: "frame", lines: [1] }))).toBeUndefined();
	});

	it("splits across chunk boundaries", () => {
		const line = JSON.stringify({ type: "input", data: "é\x1b[1m" });
		const bytes = Buffer.from(`${line}\n`);
		const splitter = new MessageSplitter(1024);
		const lines: string[] = [];
		for (const byte of bytes) {
			lines.push(...splitter.push(Buffer.from([byte])).lines);
		}
		expect(lines).toEqual([line]);
	});

	it("reports overflow past the line cap", () => {
		expect(new MessageSplitter(8).push("123456789")).toEqual({ lines: [], overflow: true });
	});

	it("keeps SGR and OSC 8, drops other sequences", () => {
		const input =
			"\x1b[1mA\x1b[22m\x1b]8;;https://x\x1b\\L\x1b]8;;\x1b\\\x1b[2J\x1b[H\x1b]0;t\x07\x1bP1$r\x1b\\\x9b31m\x07\x00B";
		expect(sanitizeFrameLine(input)).toBe("\x1b[1mA\x1b[22m\x1b]8;;https://x\x1b\\L\x1b]8;;\x1b\\B");
	});

	it("turns tab into a space", () => {
		expect(sanitizeFrameLine("a\tb")).toBe("a b");
	});

	it("drops an OSC 8 whose hyperlink contains a newline", () => {
		expect(sanitizeFrameLine("\x1b]8;;a\nb\x07X")).toBe("X");
	});

	it("drops an OSC 8 whose hyperlink contains a tab", () => {
		expect(sanitizeFrameLine("\x1b]8;;u\tv\x07x")).toBe("x");
	});

	it("drops an OSC 8 terminated by C1 ST and the C1 CSI after it", () => {
		expect(sanitizeFrameLine("\x1b]8;;u\x9c\x9b2J\x07")).toBe("");
	});

	it("drops C1 CSI, OSC and DCS inside an OSC 8 hyperlink", () => {
		expect(sanitizeFrameLine("\x1b]8;;u\x9b31m\x07L")).toBe("L");
		expect(sanitizeFrameLine("\x1b]8;;u\x9d0;t\x07L")).toBe("L");
		expect(sanitizeFrameLine("\x1b]8;;u\x1bP1$r\x1b\\L\x07")).toBe("L");
	});

	it("drops a DCS payload containing BEL, which only ends OSC", () => {
		expect(sanitizeFrameLine("\x1bPprivate\x07LEAK\x1b\\X")).toBe("X");
	});

	it("drops SOS, PM and APC payloads containing BEL before ST", () => {
		expect(sanitizeFrameLine("\x1bXa\x07b\x1b\\X")).toBe("X");
		expect(sanitizeFrameLine("\x1b^a\x07b\x1b\\X")).toBe("X");
		expect(sanitizeFrameLine("\x1b_a\x07b\x1b\\X")).toBe("X");
	});

	it("drops C1-prefixed DCS, SOS, PM and APC payloads containing BEL before C1 ST", () => {
		expect(sanitizeFrameLine("\x90a\x07b\x9cX")).toBe("X");
		expect(sanitizeFrameLine("\x98a\x07b\x9cX")).toBe("X");
		expect(sanitizeFrameLine("\x9ea\x07b\x9cX")).toBe("X");
		expect(sanitizeFrameLine("\x9fa\x07b\x9cX")).toBe("X");
	});

	it("drops an unterminated DCS payload to the end of the line", () => {
		expect(sanitizeFrameLine("A\x1bPsecret\x07more")).toBe("A");
	});

	it("drops a two-byte ESC final in 0x30-0x3f such as ESC 7 and ESC 8", () => {
		expect(sanitizeFrameLine("\x1b7X")).toBe("X");
		expect(sanitizeFrameLine("\x1b8X")).toBe("X");
		expect(sanitizeFrameLine("\x1b=X")).toBe("X");
		expect(sanitizeFrameLine("\x1b>X")).toBe("X");
	});

	it("drops an ESC intermediate and its final byte, such as ESC ( B", () => {
		expect(sanitizeFrameLine("\x1b(BX")).toBe("X");
	});

	it("drops an OSC 8 ended by C1 ST, keeping the SGR before it", () => {
		expect(sanitizeFrameLine("\x1b[1mA\x1b]8;;u\x9cZ")).toBe("\x1b[1mAZ");
	});

	it("frames a wheel report split at every point", () => {
		const report = "a\x1b[<64;3;4Mb";
		for (let split = 0; split <= report.length; split++) {
			const framer = new InputFramer();
			const out = [...framer.push(report.slice(0, split)), ...framer.push(report.slice(split))];
			expect(out).toEqual([
				{ type: "input", data: "a" },
				{ type: "wheel", delta: -3 },
				{ type: "input", data: "b" },
			]);
		}
	});

	it("keeps a partial report followed by a newline or CRLF intact", () => {
		const cases = ["\x1b\n", "\x1b\r\nq", "\x1b[<0;3\n", "\x1b[<0;3;4\r\n"];
		for (const text of cases) {
			for (let split = 0; split <= text.length; split++) {
				const framer = new InputFramer();
				const events = [...framer.push(text.slice(0, split)), ...framer.push(text.slice(split))];
				expect(events.map((e) => (e.type === "input" ? e.data : "")).join("")).toBe(text);
			}
		}
	});

	it("drops non-wheel mouse reports", () => {
		expect(new InputFramer().push("\x1b[<0;3;4M\x1b[<0;3;4m")).toEqual([]);
	});

	it("passes a long unterminated report through as input", () => {
		const report = `\x1b[<${"9".repeat(40)}`;
		expect(new InputFramer().push(report)).toEqual([{ type: "input", data: report }]);
	});

	it("splits a line of blank messages without dropping the empty lines", () => {
		const splitter = new MessageSplitter(1024);
		expect(splitter.push("\n")).toEqual({ lines: [""], overflow: false });
		expect(splitter.push("{}\n\n{}\n")).toEqual({ lines: ["{}", "", "{}"], overflow: false });
	});

	it("rejects chunkInput sizes that cannot make progress", () => {
		expect(() => chunkInput("a", 0)).toThrow(RangeError);
		expect(() => chunkInput("a", -1)).toThrow(RangeError);
		expect(() => chunkInput("a", 1.5)).toThrow(RangeError);
		expect(() => chunkInput("😀", 1)).toThrow(RangeError);
	});

	it("keeps astral characters whole at max = 2", () => {
		expect(chunkInput("a😀b😀", 2)).toEqual(["a", "😀", "b", "😀"]);
	});

	it("chunks input at the cap without splitting a surrogate pair", () => {
		expect(chunkInput(`${"a".repeat(4095)}😀b`)).toEqual(["a".repeat(4095), "😀b"]);
		for (const piece of chunkInput("x".repeat(10_000))) {
			expect(piece.length).toBeLessThanOrEqual(MAX_INPUT_DATA);
		}
	});
});
