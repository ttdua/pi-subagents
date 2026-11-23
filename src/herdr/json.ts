/**
 * json.ts — Defensive JSON narrowing for `hc` and `herdr-app` output.
 *
 * Herdr output is external data: every value is narrowed before use.
 */

import { debugLog } from "#src/debug";

/** Returns `undefined` for text that is not valid JSON, so callers treat it as malformed output. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (err) {
		debugLog("herdr output is not valid JSON", err);
		return undefined;
	}
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
	return v as Record<string, unknown>;
}

export function asArray(v: unknown): unknown[] {
	return Array.isArray(v) ? v : [];
}

export function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}
