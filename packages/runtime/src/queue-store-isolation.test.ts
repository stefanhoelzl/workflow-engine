import { glob, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Tenant isolation guard: enforce that the only module constructing SQL
// against the `queue_items` table is `queue-store.ts`. Every other file
// MUST go through the typed accessor, which requires a fully-qualified
// (owner, repo, workflow, queue) tuple at the type level.
//
// This is the lint-rule analog called out in the spec's "Tenant-scoped
// accessor" requirement. A test-shaped check is lighter than a custom
// Biome plugin and runs in CI via `pnpm test`.
// ---------------------------------------------------------------------------

const RUNTIME_SRC = resolve(__dirname);
// Files allowed to reference the table by name. Extend cautiously.
const ALLOWLIST = new Set<string>([
	"queue-store.ts",
	"queue-store.test.ts",
	"queue-store-isolation.test.ts",
	// queue-store-lifecycle.ts orchestrates accessor calls (removeDeclaration,
	// reconcile) and references `queue_items` only in module-doc comments —
	// no raw SQL or table-name strings in code. Allowed sibling.
	"queue-store-lifecycle.ts",
	// 0001-initial.ts is the schema-migration that CREATEs the table. This is
	// schema DDL (owned by the database-migrations capability), not tenant-
	// scoped data access — there is no (owner, repo, workflow, queue) tuple to
	// enforce on a CREATE TABLE. Allowed as the one legitimate DDL site.
	"0001-initial.ts",
	// migrate.test.ts inspects the migrated schema (PRAGMA, counts) and seeds
	// raw rows to simulate a pre-migration live database for the baselining
	// test — deliberately outside the accessor, which is the code under test.
	"migrate.test.ts",
]);

// Patterns that would indicate raw SQL construction against the table from
// outside the accessor. We look for literal "queue_items" in any source
// file — the accessor is the only legitimate site.
const TABLE_TOKEN = "queue_items";

async function* walk(dir: string): AsyncGenerator<string> {
	for await (const entry of glob("**/*.{ts,tsx}", { cwd: dir })) {
		yield entry;
	}
}

describe("queue-store isolation", () => {
	it("queue_items is referenced only by the accessor module", async () => {
		const offenders: { file: string; line: number; text: string }[] = [];
		for await (const rel of walk(RUNTIME_SRC)) {
			const fileName = rel.split("/").pop() ?? rel;
			if (ALLOWLIST.has(fileName)) {
				continue;
			}
			const abs = join(RUNTIME_SRC, rel);
			const content = await readFile(abs, "utf8");
			if (!content.includes(TABLE_TOKEN)) {
				continue;
			}
			content.split("\n").forEach((line, idx) => {
				if (line.includes(TABLE_TOKEN)) {
					offenders.push({
						file: relative(RUNTIME_SRC, abs),
						line: idx + 1,
						text: line.trim(),
					});
				}
			});
		}
		if (offenders.length > 0) {
			const summary = offenders
				.map((o) => `  ${o.file}:${o.line}: ${o.text}`)
				.join("\n");
			expect.fail(
				`Found ${String(offenders.length)} reference(s) to "queue_items" outside the accessor module.\nAll queue table access MUST go through queue-store.ts so the (owner, repo, workflow, queue) tuple is enforced at the type level.\nOffenders:\n${summary}\n\nIf this is intentional, add the file to the ALLOWLIST in queue-store-isolation.test.ts and justify with a comment.`,
			);
		}
	});
});
