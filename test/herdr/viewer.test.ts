import { describe, expect, it } from "vitest";
import { createExit, enableRawMode, paintFrame, parseArgs, RESTORE } from "#src/herdr/viewer";

describe("parseArgs", () => {
	it("parses the full viewer CLI", () => {
		const argv = ["--socket", "/tmp/s.sock", "--key", "k1", "--pid", "42", "--parent-terminal", "t1"];
		expect(parseArgs(argv)).toEqual({ socket: "/tmp/s.sock", key: "k1", pid: 42, parentTerminal: "t1" });
	});

	it("leaves parentTerminal undefined when absent", () => {
		expect(parseArgs(["--socket", "/s", "--key", "k", "--pid", "1"]).parentTerminal).toBeUndefined();
	});

	it("throws when --socket is missing", () => {
		expect(() => parseArgs(["--key", "k", "--pid", "1"])).toThrow(/--socket/);
	});

	it("throws when --key is missing", () => {
		expect(() => parseArgs(["--socket", "/s", "--pid", "1"])).toThrow(/--key/);
	});

	it("throws when --pid is not a positive integer", () => {
		expect(() => parseArgs(["--socket", "/s", "--key", "k", "--pid", "abc"])).toThrow(/--pid/);
		expect(() => parseArgs(["--socket", "/s", "--key", "k", "--pid", "0"])).toThrow(/--pid/);
	});
});

describe("paintFrame", () => {
	it("wraps rows in a synchronized update with line clears", () => {
		const out = paintFrame(["x", "y"], 5);
		expect(out.startsWith("\x1b[?2026h\x1b[H")).toBe(true);
		expect(out).toContain("x\x1b[K\r\ny\x1b[K");
		expect(out.endsWith("\x1b[J\x1b[?2026l")).toBe(true);
	});

	it("paints a sanitized row verbatim", () => {
		expect(paintFrame(["x"], 2)).toContain("x\x1b[K");
	});

	it("paints at most `rows` rows", () => {
		const out = paintFrame(["a", "b", "c", "d"], 2);
		expect(out).toContain("b\x1b[K");
		expect(out).not.toContain("c\x1b[K");
	});
});

describe("createExit", () => {
	it("exit restores the terminal once", () => {
		const written: string[] = [];
		const raw: boolean[] = [];
		let keepOff = 0;
		const codes: number[] = [];
		const exit = createExit({
			write: (s) => void written.push(s),
			stdin: { isTTY: true, setRawMode: (m) => void raw.push(m) },
			keepOff: () => void keepOff++,
			exit: (c) => void codes.push(c),
		});
		exit();
		exit();
		expect(written).toEqual([RESTORE]);
		expect(raw).toEqual([false]);
		expect(keepOff).toBe(1);
		expect(codes).toEqual([0]);
	});

	it("still exits when setRawMode throws", () => {
		const codes: number[] = [];
		createExit({
			write: () => {},
			stdin: {
				isTTY: true,
				setRawMode: () => {
					throw new Error("EIO");
				},
			},
			keepOff: () => {},
			exit: (c) => void codes.push(c),
		})();
		expect(codes).toEqual([0]);
	});
});

describe("enableRawMode", () => {
	it("sets raw mode on a TTY", () => {
		const calls: boolean[] = [];
		enableRawMode({ isTTY: true, setRawMode: (b: boolean) => void calls.push(b) });
		expect(calls).toEqual([true]);
	});

	it("swallows a setRawMode error", () => {
		expect(() =>
			enableRawMode({
				isTTY: true,
				setRawMode: () => {
					throw new Error("EIO");
				},
			}),
		).not.toThrow();
	});

	it("does nothing without a TTY", () => {
		expect(() => enableRawMode({ isTTY: false, setRawMode: () => { throw new Error("no"); } })).not.toThrow();
	});
});
