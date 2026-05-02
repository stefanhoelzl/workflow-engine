#!/usr/bin/env tsx
/**
 * Sync GitHub Actions secrets to match the local environment.
 *
 * Workflow:
 *   1. Discover the secret names every workflow under .github/workflows/
 *      references (`secrets.<NAME>`). GITHUB_TOKEN is auto-provided and
 *      excluded from the required set.
 *   2. Verify every required name is present and non-empty in process.env.
 *   3. List the repo's current GHA secrets via `gh secret list`.
 *   4. Delete every existing secret and re-create the
 *      required set from process.env values.
 *
 * Recommended: invoke via `proton-env` (or your local secret store) so
 * required vars are injected without ever touching shell history:
 *
 *   proton-env -w infrastructure pnpm gh:update-secrets
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const WORKFLOWS_DIR = ".github/workflows";
const AUTO_PROVIDED = new Set(["GITHUB_TOKEN"]);

function requiredSecrets(): string[] {
	const names = new Set<string>();
	for (const file of readdirSync(WORKFLOWS_DIR)) {
		if (!(file.endsWith(".yml") || file.endsWith(".yaml"))) {
			continue;
		}
		const text = readFileSync(`${WORKFLOWS_DIR}/${file}`, "utf8");
		for (const match of text.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)) {
			const name = match[1];
			if (!AUTO_PROVIDED.has(name)) {
				names.add(name);
			}
		}
	}
	return [...names].sort();
}

// Map a GHA secret name (uppercase, as referenced by `secrets.X` in
// workflows) to the local env-var name expected by the operator's secret
// store. `TF_VAR_*` GHA secrets correspond to lowercase-suffix env vars
// because tofu's `TF_VAR_<name>` lookup is case-sensitive against the
// (lowercase) variable name in `variables.tf`. Everything else uses the
// same uppercase name in both places.
function envNameFor(ghaSecret: string): string {
	if (ghaSecret.startsWith("TF_VAR_")) {
		return `TF_VAR_${ghaSecret.slice("TF_VAR_".length).toLowerCase()}`;
	}
	return ghaSecret;
}

function checkEnv(required: string[]): { missing: string[] } {
	const missing = required.filter((n) => !process.env[envNameFor(n)]);
	return { missing };
}

function gh(args: string[], input?: string): string {
	const r = spawnSync("gh", args, {
		input,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "inherit"],
	});
	if (r.status !== 0) {
		throw new Error(`gh ${args.join(" ")} exited ${r.status}`);
	}
	return r.stdout;
}

function listExistingSecrets(): string[] {
	const out = gh(["secret", "list", "--json", "name", "-q", ".[].name"]);
	return out.split("\n").filter(Boolean).sort();
}

async function main(): Promise<void> {
	const required = requiredSecrets();
	console.log(
		`Required secrets (${required.length}, derived from ${WORKFLOWS_DIR}):`,
	);
	for (const n of required) {
		console.log(`  - ${n}`);
	}

	const { missing } = checkEnv(required);
	if (missing.length > 0) {
		console.error(`\n✗ Missing in environment: ${missing.join(", ")}`);
		console.error("  Set them in your local secret store and re-run.");
		process.exit(1);
	}
	console.log("\n✓ All required vars present in environment.");

	const existing = listExistingSecrets();
	console.log(`\nExisting secrets in repo (${existing.length}):`);
	for (const n of existing) {
		console.log(`  - ${n}`);
	}

	const willDelete = existing;
	const willCreate = required;
	const willKeep = existing.filter((n) => required.includes(n));

	console.log("\nAbout to:");
	console.log(`  - delete ${willDelete.length} existing secret(s)`);
	console.log(`  - create ${willCreate.length} secret(s) from env vars`);
	if (willKeep.length > 0) {
		console.log(
			`  - (${willKeep.length} of those overlap — values will be replaced)`,
		);
	}

	for (const name of willDelete) {
		console.log(`  delete ${name}`);
		gh(["secret", "delete", name]);
	}
	for (const name of willCreate) {
		const value = process.env[envNameFor(name)];
		if (!value) {
			throw new Error(`unreachable: ${name} disappeared from env`);
		}
		console.log(`  create ${name}`);
		gh(["secret", "set", name], value);
	}

	console.log(`\n✓ Synced ${willCreate.length} secret(s).`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
