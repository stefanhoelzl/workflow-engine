import Ajv2020 from "ajv/dist/2020.js";
// biome-ignore lint/style/noExportedImports: z is re-exported for consumers alongside locally defined exports
import { z } from "zod";

// ---------------------------------------------------------------------------
// HTTP trigger result
// ---------------------------------------------------------------------------

interface HttpTriggerResult {
	status?: number;
	body?: unknown;
	headers?: Record<string, string>;
}

interface HttpTriggerPayload<
	Body = unknown,
	Params extends Record<string, string> = Record<string, string>,
	Query extends Record<string, unknown> = Record<string, never>,
> {
	body: Body;
	headers: Record<string, string>;
	url: string;
	method: string;
	params: Params;
	query: Query;
}

// ---------------------------------------------------------------------------
// Manifest schema (v1)
// ---------------------------------------------------------------------------

const ajv = new Ajv2020.default();
// biome-ignore lint/style/noNonNullAssertion: meta-schema is always available in Ajv2020
const validateJsonSchema = ajv.getSchema(
	"https://json-schema.org/draft/2020-12/schema",
)!;

const jsonSchemaValidator = z.custom<Record<string, unknown>>((val) =>
	validateJsonSchema(val),
);

const actionManifestSchema = z.object({
	name: z.string(),
	input: jsonSchemaValidator,
	output: jsonSchemaValidator,
});

const httpTriggerManifestSchema = z.object({
	name: z.string(),
	type: z.literal("http"),
	path: z.string(),
	method: z.string(),
	body: jsonSchemaValidator,
	params: z.array(z.string()),
	query: z.exactOptional(jsonSchemaValidator),
	schema: jsonSchemaValidator,
});

const triggerManifestSchema = z.discriminatedUnion("type", [
	httpTriggerManifestSchema,
]);

const ManifestSchema = z.object({
	name: z.string(),
	module: z.string(),
	env: z.record(z.string(), z.string()),
	actions: z.array(actionManifestSchema),
	triggers: z.array(triggerManifestSchema),
});

type Manifest = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export type { HttpTriggerPayload, HttpTriggerResult, Manifest };
export { ManifestSchema, z };
