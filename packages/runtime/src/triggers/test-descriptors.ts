import { z } from "@workflow-engine/core";
import type { TriggerDescriptor } from "../executor/types.js";

// Test-only helper. Augments a hand-crafted (sentinel-resolved) descriptor
// stub with the pre-rehydrated Zod schemas the production registry attaches
// at registration time. Test files that build descriptors inline pipe them
// through this helper so they satisfy `TriggerDescriptor`'s type contract
// without each test re-implementing rehydration.
function withZodSchemas<
	D extends Omit<TriggerDescriptor, "zodInputSchema" | "zodOutputSchema">,
>(
	descriptor: D,
): D & {
	zodInputSchema: z.ZodType<unknown>;
	zodOutputSchema: z.ZodType<unknown>;
} {
	return {
		...descriptor,
		zodInputSchema: z.fromJSONSchema(
			descriptor.inputSchema,
		) as z.ZodType<unknown>,
		zodOutputSchema: z.fromJSONSchema(
			descriptor.outputSchema,
		) as z.ZodType<unknown>,
	};
}

export { withZodSchemas };
