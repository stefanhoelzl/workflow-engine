import { createHash, randomBytes } from "node:crypto";
import { describe, expect, test } from "@workflow-engine/tests";

// Test #1 — sealed secret round-trip + log redaction. The workflow declares
// `API_KEY` via `env({secret: true})`, which the SDK routes to
// manifest.secretBindings. The framework's `buildEnv` carries the plaintext;
// `bundle()` fetches the runtime's pubkey and seals via `crypto_box_seal`
// before upload. The runtime decrypts at invocation, so the handler's
// `workflow.env.API_KEY` is the plaintext.
//
// Two assertions:
//   1. Positive — the handler hashes the plaintext (SHA-256) and returns
//      the hex digest. The test recomputes the same digest and asserts
//      equality. The hash is a proof-of-decryption that is NOT itself a
//      sealed-secret plaintext, so the runtime's scrubber doesn't substitute
//      it — confirming sealing/decryption round-tripped to the exact bytes.
//      (Echoing the plaintext directly would round-trip as "[secret]" because
//      the secrets plugin walks every outbound WorkerToMain string and
//      replaces sealed plaintexts — which is the whole point.)
//   2. Negative — `state.logs` (auto-scoped to lines emitted during this
//      test, so prior tests in the same describe can't pollute) does not
//      contain the plaintext.
//
// The plaintext is freshly randomized at module load: each `pnpm test:e2e`
// run produces a distinct value, so even if the negative assertion ever
// regressed against a stale string the next run would re-arm it.

const API_KEY_PLAINTEXT = randomBytes(32).toString("hex");
const EXPECTED_HASH = createHash("sha256")
	.update(API_KEY_PLAINTEXT)
	.digest("hex");

describe("sealed secret echo + log redaction", {
	buildEnv: { API_KEY: API_KEY_PLAINTEXT },
}, () => {
	test("plaintext round-trips through seal/decrypt and never lands in logs", (s) =>
		s
			.workflow(
				"sealedwf",
				`
import {defineWorkflow, env, httpTrigger, z} from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
	env: {
		API_KEY: env({secret: true}),
	},
});

export const echo = httpTrigger({
	body: z.object({}),
	responseBody: z.object({hash: z.string()}),
	handler: async () => {
		const enc = new TextEncoder().encode(workflow.env.API_KEY);
		const buf = await crypto.subtle.digest("SHA-256", enc);
		const hex = Array.from(new Uint8Array(buf))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return {body: {hash: hex}};
	},
});
`,
			)
			.webhook("echo", { body: {} })
			.expect((state) => {
				expect(state.responses).toHaveLength(1);
				expect(state.responses.byIndex(0)).toMatchObject({
					status: 200,
					body: { hash: EXPECTED_HASH },
				});
				for (const line of state.logs) {
					expect(JSON.stringify(line)).not.toContain(API_KEY_PLAINTEXT);
				}
			}));
});
