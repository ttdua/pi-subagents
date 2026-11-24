/**
 * headless-tui.ts — The minimal TUI surface the transcript pane and Pi's tool
 * components read, without a terminal: dimensions, the render mode and render
 * requests. A viewer's frames are produced from it by `ViewerRenderer`.
 */

import type { TUI } from "@earendil-works/pi-tui";

export class HeadlessTui {
	readonly mode = "regular" as const;
	readonly terminal: { readonly columns: number; readonly rows: number };
	private size = { columns: 80, rows: 24 };

	constructor(private readonly onRender: () => void) {
		const size = () => this.size;
		this.terminal = {
			get columns() {
				return size().columns;
			},
			get rows() {
				return size().rows;
			},
		};
	}

	resize(cols: number, rows: number): void {
		this.size = { columns: cols, rows };
	}

	requestRender(): void {
		this.onRender();
	}

	invalidate(): void {}

	/** The one place the host is typed as Pi's `TUI`; only the members above are ever read. */
	asTui(): TUI {
		return this as unknown as TUI;
	}
}
