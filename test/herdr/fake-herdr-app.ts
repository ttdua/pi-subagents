/**
 * fake-herdr-app.ts — A `FakeHerdrCli` whose `herdr-app` replies follow a
 * mutable pane model: status, ls, keep, park, focus and peek.
 */

import type { HerdrResult } from "#src/herdr/cli";
import { FakeHerdrCli } from "./fake-cli";

export interface FakePane {
	terminal: string;
	pane: string;
}

export class FakeHerdrApp {
	readonly cli = new FakeHerdrCli();
	panes: FakePane[] = [{ terminal: "t3s", pane: "p1" }];
	focused = "p1";
	keepFails = false;
	/** Number of `terminal.keep` calls that answer "no running terminal" (exit 1) before one succeeds. */
	keepUnknownTimes = 0;
	parkFails = false;
	/** Number of `terminal.peek` calls that answer with an error before one succeeds. */
	peekErrors = 0;

	constructor() {
		this.cli.reply(["status"], () => ok({ space: "sp1", tab: "tb1", focused_pane: this.focused }));
		this.cli.reply(["ls"], () =>
			ok({ spaces: [{ id: "sp1", tabs: [{ id: "tb1", terminals: this.panes.map((p) => ({ ...p })) }] }] }),
		);
		this.cli.reply(["do", "pane.focus"], (args) => {
			this.focused = args[3] ?? this.focused;
			return ok({ ok: true });
		});
		this.cli.reply(["do", "terminal.keep"], (args) => this.keep(args[3] ?? ""));
		this.cli.reply(["do", "terminal.park"], (args) => this.park(args[3] ?? ""));
		this.cli.reply(["do", "terminal.peek"], () => this.peek());
	}

	/** Pane ids in tab order. */
	paneIds(): string[] {
		return this.panes.map((p) => p.pane);
	}

	/** Simulates the user closing a pane. */
	closePane(pane: string): void {
		this.panes = this.panes.filter((p) => p.pane !== pane);
	}

	private keep(terminal: string): HerdrResult {
		if (this.keepFails) return { code: 1, stdout: "" };
		if (this.keepUnknownTimes > 0) {
			this.keepUnknownTimes--;
			return { code: 1, stdout: JSON.stringify({ error: `no running terminal "${terminal}"` }) };
		}
		const pane = terminal.replace(/^t/, "p");
		this.panes.push({ terminal, pane });
		this.focused = pane;
		return ok({ pending: true, terminal, pane, tab: "tb1" });
	}

	private park(terminal: string): HerdrResult {
		if (this.parkFails) return { code: 1, stdout: JSON.stringify({ error: "no such terminal" }) };
		this.panes = this.panes.filter((p) => p.terminal !== terminal);
		return ok({ pending: true, terminal });
	}

	private peek(): HerdrResult {
		if (this.peekErrors > 0) {
			this.peekErrors--;
			return { code: 0, stdout: JSON.stringify({ error: 'no running terminal "t10"' }) };
		}
		return ok({ ok: true });
	}
}

function ok(value: unknown): HerdrResult {
	return { code: 0, stdout: JSON.stringify(value) };
}
