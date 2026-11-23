/**
 * detect.ts — Decides whether this session runs inside a Herdr terminal that
 * Herdr shows, and where its column goes.
 */

import type { HerdrCli } from "#src/herdr/cli";
import { asArray, asRecord, asString, parseJson } from "#src/herdr/json";

export interface HerdrContext {
	terminalId: string;
	spaceId: string;
	tabId: string;
	parentPaneId: string;
}

export interface DetectInput {
	mode: string | undefined;
	env: Readonly<Record<string, string | undefined>>;
	cli: HerdrCli;
}

interface TerminalLocation {
	spaceId: string;
	tabId: string;
}

/** Labels from `hc get <terminal> --json`; both Herdr labels must be present. */
async function readLocation(cli: HerdrCli, terminalId: string): Promise<TerminalLocation | undefined> {
	const result = await cli.run("hc", ["get", terminalId, "--json"]);
	if (result.code !== 0) return undefined;
	const labels = asRecord(asRecord(parseJson(result.stdout))?.labels);
	const spaceId = asString(labels?.["herdr.space"]);
	const tabId = asString(labels?.["herdr.tab"]);
	if (spaceId === undefined || tabId === undefined) return undefined;
	return { spaceId, tabId };
}

/** Pane of `terminalId` in the given space and tab, from `herdr-app ls`. */
async function findParentPane(cli: HerdrCli, terminalId: string, location: TerminalLocation): Promise<string | undefined> {
	const result = await cli.run("herdr-app", ["ls"]);
	if (result.code !== 0) return undefined;
	for (const space of asArray(asRecord(parseJson(result.stdout))?.spaces)) {
		if (asString(asRecord(space)?.id) !== location.spaceId) continue;
		for (const tab of asArray(asRecord(space)?.tabs)) {
			if (asString(asRecord(tab)?.id) !== location.tabId) continue;
			const pane = findTerminalPane(asArray(asRecord(tab)?.terminals), terminalId);
			if (pane !== undefined) return pane;
		}
	}
	return undefined;
}

function findTerminalPane(terminals: unknown[], terminalId: string): string | undefined {
	for (const terminal of terminals) {
		const record = asRecord(terminal);
		if (asString(record?.terminal) === terminalId) return asString(record?.pane);
	}
	return undefined;
}

/** Any failed or unexpected check means inactive (`undefined`). */
export async function detectHerdr(input: DetectInput): Promise<HerdrContext | undefined> {
	if (input.mode !== "tui") return undefined;
	const terminalId = input.env.HC_TERMINAL_ID;
	if (terminalId === undefined || terminalId === "") return undefined;

	const location = await readLocation(input.cli, terminalId);
	if (location === undefined) return undefined;

	const parentPaneId = await findParentPane(input.cli, terminalId, location);
	if (parentPaneId === undefined) return undefined;

	return { terminalId, spaceId: location.spaceId, tabId: location.tabId, parentPaneId };
}
