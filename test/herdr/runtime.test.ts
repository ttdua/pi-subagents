import { describe, expect, it } from "vitest";
import { viewerRuntime } from "#src/herdr/runtime";

describe("viewerRuntime", () => {
	it("uses Bun's own binary", () => {
		expect(viewerRuntime({ execPath: "/x/bun", versions: { bun: "1.4", node: "24.3.0" } })).toEqual(["/x/bun"]);
	});

	it("uses Node 22.18 or later directly", () => {
		expect(viewerRuntime({ execPath: "/x/node", versions: { node: "22.18.0" } })).toEqual(["/x/node"]);
		expect(viewerRuntime({ execPath: "/x/node", versions: { node: "24.0.1" } })).toEqual(["/x/node"]);
	});

	it("falls back to node on PATH for Node before 22.18", () => {
		expect(viewerRuntime({ execPath: "/x/node", versions: { node: "22.17.9" } })).toEqual(["node"]);
		expect(viewerRuntime({ execPath: "/x/node", versions: { node: "20.11.0" } })).toEqual(["node"]);
	});

	it("falls back when the Node version is unknown", () => {
		expect(viewerRuntime({ execPath: "/x/node", versions: {} })).toEqual(["node"]);
	});

	it("falls back for a compiled single binary", () => {
		expect(viewerRuntime({ execPath: "/x/pi", versions: { bun: "1.4" } })).toEqual(["node"]);
		expect(viewerRuntime({ execPath: "/x/pi", versions: { node: "24.0.0" } })).toEqual(["node"]);
	});

	it("reads the current process by default", () => {
		expect(viewerRuntime().length).toBe(1);
	});
});
