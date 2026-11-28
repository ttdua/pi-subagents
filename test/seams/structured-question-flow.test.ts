/**
 * Structured question, driven through the real boundaries:
 * `SubagentsServiceAdapter.spawn` → `SubagentManager` → `Subagent.run` →
 * `createSubagentSession` → the installed `ask_parent` tool → lifecycle events
 * and the service snapshot. Only the SDK session factory is faked; the fake
 * child calls the tool definition it was given.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChildLifecyclePublisher } from "#src/lifecycle/child-lifecycle";
import { ConcurrencyLimiter } from "#src/lifecycle/concurrency-limiter";
import { createSubagentSession } from "#src/lifecycle/create-subagent-session";
import type { ParentSnapshot } from "#src/lifecycle/parent-snapshot";
import { SubagentManager } from "#src/lifecycle/subagent-manager";
import { CompositeSubagentObserver } from "#src/observation/composite-subagent-observer";
import { SubagentEventsObserver } from "#src/observation/subagent-events-observer";
import { resetChildSessions } from "#src/seams/child-sessions";
import { AgentTypeCatalog } from "#src/seams/registry";
import type { QuestionSchema } from "#src/service/service";
import { SubagentsServiceAdapter } from "#src/service/service-adapter";
import { resolveModel } from "#src/session/model-resolver";
import { makeAgentConfig } from "#test/helpers/make-agent-config";
import { makeModel } from "#test/helpers/make-model";
import { registryWithGeneral } from "#test/helpers/make-registry";
import { STUB_SNAPSHOT } from "#test/helpers/stub-ctx";
import {
	createFactorySession,
	createSubagentSessionDeps,
	createSubagentSessionIO,
} from "#test/helpers/subagent-session-io";

const MAIN = makeModel({ provider: "fixture", id: "fixture-main" });
const modelRegistry = {
	find: () => undefined,
	getAll: () => [MAIN],
	getAvailable: () => [MAIN],
};
const snapshot: ParentSnapshot = { ...STUB_SNAPSHOT, model: MAIN, modelRegistry };

type Event = { channel: string; data: unknown };
type ToolResult = { content: { text: string }[]; isError?: boolean };
type Tool = {
	name: string;
	parameters?: { properties?: Record<string, unknown> };
	execute(...args: unknown[]): Promise<ToolResult> | ToolResult;
};

let childCounter = 0;
const managers: SubagentManager[] = [];

/** What the fake child does in a turn: `ask` calls the installed `ask_parent` with the full params. */
type ChildScript = (ask: (params: Record<string, unknown>) => Promise<ToolResult>) => Promise<void>;

function harness() {
	const events: Event[] = [];
	const askParameters: string[][] = [];
	const registry = registryWithGeneral(
		() => new Map([["Explore", makeAgentConfig({ name: "Explore", toolNames: ["read"], runInBackground: true })]]),
	);
	const io = createSubagentSessionIO();
	io.createSessionManager.mockImplementation(() => {
		const id = `child-${++childCounter}`;
		return {
			newSession: vi.fn(),
			getSessionFile: vi.fn().mockReturnValue(`/sessions/${id}.jsonl`),
			getSessionId: vi.fn().mockReturnValue(id),
		};
	});
	let script: ChildScript = async () => {};
	io.createSession.mockImplementation(async (opts: { customTools?: Tool[] }) => {
		const session = createFactorySession();
		Object.assign(session, { model: MAIN, thinkingLevel: "off", agent: {} });
		session.prompt.mockImplementation(async () => {
			const askTool = opts.customTools?.find((t) => t.name === "ask_parent");
			if (!askTool) return;
			askParameters.push(Object.keys(askTool.parameters?.properties ?? {}));
			await script(
				async (params) => (await askTool.execute("q", params, undefined, undefined, {})) as ToolResult,
			);
		});
		return { session };
	});
	const emit = (channel: string, data: unknown) => {
		events.push({ channel, data });
	};
	const sessionDeps = {
		...createSubagentSessionDeps({ io, registry, listParentToolNames: () => ["read"] }),
		lifecycle: createChildLifecyclePublisher(emit),
	};
	const manager = new SubagentManager({
		createSubagentSession: (params) => createSubagentSession(params, sessionDeps),
		baseCwd: "/repo",
		observer: new CompositeSubagentObserver([
			new SubagentEventsObserver({
				emit,
				appendEntry: () => undefined,
				notifications: {
					sendCompletion: () => undefined,
					sendUpdate: () => undefined,
					sendWorkspaceNotice: () => undefined,
					dispose: () => undefined,
				},
			}),
		]),
		limiter: new ConcurrencyLimiter(() => 4),
		registry,
		launchContext: {
			listParentTools: () => [{ name: "read", sourceInfo: { source: "local", origin: "top-level" } }],
			excludedPackages: () => [],
		},
	});
	managers.push(manager);
	const runtime = {
		currentCtx: { modelRegistry } as never,
		buildSnapshot: () => snapshot,
		getModelInfo: () => ({ parentModel: MAIN, modelRegistry }),
		getSessionInfo: () => ({ parentSessionFile: "/sessions/p.jsonl", parentSessionId: "p1" }),
	};
	const service = new SubagentsServiceAdapter(manager, resolveModel, runtime, new AgentTypeCatalog(registry));
	return {
		service,
		manager,
		askParameters,
		events: (channel: string) => events.filter((e) => e.channel === channel).map((e) => e.data as Record<string, unknown>),
		record(id: string) {
			const record = service.getRecord(id);
			expect(record, `no record ${id}`).toBeDefined();
			return record as NonNullable<typeof record>;
		},
		/** Spawn (with `schema` when given), let the child run `childScript`, wait for the run. */
		async run(schema: QuestionSchema | undefined, childScript: ChildScript): Promise<string> {
			script = childScript;
			const id = service.spawn("Explore", "go", { foreground: true, questionSchema: schema });
			await manager.getRecord(id)?.promise;
			return id;
		},
		spawnOnly(schema: QuestionSchema, childScript: ChildScript): string {
			script = childScript;
			return service.spawn("Explore", "go", { foreground: true, questionSchema: schema });
		},
		async resume(id: string, childScript: ChildScript): Promise<void> {
			script = childScript;
			await service.resume(id, "go on");
			await manager.getRecord(id)?.promise;
		},
		setScript(childScript: ChildScript) {
			script = childScript;
		},
	};
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((m) => m.dispose()));
	resetChildSessions();
	vi.restoreAllMocks();
});

const SCHEMA: QuestionSchema = {
	type: "object",
	properties: { topic: { enum: ["scope", "fact"] } },
	required: ["topic"],
	additionalProperties: false,
};

describe("Structured question through the service door", () => {
	it("wait resolves with pendingQuestion and structuredQuestion", async () => {
		const h = harness();
		const id = await h.run(SCHEMA, async (ask) => {
			await ask({ question: "Q", topic: "scope" });
		});

		const waited = await h.service.wait(id);
		expect(waited.pendingQuestion).toBe("Q");
		expect(waited.structuredQuestion).toEqual({ topic: "scope" });
		expect(h.record(id).structuredQuestion).toEqual({ topic: "scope" });
		expect(Object.isFrozen(h.record(id).structuredQuestion)).toBe(true);
	});

	it("subagents:asked and subagents:completed carry it", async () => {
		const h = harness();
		await h.run(SCHEMA, async (ask) => {
			await ask({ question: "Q", topic: "scope" });
		});

		expect(h.events("subagents:asked")[0]).toMatchObject({ question: "Q", structuredQuestion: { topic: "scope" } });
		expect(h.events("subagents:completed")[0]).toMatchObject({ structuredQuestion: { topic: "scope" } });
	});

	it("an invalid call records nothing and emits no asked event", async () => {
		const h = harness();
		let reply: ToolResult | undefined;
		const id = await h.run(SCHEMA, async (ask) => {
			reply = await ask({ question: "Q", topic: "unknown" });
		});

		expect(reply?.isError).toBe(true);
		expect(reply?.content[0]?.text).toContain("topic");
		expect(h.record(id)).not.toHaveProperty("pendingQuestion");
		expect(h.record(id)).not.toHaveProperty("structuredQuestion");
		expect(h.events("subagents:asked")).toHaveLength(0);
	});

	it("the child fixes the call", async () => {
		const h = harness();
		const id = await h.run(SCHEMA, async (ask) => {
			await ask({ question: "Q", topic: "unknown" });
			await ask({ question: "Q", topic: "fact" });
		});

		expect(h.record(id).structuredQuestion).toEqual({ topic: "fact" });
		expect(h.events("subagents:asked")).toHaveLength(1);
	});

	it("a later ask replaces the earlier one", async () => {
		const h = harness();
		const id = await h.run(SCHEMA, async (ask) => {
			await ask({ question: "Q1", topic: "scope" });
			await ask({ question: "Q2", topic: "fact" });
		});

		expect(h.record(id).pendingQuestion).toBe("Q2");
		expect(h.record(id).structuredQuestion).toEqual({ topic: "fact" });
	});

	it("validates against the copy taken at spawn", async () => {
		const h = harness();
		const schema = {
			type: "object",
			properties: { topic: { enum: ["scope", "other"] } },
		} as { type: "object"; properties: { topic: { enum: string[] } } };
		let reply: ToolResult | undefined;
		const gate = Promise.withResolvers<void>();
		const id = h.spawnOnly(schema as QuestionSchema, async (ask) => {
			await gate.promise;
			reply = await ask({ question: "Q", topic: "other" });
		});
		schema.properties.topic.enum.splice(1, 1);
		gate.resolve();
		await h.manager.getRecord(id)?.promise;

		expect(reply?.isError).toBeUndefined();
		expect(h.record(id).structuredQuestion).toEqual({ topic: "other" });
	});

	it("resume clears it, and the resumed run can ask again", async () => {
		const h = harness();
		const id = await h.run(SCHEMA, async (ask) => {
			await ask({ question: "Q1", topic: "scope" });
		});
		expect(h.record(id).structuredQuestion).toEqual({ topic: "scope" });

		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		h.setScript(async (ask) => {
			started.resolve();
			await gate.promise;
			await ask({ question: "Q2", topic: "fact" });
		});
		void h.service.resume(id, "go on");
		await started.promise;
		expect(h.record(id)).not.toHaveProperty("structuredQuestion");
		expect(h.record(id)).not.toHaveProperty("pendingQuestion");

		gate.resolve();
		await h.manager.getRecord(id)?.promise;
		expect(h.record(id).pendingQuestion).toBe("Q2");
		expect(h.record(id).structuredQuestion).toEqual({ topic: "fact" });
	});

	it("a launch without questionSchema is unchanged", async () => {
		const h = harness();
		const id = await h.run(undefined, async (ask) => {
			await ask({ question: "Q" });
		});

		expect(h.askParameters[0]).toEqual(["question"]);
		expect(h.record(id).pendingQuestion).toBe("Q");
		expect(h.record(id)).not.toHaveProperty("structuredQuestion");
		expect(h.events("subagents:asked")[0]).not.toHaveProperty("structuredQuestion");
		expect(h.events("subagents:completed")[0]).not.toHaveProperty("structuredQuestion");
	});
});
