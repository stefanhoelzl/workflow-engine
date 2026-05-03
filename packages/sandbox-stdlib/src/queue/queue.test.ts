import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext } from "@workflow-engine/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QUEUE_DISPATCHER_NAME } from "./descriptor-name.js";
import { QueueError } from "./queue-error.js";
import {
	assertInput,
	type Config,
	countItems,
	dispatchGet,
	dispatchPut,
	rehydrateValidators,
	resolveQueuePath,
	worker,
} from "./worker.js";

const OWNER = "acme";
const REPO = "widgets";
const WORKFLOW = "orders";
const QUEUE = "jobs";

interface Fixture {
	root: string;
	config: Config;
}

async function makeFixture(
	overrides: Partial<Pick<Config, "declaredQueues" | "schemas">> = {},
): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "wfe-queue-"));
	const queuesRoot = join(root, "queues");
	await mkdir(join(queuesRoot, OWNER, REPO, WORKFLOW), { recursive: true });
	const schemas: Record<
		string,
		Record<string, unknown>
	> = overrides.schemas ?? {
		[QUEUE]: {
			type: "object",
			properties: {
				url: { type: "string" },
			},
			required: ["url"],
			additionalProperties: false,
		},
	};
	const declaredQueues = overrides.declaredQueues ?? Object.keys(schemas);
	// Mirror the upload-tx eager-create invariant: every declared queue has a
	// (possibly empty) file on disk. Tests that want orphan / missing-file
	// scenarios `unlink` afterwards.
	await Promise.all(
		declaredQueues.map((queueName) =>
			writeFile(
				join(queuesRoot, OWNER, REPO, WORKFLOW, `${queueName}.ndjson`),
				"",
			),
		),
	);
	const config: Config = {
		owner: OWNER,
		workflow: WORKFLOW,
		queuesRoot,
		declaredQueues,
		schemas,
	};
	return { root, config };
}

interface SeedQueueFileArgs {
	readonly queuesRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly workflow: string;
	readonly name: string;
	readonly content: string;
}

async function seedQueueFile(args: SeedQueueFileArgs): Promise<string> {
	const dir = join(args.queuesRoot, args.owner, args.repo, args.workflow);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${args.name}.ndjson`);
	await writeFile(path, args.content);
	return path;
}

function noopCtx(): PluginContext {
	return {
		emit() {
			/* no-op */
		},
		request(_p: unknown, _n: unknown, _e: unknown, fn: () => unknown) {
			return fn();
		},
	} as unknown as PluginContext;
}

describe("queue plugin — input validation", () => {
	it("rejects non-object input as queue.notDeclared", () => {
		expect(() => assertInput("nope")).toThrow(QueueError);
		expect(() => assertInput(null)).toThrow(QueueError);
	});

	it("rejects unknown op", () => {
		expect(() => assertInput({ op: "drop", name: "jobs" })).toThrow(
			/op must be "put" or "get"/,
		);
	});

	it("rejects path-traversal-style names with the queue-name regex", () => {
		expect(() => assertInput({ op: "get", name: "../other/q" })).toThrow(
			/is not declared/,
		);
		expect(() => assertInput({ op: "get", name: "Bad-Name" })).toThrow(
			/is not declared/,
		);
	});

	it("accepts a well-formed put input", () => {
		const result = assertInput({
			op: "put",
			name: "jobs",
			item: { url: "https://example.com" },
		});
		expect(result.op).toBe("put");
		expect(result.name).toBe("jobs");
	});
});

describe("queue plugin — countItems", () => {
	it("returns 0 for empty content", () => {
		expect(countItems("")).toBe(0);
	});
	it("counts non-empty newline-delimited entries", () => {
		expect(countItems('{"a":1}\n{"a":2}\n')).toBe(2);
	});
	it("ignores trailing/intermediate empty lines", () => {
		expect(countItems('{"a":1}\n\n{"a":2}\n')).toBe(2);
	});
});

describe("queue plugin — resolveQueuePath", () => {
	it("composes <root>/<owner>/<repo>/<workflow>/<name>.ndjson", () => {
		expect(
			resolveQueuePath({
				queuesRoot: "/srv/queues",
				owner: "acme",
				repo: "widgets",
				workflow: "orders",
				name: "jobs",
			}),
		).toBe("/srv/queues/acme/widgets/orders/jobs.ndjson");
	});
});

describe("queue plugin — dispatchPut", () => {
	let fixture: Fixture;
	beforeEach(async () => {
		fixture = await makeFixture();
	});

	it("appends a JSON line to the queue file when the item validates", async () => {
		const validators = rehydrateValidators(fixture.config.schemas);
		await dispatchPut(fixture.config, REPO, validators, {
			name: QUEUE,
			item: { url: "https://example.com" },
		});
		const content = await readFile(
			join(fixture.config.queuesRoot, OWNER, REPO, WORKFLOW, `${QUEUE}.ndjson`),
			"utf8",
		);
		expect(content).toBe('{"url":"https://example.com"}\n');
	});

	it("rejects an item that fails the schema with queue.schemaMismatch", async () => {
		const validators = rehydrateValidators(fixture.config.schemas);
		await expect(
			dispatchPut(fixture.config, REPO, validators, {
				name: QUEUE,
				item: { url: 42 },
			}),
		).rejects.toMatchObject({ code: "queue.schemaMismatch" });
	});

	it("rejects an item over 1024 bytes with queue.itemTooLarge", async () => {
		const big = { url: "https://example.com/", padding: "x".repeat(1100) };
		const validators = rehydrateValidators({
			[QUEUE]: { type: "object" },
		});
		const customConfig = {
			...fixture.config,
			schemas: { [QUEUE]: { type: "object" } },
		};
		await expect(
			dispatchPut(customConfig, REPO, validators, { name: QUEUE, item: big }),
		).rejects.toMatchObject({ code: "queue.itemTooLarge" });
	});

	it("rejects with queue.full when depth is at the cap", async () => {
		const validators = rehydrateValidators(fixture.config.schemas);
		const item = { url: "https://example.com" };
		const lines: string[] = [];
		for (let i = 0; i < 1000; i++) {
			lines.push(JSON.stringify(item));
		}
		await seedQueueFile({
			queuesRoot: fixture.config.queuesRoot,
			owner: OWNER,
			repo: REPO,
			workflow: WORKFLOW,
			name: QUEUE,
			content: `${lines.join("\n")}\n`,
		});
		await expect(
			dispatchPut(fixture.config, REPO, validators, { name: QUEUE, item }),
		).rejects.toMatchObject({ code: "queue.full" });
	});

	it("rejects an undeclared queue with queue.notDeclared", async () => {
		const validators = rehydrateValidators(fixture.config.schemas);
		await expect(
			dispatchPut(fixture.config, REPO, validators, {
				name: "ghost",
				item: { url: "x" },
			}),
		).rejects.toMatchObject({ code: "queue.notDeclared" });
	});
});

describe("queue plugin — dispatchGet", () => {
	let fixture: Fixture;
	beforeEach(async () => {
		fixture = await makeFixture();
	});

	it("returns {found: false} on an empty file", async () => {
		await seedQueueFile({
			queuesRoot: fixture.config.queuesRoot,
			owner: OWNER,
			repo: REPO,
			workflow: WORKFLOW,
			name: QUEUE,
			content: "",
		});
		const validators = rehydrateValidators(fixture.config.schemas);
		const result = await dispatchGet(fixture.config, REPO, validators, {
			name: QUEUE,
		});
		expect(result).toEqual({ found: false });
	});

	it("pops the head item FIFO and rewrites the rest", async () => {
		const a = '{"url":"https://example.com/a"}';
		const b = '{"url":"https://example.com/b"}';
		const c = '{"url":"https://example.com/c"}';
		const path = await seedQueueFile({
			queuesRoot: fixture.config.queuesRoot,
			owner: OWNER,
			repo: REPO,
			workflow: WORKFLOW,
			name: QUEUE,
			content: `${a}\n${b}\n${c}\n`,
		});
		const validators = rehydrateValidators(fixture.config.schemas);

		const r1 = await dispatchGet(fixture.config, REPO, validators, {
			name: QUEUE,
		});
		expect(r1).toEqual({ found: true, item: { url: "https://example.com/a" } });
		expect(await readFile(path, "utf8")).toBe(`${b}\n${c}\n`);

		const r2 = await dispatchGet(fixture.config, REPO, validators, {
			name: QUEUE,
		});
		expect(r2).toEqual({ found: true, item: { url: "https://example.com/b" } });
		expect(await readFile(path, "utf8")).toBe(`${c}\n`);

		const r3 = await dispatchGet(fixture.config, REPO, validators, {
			name: QUEUE,
		});
		expect(r3).toEqual({ found: true, item: { url: "https://example.com/c" } });
		expect(await readFile(path, "utf8")).toBe("");

		const r4 = await dispatchGet(fixture.config, REPO, validators, {
			name: QUEUE,
		});
		expect(r4).toEqual({ found: false });
	});

	it("on schema mismatch, drops the bad item and throws with item in payload", async () => {
		// Seed an item that doesn't match the URL schema.
		const path = await seedQueueFile({
			queuesRoot: fixture.config.queuesRoot,
			owner: OWNER,
			repo: REPO,
			workflow: WORKFLOW,
			name: QUEUE,
			content: `{"unexpected":42}\n`,
		});
		const validators = rehydrateValidators(fixture.config.schemas);
		try {
			await dispatchGet(fixture.config, REPO, validators, { name: QUEUE });
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(QueueError);
			expect((err as QueueError).code).toBe("queue.schemaMismatch");
			expect((err as QueueError).item).toEqual({ unexpected: 42 });
		}
		// Item was removed even though validation failed.
		expect(await readFile(path, "utf8")).toBe("");
	});

	it("returns queue.gone when the file is missing (orphaned in-flight invocation)", async () => {
		// Simulate the orphan scenario: a newer upload unlinked the file
		// while this old-sandbox invocation still has the queue in its
		// declaredQueues config.
		const { unlink: fsUnlink } = await import("node:fs/promises");
		await fsUnlink(
			resolveQueuePath({
				queuesRoot: fixture.config.queuesRoot,
				owner: OWNER,
				repo: REPO,
				workflow: WORKFLOW,
				name: QUEUE,
			}),
		);
		const validators = rehydrateValidators(fixture.config.schemas);
		await expect(
			dispatchGet(fixture.config, REPO, validators, { name: QUEUE }),
		).rejects.toMatchObject({ code: "queue.gone" });
	});

	it("rejects an undeclared queue with queue.notDeclared", async () => {
		const validators = rehydrateValidators(fixture.config.schemas);
		await expect(
			dispatchGet(fixture.config, REPO, validators, { name: "ghost" }),
		).rejects.toMatchObject({ code: "queue.notDeclared" });
	});
});

describe("queue plugin — symlink defense (O_NOFOLLOW)", () => {
	it("dispatchGet returns queue.gone when the queue path is a symlink", async () => {
		const fixture = await makeFixture();
		const target = await seedQueueFile({
			queuesRoot: fixture.config.queuesRoot,
			owner: OWNER,
			repo: "victim",
			workflow: WORKFLOW,
			name: QUEUE,
			content: '{"url":"https://leak.example"}\n',
		});
		// Replace the seeded empty file with a symlink at the resolved path
		// pointing at the victim's queue file.
		const { unlink: fsUnlink } = await import("node:fs/promises");
		const linkPath = resolveQueuePath({
			queuesRoot: fixture.config.queuesRoot,
			owner: OWNER,
			repo: REPO,
			workflow: WORKFLOW,
			name: QUEUE,
		});
		await fsUnlink(linkPath);
		await symlink(target, linkPath);
		const validators = rehydrateValidators(fixture.config.schemas);
		await expect(
			dispatchGet(fixture.config, REPO, validators, { name: QUEUE }),
		).rejects.toMatchObject({ code: "queue.gone" });
	});
});

describe("queue plugin — descriptor shape", () => {
	it("exposes the dispatcher with public:false and log.request:'system'", async () => {
		const fixture = await makeFixture();
		const setup = worker(noopCtx(), undefined, fixture.config);
		expect(setup.guestFunctions).toHaveLength(1);
		const desc = setup.guestFunctions?.[0];
		expect(desc?.name).toBe(QUEUE_DISPATCHER_NAME);
		expect(desc?.public).toBe(false);
		expect(desc?.log).toEqual({ request: "system" });
		expect(desc?.publicName).toBe("queue");
	});

	it("logName picks queue.put / queue.get from input.op", async () => {
		const fixture = await makeFixture();
		const setup = worker(noopCtx(), undefined, fixture.config);
		const desc = setup.guestFunctions?.[0];
		expect(desc?.logName?.([{ op: "put", name: "jobs" }])).toBe("queue.put");
		expect(desc?.logName?.([{ op: "get", name: "jobs" }])).toBe("queue.get");
	});

	it("logInput drops the item field (queue items are author payloads)", async () => {
		const fixture = await makeFixture();
		const setup = worker(noopCtx(), undefined, fixture.config);
		const desc = setup.guestFunctions?.[0];
		const result = desc?.logInput?.([
			{ op: "put", name: "jobs", item: { secret: "value" } },
		]) as Record<string, unknown>;
		expect(result).toEqual({ op: "put", name: "jobs" });
		expect(result.item).toBeUndefined();
	});
});

describe("queue plugin — per-run repo capture (onBeforeRunStarted)", () => {
	let fixture: Fixture;
	beforeEach(async () => {
		fixture = await makeFixture();
	});
	afterEach(() => {
		// Reset module-level state by triggering onRunFinished via worker setup.
		const setup = worker(noopCtx(), undefined, fixture.config);
		setup.onRunFinished?.(
			{ ok: true, output: undefined },
			{ name: "trigger", input: {} },
		);
	});

	it("dispatcher refuses ops when no run context is active", async () => {
		const setup = worker(noopCtx(), undefined, fixture.config);
		// With no onBeforeRunStarted call, activeRepo is null.
		const desc = setup.guestFunctions?.[0];
		const handler = desc?.handler as (...args: unknown[]) => Promise<unknown>;
		await expect(
			handler({ op: "put", name: QUEUE, item: { url: "x" } }),
		).rejects.toMatchObject({ code: "queue.notDeclared" });
	});

	it("dispatcher honours repo set via onBeforeRunStarted", async () => {
		const setup = worker(noopCtx(), undefined, fixture.config);
		setup.onBeforeRunStarted?.({
			name: "trigger",
			input: {},
			extras: { queue: { owner: OWNER, repo: REPO } },
		});
		const desc = setup.guestFunctions?.[0];
		const handler = desc?.handler as (...args: unknown[]) => Promise<unknown>;
		await handler({
			op: "put",
			name: QUEUE,
			item: { url: "https://example.com" },
		});
		const path = resolveQueuePath({
			queuesRoot: fixture.config.queuesRoot,
			owner: OWNER,
			repo: REPO,
			workflow: WORKFLOW,
			name: QUEUE,
		});
		const content = await readFile(path, "utf8");
		expect(content).toBe('{"url":"https://example.com"}\n');
	});
});
