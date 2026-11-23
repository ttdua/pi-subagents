/**
 * deferred-source.ts — Holds a transcript source's events until a frame turn.
 *
 * The pane's listener never runs inside a source callback: inner events are
 * queued and delivered by `flush()`, so extension tool renderers only run at the
 * frame turn. An overflowing queue is dropped and reported as a resync request.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "#src/types";
import type { SessionModel, StreamingState, TranscriptSource } from "#src/ui/session-navigation";

export const MAX_QUEUED_EVENTS = 256;

type Listener = (event?: AgentSessionEvent) => void;

export class DeferredSource implements TranscriptSource {
	private readonly listeners = new Set<Listener>();
	private queue: Array<AgentSessionEvent | undefined> = [];
	private overflowed = false;
	private batchOpen = false;
	private inFlight: AgentSessionEvent | undefined;
	private unsubscribeInner: (() => void) | undefined;

	constructor(
		private readonly inner: TranscriptSource,
		private readonly onQueued: () => void,
	) {}

	getMessages() {
		return this.inner.getMessages();
	}
	streaming(): StreamingState | undefined {
		return this.inner.streaming();
	}
	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.inner.getToolDefinition(name);
	}
	sessionModel(): SessionModel {
		return this.inner.sessionModel();
	}

	subscribe(onChange: Listener): () => void {
		this.listeners.add(onChange);
		this.unsubscribeInner ??= this.inner.subscribe((event) => this.receive(event)) ?? (() => {});
		return () => {
			this.listeners.delete(onChange);
		};
	}

	/** Deliver queued events in order, or report that the queue overflowed and was dropped. */
	flush(): { resync: boolean } {
		const queued = this.queue;
		const resync = this.overflowed;
		this.queue = [];
		this.overflowed = false;
		this.batchOpen = false;
		if (resync) return { resync: true };
		for (const event of queued) this.deliver(event);
		return { resync: false };
	}

	/** Deliver the latest in-flight assistant message event, after the caller's resync. */
	redeliverInFlight(): void {
		if (this.inFlight) this.deliver(this.inFlight);
	}

	dispose(): void {
		this.unsubscribeInner?.();
		this.unsubscribeInner = undefined;
		this.listeners.clear();
		this.queue = [];
	}

	private receive(event: AgentSessionEvent | undefined): void {
		this.trackInFlight(event);
		this.enqueue(event);
		if (!this.batchOpen) {
			this.batchOpen = true;
			this.onQueued();
		}
	}

	private trackInFlight(event: AgentSessionEvent | undefined): void {
		if (event === undefined || event.type === "message_end" || event.type === "agent_end") {
			this.inFlight = undefined;
		} else if ((event.type === "message_start" || event.type === "message_update") && event.message.role === "assistant") {
			this.inFlight = event;
		}
	}

	private enqueue(event: AgentSessionEvent | undefined): void {
		if (this.overflowed) return;
		const last = this.queue.at(-1);
		if (event?.type === "message_update" && last?.type === "message_update") {
			this.queue[this.queue.length - 1] = event;
			return;
		}
		this.queue.push(event);
		if (this.queue.length > MAX_QUEUED_EVENTS) {
			this.queue = [];
			this.overflowed = true;
		}
	}

	private deliver(event: AgentSessionEvent | undefined): void {
		for (const listener of [...this.listeners]) listener(event);
	}
}
