// Static public index served at `GET /llms.txt` — the one thing an agent handed
// only this domain (with no session) can read to discover how to author and
// deploy workflows. It is a FIXED constant: it reflects no request input, reads
// no owner/repo param, touches no tenant data, and reads no auth header, which
// keeps it in the `None / Intentional / Must stay non-sensitive` route class
// (SECURITY.md §4). The docs themselves are version-matched and live in the SDK
// npm package, not here — this only points at them.

const LLMS_TXT_BODY = `# workflow-engine — LLM docs index

workflow-engine lets you author workflows as TypeScript (triggers wired to
actions via direct typed function calls) using \`@workflow-engine/sdk\`, and
deploy them with the bundled \`wfe\` CLI.

## Where the real docs are (version-matched to the SDK)

If you have already installed the SDK, PREFER your local copy — it exactly
matches the version you are building against:

- \`node_modules/@workflow-engine/sdk/README.md\` — bootstrapping, build, deploy.
- \`node_modules/@workflow-engine/sdk/example.ts\` — the full-surface, commented
  reference workflow (every trigger kind, action composition, env/secret,
  queues, SQL, mail, and the sandbox-stdlib globals).

Otherwise read them over HTTP at the latest published version:

- https://unpkg.com/@workflow-engine/sdk@latest/README.md
- https://unpkg.com/@workflow-engine/sdk@latest/example.ts

## Getting started

1. \`npm install @workflow-engine/sdk\`
2. Read \`example.ts\` (above) and copy the patterns you need into \`src/*.ts\`.
3. \`wfe build\` to typecheck + bundle; \`wfe upload\` to deploy. See the README
   for auth and CI-deploy details.

Note: \`wfe build\` enforces its own strict TypeScript options and ignores your
\`tsconfig.json\`, so validate with \`wfe build\`, not just your editor.
`;

const LLMS_TXT_CONTENT_TYPE = "text/markdown; charset=utf-8";

export { LLMS_TXT_BODY, LLMS_TXT_CONTENT_TYPE };
