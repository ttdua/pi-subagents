/**
 * result-schema.ts — Parsing and validation of the schema subset shared by
 * structured results and question fields.
 *
 * The service parses a caller's schema once at spawn into a frozen deep copy;
 * the child's `submit_result` (or `ask_parent`) validates against that copy only.
 */

import type { QuestionSchema, ResultSchema } from "#src/service/service";

export interface ResultViolation {
	path: string;
	message: string;
}

const TYPE_NAMES = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
] as const;

const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const KNOWN_KEYWORDS = new Set([
	"type",
	"enum",
	"properties",
	"items",
	"required",
	"additionalProperties",
	"title",
	"description",
	"$schema",
]);

const RESERVED_QUESTION_NAME = "question is reserved for the question text";

type Pointer = string;
type SchemaLabel = "resultSchema" | "questionSchema";

/** Per-parse state: the error prefix and the nodes on the current path (cycle guard). */
interface ParseContext {
	readonly label: SchemaLabel;
	readonly ancestors: WeakSet<object>;
}

function newContext(label: SchemaLabel): ParseContext {
	return { label, ancestors: new WeakSet() };
}

function refuse(ctx: ParseContext, pointer: Pointer, message: string): never {
	throw new Error(`${ctx.label} ${pointer || "/"}: ${message}`);
}

function escapeSegment(key: string): string {
	return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
	if (typeof input !== "object" || input === null) return false;
	const proto = Object.getPrototypeOf(input);
	return proto === Object.prototype || proto === null;
}

function hasOwn(object: object, key: string): boolean {
	return Object.hasOwn(object, key);
}

/**
 * Validate and copy a result schema. Returns `undefined` for `undefined`;
 * otherwise a deep-frozen copy sharing no objects with the input.
 */
export function parseResultSchema(input: unknown): ResultSchema | undefined {
	if (input === undefined) return undefined;
	return parseNode(input, "", true, newContext("resultSchema"));
}

/**
 * Validate and copy a question schema: the same subset with a root `type` of
 * `"object"`, and without a `question` property or required member (the
 * question text is passed separately). Returns `undefined` for `undefined`.
 */
export function parseQuestionSchema(
	input: unknown,
): QuestionSchema | undefined {
	if (input === undefined) return undefined;
	const ctx = newContext("questionSchema");
	const parsed = parseNode(input, "", true, ctx) as Record<string, unknown>;
	checkQuestionRoot(parsed, ctx);
	return parsed as QuestionSchema;
}

/** Root checks run on the parsed, frozen copy, never on caller-owned objects. */
function checkQuestionRoot(parsed: Record<string, unknown>, ctx: ParseContext) {
	if (parsed.type !== "object") refuse(ctx, "/type", "type must be object");
	const properties = parsed.properties as object | undefined;
	if (properties && hasOwn(properties, "question")) {
		refuse(ctx, "/properties/question", RESERVED_QUESTION_NAME);
	}
	if (
		Array.isArray(parsed.required) &&
		(parsed.required as string[]).includes("question")
	) {
		refuse(ctx, "/required", RESERVED_QUESTION_NAME);
	}
}

function parseNode(
	input: unknown,
	pointer: Pointer,
	isRoot: boolean,
	ctx: ParseContext,
): ResultSchema {
	if (!isPlainObject(input)) refuse(ctx, pointer, "schema must be a plain object");
	if (ctx.ancestors.has(input)) refuse(ctx, pointer, "schema contains a cycle");

	for (const keyword of Object.keys(input)) {
		if (!KNOWN_KEYWORDS.has(keyword)) {
			const where = `${pointer}/${escapeSegment(keyword)}`;
			refuse(ctx, where, `unsupported keyword "${keyword}" at ${where}`);
		}
	}

	ctx.ancestors.add(input);
	const out: Record<string, unknown> = {};
	if (hasOwn(input, "type") || isRoot) {
		out.type = parseType(input.type, pointer, ctx);
	}
	if (hasOwn(input, "enum")) out.enum = parseEnum(input.enum, pointer, ctx);
	if (hasOwn(input, "properties")) {
		out.properties = parseProperties(input.properties, pointer, ctx);
	}
	if (hasOwn(input, "items")) {
		out.items = parseNode(input.items, `${pointer}/items`, false, ctx);
	}
	if (hasOwn(input, "required")) {
		out.required = parseRequired(input.required, pointer, ctx);
	}
	if (hasOwn(input, "additionalProperties")) {
		out.additionalProperties = parseAdditional(
			input.additionalProperties,
			pointer,
			ctx,
		);
	}
	if (hasOwn(input, "title")) {
		out.title = parseString(input.title, pointer, "title", ctx);
	}
	if (hasOwn(input, "description")) {
		out.description = parseString(input.description, pointer, "description", ctx);
	}
	if (hasOwn(input, "$schema")) {
		out.$schema = parseDraft(input.$schema, pointer, ctx);
	}
	ctx.ancestors.delete(input);

	return Object.freeze(out) as ResultSchema;
}

function parseType(value: unknown, pointer: Pointer, ctx: ParseContext): string {
	if (!TYPE_NAMES.includes(value as (typeof TYPE_NAMES)[number])) {
		refuse(ctx, `${pointer}/type`, `type must be one of ${TYPE_NAMES.join(", ")}`);
	}
	return value as string;
}

function parseEnum(
	value: unknown,
	pointer: Pointer,
	ctx: ParseContext,
): readonly (string | number | boolean)[] {
	const where = `${pointer}/enum`;
	if (!Array.isArray(value)) refuse(ctx, where, "enum must be an array");
	if (value.length === 0) refuse(ctx, where, "enum must not be empty");
	for (const member of value) {
		const scalar =
			typeof member === "string" ||
			typeof member === "boolean" ||
			(typeof member === "number" && Number.isFinite(member));
		if (!scalar) {
			refuse(ctx, where, "enum members must be strings, numbers or booleans");
		}
	}
	return Object.freeze([...value]) as readonly (string | number | boolean)[];
}

function parseProperties(
	value: unknown,
	pointer: Pointer,
	ctx: ParseContext,
): Readonly<Record<string, ResultSchema>> {
	const where = `${pointer}/properties`;
	if (!isPlainObject(value)) refuse(ctx, where, "properties must be a plain object");
	const out: Record<string, ResultSchema> = Object.create(null);
	for (const key of Object.keys(value)) {
		out[key] = parseNode(value[key], `${where}/${escapeSegment(key)}`, false, ctx);
	}
	return Object.freeze(out);
}

function parseRequired(
	value: unknown,
	pointer: Pointer,
	ctx: ParseContext,
): readonly string[] {
	const where = `${pointer}/required`;
	if (!Array.isArray(value)) refuse(ctx, where, "required must be an array");
	const seen = new Set<string>();
	for (const name of value) {
		if (typeof name !== "string") {
			refuse(ctx, where, "required members must be strings");
		}
		if (seen.has(name)) refuse(ctx, where, `required names "${name}" twice`);
		seen.add(name);
	}
	return Object.freeze([...value]) as readonly string[];
}

function parseAdditional(
	value: unknown,
	pointer: Pointer,
	ctx: ParseContext,
): boolean | ResultSchema {
	const where = `${pointer}/additionalProperties`;
	if (typeof value === "boolean") return value;
	if (isPlainObject(value)) return parseNode(value, where, false, ctx);
	return refuse(ctx, where, "additionalProperties must be a boolean or a schema");
}

function parseString(
	value: unknown,
	pointer: Pointer,
	keyword: string,
	ctx: ParseContext,
): string {
	if (typeof value !== "string") {
		refuse(ctx, `${pointer}/${keyword}`, `${keyword} must be a string`);
	}
	return value;
}

function parseDraft(
	value: unknown,
	pointer: Pointer,
	ctx: ParseContext,
): typeof DRAFT_2020_12 {
	if (value !== DRAFT_2020_12) {
		refuse(ctx, `${pointer}/$schema`, `$schema must be ${DRAFT_2020_12}`);
	}
	return DRAFT_2020_12;
}

export function validateResult(
	schema: ResultSchema,
	value: unknown,
): ResultViolation[] {
	const violations: ResultViolation[] = [];
	checkNode(schema, value, "result", violations);
	return violations;
}

/**
 * Validate the fields of an `ask_parent` call against a question schema.
 * Paths name the property (`topic`, `topic.0`); a violation of the root
 * itself is reported at `(fields)`.
 */
export function validateQuestion(
	schema: QuestionSchema,
	fields: Record<string, unknown>,
): ResultViolation[] {
	const violations: ResultViolation[] = [];
	checkNode(schema, fields, "", violations);
	return violations;
}

function joinPath(parent: string, key: string): string {
	return parent === "" ? key : `${parent}.${key}`;
}

function pushViolation(
	out: ResultViolation[],
	path: string,
	message: string,
): void {
	out.push({ path: path === "" ? "(fields)" : path, message });
}

function checkNode(
	schema: ResultSchema,
	value: unknown,
	path: string,
	out: ResultViolation[],
): void {
	if (schema.type !== undefined && !matchesType(schema.type, value)) {
		pushViolation(out, path, `must be of type ${schema.type}`);
	}
	if (schema.enum !== undefined && !schema.enum.includes(value as never)) {
		const allowed = schema.enum
			.map((member) => JSON.stringify(member))
			.join(", ");
		pushViolation(out, path, `must be one of ${allowed}`);
	}
	if (isPlainObject(value)) checkObject(schema, value, path, out);
	if (Array.isArray(value) && schema.items !== undefined) {
		value.forEach((item, index) => {
			checkNode(schema.items as ResultSchema, item, joinPath(path, String(index)), out);
		});
	}
}

function checkObject(
	schema: ResultSchema,
	value: Record<string, unknown>,
	path: string,
	out: ResultViolation[],
): void {
	for (const name of schema.required ?? []) {
		if (!hasOwn(value, name)) {
			pushViolation(out, joinPath(path, name), "is required");
		}
	}
	const properties = schema.properties ?? {};
	for (const key of Object.keys(properties)) {
		if (hasOwn(value, key)) {
			checkNode(properties[key] as ResultSchema, value[key], joinPath(path, key), out);
		}
	}
	for (const key of Object.keys(value)) {
		if (!hasOwn(properties, key)) {
			checkExtra(schema, value[key], joinPath(path, key), out);
		}
	}
}

function checkExtra(
	schema: ResultSchema,
	value: unknown,
	path: string,
	out: ResultViolation[],
): void {
	const additional = schema.additionalProperties;
	if (additional === false) {
		pushViolation(out, path, "is not allowed");
	} else if (additional !== undefined && additional !== true) {
		checkNode(additional, value, path, out);
	}
}

function matchesType(type: string, value: unknown): boolean {
	switch (type) {
		case "object":
			return isPlainObject(value);
		case "array":
			return Array.isArray(value);
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		default:
			return false;
	}
}
