import { describe, expect, test } from "@workflow-engine/tests";
import { getMocks } from "@workflow-engine/tests/mocks";

// Test #18 — sendMail happy path + SMTP password log redaction. The
// workflow handler calls `sendMail` against the suite-shared SMTP catcher;
// the recipient carries the test's slug as a plus-address so the catcher
// attributes the captured message to this test. The catcher's
// (per-suite-random) password is declared on the workflow side as
// `env({secret: true})`, sealed at upload time, decrypted at invocation,
// and passed to the mail plugin as `smtp.auth.pass`. The mock accepts the
// connection only when AUTH PLAIN carries that exact password, so the
// captured message is itself the proof that the secret round-tripped end
// to end. The redaction half asserts the same plaintext never lands in
// `state.logs` (auto-scoped to lines emitted during this test only).
//
// Mock SMTP runs on loopback (127.0.0.1), so the mail plugin's net-guard
// would normally reject it. The describe sets
// `WFE_TEST_DISABLE_SSRF_PROTECTION=true` to disable the resolved-IP
// blocklist for this child only — test #17 (SSRF guard) lives in a sibling
// describe without this env, so its loopback-rejection invariant is
// preserved.

const { smtp } = getMocks();
const SLUG = "sendmail-happy";

describe("sendMail happy path + log redaction", {
	env: { WFE_TEST_DISABLE_SSRF_PROTECTION: "true" },
	buildEnv: {
		SMTP_HOST: smtp.host,
		SMTP_PORT: String(smtp.port),
		SMTP_USER: smtp.user,
		SMTP_PASS: smtp.pass,
		SMTP_RCPT: smtp.recipient(SLUG),
	},
}, () => {
	test("sendMail delivers to mock and password never lands in logs", (s) =>
		s
			.workflow(
				"mailer",
				`
import {defineWorkflow, env, httpTrigger, sendMail, z} from "@workflow-engine/sdk";

export const workflow = defineWorkflow({
	env: {
		SMTP_HOST: env({}),
		SMTP_PORT: env({}),
		SMTP_USER: env({}),
		SMTP_PASS: env({secret: true}),
		SMTP_RCPT: env({}),
	},
});

export const send = httpTrigger({
	body: z.object({}),
	handler: async () => {
		await sendMail({
			smtp: {
				host: workflow.env.SMTP_HOST,
				port: Number(workflow.env.SMTP_PORT),
				tls: "plaintext",
				auth: {user: workflow.env.SMTP_USER, pass: workflow.env.SMTP_PASS},
			},
			from: "sender@test",
			to: workflow.env.SMTP_RCPT,
			subject: "hello",
			text: "body",
		});
		return {};
	},
});
`,
			)
			.webhook("send", { body: {} })
			.expect(async (state) => {
				expect(state.responses).toHaveLength(1);
				const captures = await state.smtp.captures({ slug: SLUG });
				expect(captures).toHaveLength(1);
				expect(captures[0]).toMatchObject({
					subject: "hello",
					to: [smtp.recipient(SLUG)],
				});
				for (const line of state.logs) {
					expect(JSON.stringify(line)).not.toContain(smtp.pass);
				}
			}));
});
