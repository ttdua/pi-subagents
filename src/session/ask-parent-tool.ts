/**
 * ask-parent-tool.ts — The tool a child asks its delegating agent a question with.
 *
 * A child that cannot finish without information only its parent has records
 * the question here and ends its turn. The parent answers by resuming the
 * child, which continues with its context intact.
 *
 * The tool records; it does not announce. Every result carrier already renders
 * a pending question — with the exact resume call while the record is still
 * resumable, and why it is not once `Subagent.resumeRefusal` says otherwise —
 * so announcing here would tell the parent the same thing twice.
 *
 * Lives in `session/` rather than `tools/` because it is installed on the
 * child's session by the assembly factory, where every `tools/` module is
 * registered on the parent's.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { validateQuestion } from "#src/seams/result-schema";
import type { QuestionSchema } from "#src/service/service";

export const ASK_PARENT_TOOL_NAME = "ask_parent";

const RESULT_TEXT =
	"Question recorded for the delegating agent. End your turn now — it will answer by resuming you, and you will continue with your context intact.";

/** A question a child asked: its text, and the validated fields when the launch has a `questionSchema`. */
export interface AskedQuestion {
	readonly text: string;
	readonly fields?: unknown;
}

/** Records a child's question against its own subagent record. */
export type QuestionRecorder = (question: AskedQuestion) => void;

interface AskParentOutput {
	content: { type: "text"; text: string }[];
	details: undefined;
	isError?: boolean;
}

function refusal(lines: string): AskParentOutput {
	return {
		content: [
			{
				type: "text" as const,
				text: `The question does not match the required schema:\n${lines}\nFix it and call ask_parent again.`,
			},
		],
		details: undefined,
		isError: true,
	};
}

export class AskParentTool {
	constructor(
		private readonly record: QuestionRecorder,
		private readonly schema?: QuestionSchema,
	) {}

	execute(
		_toolCallId: string,
		params: Record<string, unknown>,
		_signal: AbortSignal,
		_onUpdate: unknown,
		_ctx: unknown,
	): AskParentOutput {
		const { question, ...rest } = params;
		if (typeof question !== "string") return refusal("- question: must be a string");
		if (this.schema) {
			const violations = validateQuestion(this.schema, rest);
			if (violations.length > 0) {
				return refusal(violations.map((violation) => `- ${violation.path}: ${violation.message}`).join("\n"));
			}
			this.record({ text: question, fields: structuredClone(rest) });
		} else {
			this.record({ text: question });
		}
		// `details` is required by the SDK's result type; this tool renders none.
		return { content: [{ type: "text" as const, text: RESULT_TEXT }], details: undefined };
	}

	/** Today's parameters without a schema; with one, `question` plus the schema's own properties. */
	private parameters(): TSchema {
		const questionProperty = Type.String({
			description: "The question the delegating agent must answer before you can continue.",
		});
		const schema = this.schema;
		if (!schema) return Type.Object({ question: questionProperty });
		const parameters: Record<string, unknown> = {
			type: "object",
			properties: { question: questionProperty, ...schema.properties },
			required: ["question", ...(schema.required ?? [])],
		};
		if (schema.additionalProperties !== undefined) parameters.additionalProperties = schema.additionalProperties;
		// The caller's schema is the validated JSON Schema subset, which is what the tool-parameter type carries.
		return parameters as unknown as TSchema;
	}

	toToolDefinition() {
		return defineTool({
			name: ASK_PARENT_TOOL_NAME,
			label: "Ask Parent",
			promptSnippet: "Ask the delegating agent a question, then end your turn.",
			description:
				"Record a question for the agent that delegated this task. Use it when you cannot finish " +
				"without information only the delegating agent has, and the answer changes what you would do; " +
				"otherwise state your assumption and continue. After calling this, end your turn immediately — " +
				"the delegating agent answers by resuming you, and you continue with your context intact.",
			parameters: this.parameters(),
			// The tool's own work is synchronous; the SDK's execute contract is not.
			execute: (
				toolCallId: string,
				params: Record<string, unknown>,
				signal: AbortSignal,
				onUpdate: unknown,
				ctx: unknown,
			) => Promise.resolve(this.execute(toolCallId, params, signal, onUpdate, ctx)),
		});
	}
}
