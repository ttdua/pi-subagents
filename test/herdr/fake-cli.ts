/**
 * fake-cli.ts — In-memory `HerdrCli` for tests: scripted replies by argument
 * prefix, and a record of every call made.
 */

import type { HerdrCli, HerdrCommand, HerdrResult } from "#src/herdr/cli";

export type HerdrReply = HerdrResult | ((args: readonly string[]) => HerdrResult);

export interface HerdrCall {
	command: HerdrCommand;
	args: readonly string[];
}

const UNMATCHED: HerdrResult = { code: 1, stdout: "" };

export class FakeHerdrCli implements HerdrCli {
	readonly calls: HerdrCall[] = [];
	private readonly replies: Array<{ prefix: string[]; reply: HerdrReply }> = [];

	/** Answer calls whose args start with `prefix`; the first matching rule wins. */
	reply(prefix: string[], reply: HerdrReply): void {
		this.replies.push({ prefix, reply });
	}

	run(command: HerdrCommand, args: readonly string[]): Promise<HerdrResult> {
		this.calls.push({ command, args: [...args] });
		const hit = this.replies.find(({ prefix }) => prefix.every((part, i) => args[i] === part));
		if (hit === undefined) return Promise.resolve(UNMATCHED);
		const result = typeof hit.reply === "function" ? hit.reply(args) : hit.reply;
		return Promise.resolve(result);
	}
}
