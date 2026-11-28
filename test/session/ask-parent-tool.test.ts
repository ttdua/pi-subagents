import { describe, expect, it, vi } from "vitest";
import type { QuestionSchema } from "#src/service/service";
import { type AskedQuestion, AskParentTool } from "#src/session/ask-parent-tool";
import { STUB_CTX } from "#test/helpers/stub-ctx";

const REF: QuestionSchema = {
	type: "object",
	properties: { topic: { enum: ["fact", "scope", "other"] } },
	required: ["topic"],
	additionalProperties: false,
};

const DESCRIPTION =
	"Record a question for the agent that delegated this task. Use it when you cannot finish " +
	"without information only the delegating agent has, and the answer changes what you would do; " +
	"otherwise state your assumption and continue. After calling this, end your turn immediately — " +
	"the delegating agent answers by resuming you, and you continue with your context intact.";

const RESULT_TEXT =
	"Question recorded for the delegating agent. End your turn now — it will answer by resuming you, and you will continue with your context intact.";

function execute(record: (question: AskedQuestion) => void, question: string) {
	const tool = new AskParentTool(record);
	return tool.execute("tc-1", { question }, new AbortController().signal, undefined, STUB_CTX);
}

function executeWith(schema: QuestionSchema, record: (question: AskedQuestion) => void, params: Record<string, unknown>) {
	const tool = new AskParentTool(record, schema);
	return tool.execute("tc-1", params as { question: string }, new AbortController().signal, undefined, STUB_CTX);
}

function textOf(result: { content: { type: "text"; text: string }[] }): string {
	return result.content[0]?.text ?? "";
}

describe("AskParentTool", () => {
	describe("the definition the child session receives", () => {
		it("is named ask_parent", () => {
			expect(new AskParentTool(vi.fn()).toToolDefinition().name).toBe("ask_parent");
		});

		it("carries a prompt snippet naming the end-your-turn contract", () => {
			expect(new AskParentTool(vi.fn()).toToolDefinition().promptSnippet).toBe(
				"Ask the delegating agent a question, then end your turn.",
			);
		});
	});

	describe("recording a question", () => {
		it("hands the question to the recorder verbatim", () => {
			const record = vi.fn<(question: AskedQuestion) => void>();

			execute(record, "Which of the three config files is authoritative?");

			expect(record).toHaveBeenCalledWith({ text: "Which of the three config files is authoritative?" });
		});

		it("tells the child to end its turn and how the answer arrives", () => {
			const result = execute(vi.fn(), "Which config wins?");

			expect(result.content).toEqual([
				{
					type: "text",
					text:
						"Question recorded for the delegating agent. End your turn now — it will answer by resuming you, and you will continue with your context intact.",
				},
			]);
		});
	});

	describe("with a question schema", () => {
		const parametersOf = (schema: QuestionSchema) =>
			new AskParentTool(vi.fn(), schema).toToolDefinition().parameters as unknown as Record<string, any>;

		it("lists question and the schema properties, requiring both", () => {
			const parameters = parametersOf(REF);

			expect(parameters.properties.question.type).toBe("string");
			expect(parameters.properties.topic.enum).toEqual(["fact", "scope", "other"]);
			expect(parameters.required).toEqual(["question", "topic"]);
			expect(parameters.additionalProperties).toBe(false);
		});

		it("keeps the tool description when the schema has one", () => {
			const definition = new AskParentTool(vi.fn(), { ...REF, description: "X" }).toToolDefinition();

			expect(definition.parameters).not.toHaveProperty("description");
			expect(definition.description).toBe(DESCRIPTION);
		});

		it("records the text and fields for a valid call", () => {
			const record = vi.fn();

			const result = executeWith(REF, record, { question: "Q", topic: "scope" });

			expect(record).toHaveBeenCalledWith({ text: "Q", fields: { topic: "scope" } });
			expect(textOf(result)).toBe(RESULT_TEXT);
		});

		it("hands the recorder a copy of the fields", () => {
			const record = vi.fn();
			const nested = { a: 1 };

			executeWith({ type: "object" }, record, { question: "Q", topic: "scope", nested });

			const recorded = record.mock.calls[0][0] as AskedQuestion;
			expect((recorded.fields as { nested: object }).nested).not.toBe(nested);
		});

		it("sets additionalProperties only when the schema does", () => {
			const parameters = parametersOf({ type: "object", properties: { topic: { type: "string" } } });

			expect("additionalProperties" in parameters).toBe(false);
		});

		it("accepts the catch-all", () => {
			const record = vi.fn();

			executeWith(REF, record, { question: "Q", topic: "other" });

			expect(record).toHaveBeenCalledWith({ text: "Q", fields: { topic: "other" } });
		});

		it("refuses an unknown topic without recording", () => {
			const record = vi.fn();

			const result = executeWith(REF, record, { question: "Q", topic: "unknown" });

			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("topic");
			expect(record).not.toHaveBeenCalled();
		});

		it("refuses a missing topic without recording", () => {
			const record = vi.fn();

			const result = executeWith(REF, record, { question: "Q" });

			expect(result.isError).toBe(true);
			expect(textOf(result)).toContain("topic");
			expect(record).not.toHaveBeenCalled();
		});

		it("refuses a non-string question without recording", () => {
			const record = vi.fn();

			const result = executeWith(REF, record, { question: 1, topic: "fact" });

			expect(result.isError).toBe(true);
			expect(record).not.toHaveBeenCalled();
		});

		it("records {} for a schema without properties", () => {
			const record = vi.fn();

			executeWith({ type: "object" }, record, { question: "Q" });

			expect(record).toHaveBeenCalledWith({ text: "Q", fields: {} });
		});

		it("keeps undeclared fields when additionalProperties is unset", () => {
			const record = vi.fn();

			executeWith({ type: "object" }, record, { question: "Q", extra: 1 });

			expect(record).toHaveBeenCalledWith({ text: "Q", fields: { extra: 1 } });
		});

		it("an invalid call leaves the earlier question in place", () => {
			const record = vi.fn();
			executeWith(REF, record, { question: "Q", topic: "fact" });

			executeWith(REF, record, { question: "Q2", topic: "unknown" });

			expect(record).toHaveBeenCalledTimes(1);
		});

		it("without a schema the definition is unchanged", () => {
			const definition = new AskParentTool(vi.fn()).toToolDefinition();

			expect(JSON.parse(JSON.stringify(definition.parameters))).toEqual({
				type: "object",
				properties: {
					question: {
						description: "The question the delegating agent must answer before you can continue.",
						type: "string",
					},
				},
				required: ["question"],
			});
			expect(definition.description).toBe(DESCRIPTION);
		});
	});
});
