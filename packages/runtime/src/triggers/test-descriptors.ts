import type { z } from "@workflow-engine/core";
import type { TriggerDescriptor } from "../executor/types.js";
import { rehydrateSchemaForTests } from "../workflow-registry.js";

// Test-only helper. Augments a hand-crafted (sentinel-resolved) descriptor
// stub with the pre-rehydrated Zod schemas the production registry attaches
// at registration time. Test files that build descriptors inline pipe them
// through this helper so they satisfy `TriggerDescriptor`'s type contract
// without each test re-implementing rehydration. Uses the same
// `strip`-marker-aware rehydration the production registry uses, so test
// fixtures with `strip: true` markers behave identically to production.
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
		zodInputSchema: rehydrateSchemaForTests(descriptor.inputSchema),
		zodOutputSchema: rehydrateSchemaForTests(descriptor.outputSchema),
	};
}

export { withZodSchemas };
