import { describe, expect, test } from "@workflow-engine/tests";

// Test #20 — wsTrigger protocol adapter. Verifies the `.ws` chain step opens
// a real WebSocket connection against the spawned runtime, the handler
// receives `{data}`-shaped payloads, and the handler return arrives as a
// reply frame on the same connection (FIFO-correlated by `sock.send`).
// Negative path: a message that doesn't match the trigger's `request` schema
// closes the connection with code 1007.

describe("wsTrigger protocol adapter", () => {
	test("echoes data and returns reply on the same connection", (s) =>
		s
			.workflow(
				"chat",
				`
import {wsTrigger, z} from "@workflow-engine/sdk";

export const echo = wsTrigger({
    request: z.object({greet: z.string()}),
    response: z.object({echo: z.string()}),
    handler: async ({data}) => ({echo: data.greet}),
});
`,
			)
			.ws("echo", { auth: { user: "dev" } }, async (sock) => {
				const reply = (await sock.send({ greet: "hi" })) as {
					echo: string;
				};
				expect(reply).toEqual({ echo: "hi" });
			}));

	test("schema mismatch closes connection with code 1007", (s) =>
		s
			.workflow(
				"strict",
				`
import {wsTrigger, z} from "@workflow-engine/sdk";

export const strict = wsTrigger({
    request: z.object({greet: z.string()}),
    handler: async () => "ok",
});
`,
			)
			.ws("strict", { auth: { user: "dev" } }, async (sock) => {
				sock.sendRaw("not json");
				const closure = await sock.closed;
				expect(closure.code).toBe(1007);
			}));
});
