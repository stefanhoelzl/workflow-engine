import {
	appendFile,
	mkdir,
	mkdtemp,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	countQueueItems,
	listQueueItems,
	queueFilePath,
} from "./queue-read.js";

const COORDS = {
	owner: "acme",
	repo: "widgets",
	workflow: "build",
	queue: "jobs",
};

let queuesRoot: string;

async function seedQueueDir(): Promise<string> {
	const dir = join(queuesRoot, COORDS.owner, COORDS.repo, COORDS.workflow);
	await mkdir(dir, { recursive: true });
	return dir;
}

async function seedFile(content: string): Promise<string> {
	const dir = await seedQueueDir();
	const path = join(dir, `${COORDS.queue}.ndjson`);
	await writeFile(path, content);
	return path;
}

beforeEach(async () => {
	queuesRoot = await mkdtemp(join(tmpdir(), "queue-read-"));
});

afterEach(async () => {
	await rm(queuesRoot, { recursive: true, force: true });
});

describe("queueFilePath", () => {
	test("composes <root>/<owner>/<repo>/<workflow>/<queue>.ndjson", () => {
		expect(
			queueFilePath({
				queuesRoot: "/r",
				owner: "o",
				repo: "p",
				workflow: "w",
				queue: "q",
			}),
		).toBe("/r/o/p/w/q.ndjson");
	});
});

describe("listQueueItems", () => {
	test("returns empty result when file is missing (ENOENT)", async () => {
		const r = await listQueueItems({ queuesRoot, ...COORDS });
		expect(r.total).toBe(0);
		expect(r.items).toEqual([]);
	});

	test("returns empty result when file exists but has no lines", async () => {
		await seedFile("");
		const r = await listQueueItems({ queuesRoot, ...COORDS });
		expect(r.total).toBe(0);
		expect(r.items).toEqual([]);
	});

	test("parses every committed NDJSON line", async () => {
		await seedFile('{"a":1}\n{"b":2}\n{"c":3}\n');
		const r = await listQueueItems({ queuesRoot, ...COORDS });
		expect(r.total).toBe(3);
		expect(r.items).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
	});

	test("drops a partial trailing line (no terminating newline)", async () => {
		await seedFile('{"a":1}\n{"b":2}\n{"c":');
		const r = await listQueueItems({ queuesRoot, ...COORDS });
		expect(r.total).toBe(2);
		expect(r.items).toEqual([{ a: 1 }, { b: 2 }]);
	});

	test("drops every malformed line, returning zero items", async () => {
		await seedFile("garbage1\ngarbage2\n");
		const r = await listQueueItems({ queuesRoot, ...COORDS });
		expect(r.total).toBe(0);
		expect(r.items).toEqual([]);
	});

	test("offset+limit slices the result", async () => {
		await seedFile('{"i":0}\n{"i":1}\n{"i":2}\n{"i":3}\n{"i":4}\n');
		const r = await listQueueItems({
			queuesRoot,
			...COORDS,
			offset: 1,
			limit: 2,
		});
		expect(r.total).toBe(5);
		expect(r.items).toEqual([{ i: 1 }, { i: 2 }]);
	});

	test("offset past the end returns zero items but correct total", async () => {
		await seedFile('{"i":0}\n{"i":1}\n');
		const r = await listQueueItems({
			queuesRoot,
			...COORDS,
			offset: 100,
			limit: 50,
		});
		expect(r.total).toBe(2);
		expect(r.items).toEqual([]);
	});
});

describe("countQueueItems", () => {
	test("returns 0 for missing file", async () => {
		expect(await countQueueItems({ queuesRoot, ...COORDS })).toBe(0);
	});

	test("counts newlines, ignoring partial trailing line", async () => {
		await seedFile('{"a":1}\n{"b":2}\n{"c":');
		expect(await countQueueItems({ queuesRoot, ...COORDS })).toBe(2);
	});
});

describe("read does not mutate the queue file", () => {
	test("listQueueItems leaves content and mtime intact", async () => {
		const path = await seedFile('{"a":1}\n{"b":2}\n');
		const before = await stat(path);
		await listQueueItems({ queuesRoot, ...COORDS });
		const after = await stat(path);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	test("countQueueItems leaves content and mtime intact", async () => {
		const path = await seedFile('{"a":1}\n');
		const before = await stat(path);
		await countQueueItems({ queuesRoot, ...COORDS });
		const after = await stat(path);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});
});

describe("concurrent put", () => {
	test("interleaved appendFile + listQueueItems never throws and total is monotonic", async () => {
		const path = join(
			queuesRoot,
			COORDS.owner,
			COORDS.repo,
			COORDS.workflow,
			`${COORDS.queue}.ndjson`,
		);
		await mkdir(join(queuesRoot, COORDS.owner, COORDS.repo, COORDS.workflow), {
			recursive: true,
		});
		await writeFile(path, "");

		const ITER = 200;
		const writer = (async () => {
			for (let i = 0; i < ITER; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: queue put semantics — each appendFile must complete (and the line be durable) before the next; parallelising defeats the test's purpose of exercising sequential commits
				await appendFile(path, `${JSON.stringify({ i })}\n`);
			}
		})();

		const reader = (async () => {
			let lastTotal = 0;
			for (let i = 0; i < ITER; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: monotonicity check requires reads to be observed sequentially relative to one another so the lastTotal comparison is meaningful
				const r = await listQueueItems({ queuesRoot, ...COORDS });
				expect(r.total).toBeGreaterThanOrEqual(lastTotal);
				lastTotal = r.total;
			}
		})();

		await Promise.all([writer, reader]);
	});
});

describe("concurrent rename-based replacement", () => {
	test("rename-and-read never observes torn state", async () => {
		const dir = join(queuesRoot, COORDS.owner, COORDS.repo, COORDS.workflow);
		await mkdir(dir, { recursive: true });
		const path = join(dir, `${COORDS.queue}.ndjson`);
		const initial = '{"a":1}\n{"b":2}\n{"c":3}\n';
		await writeFile(path, initial);
		const replaced = '{"b":2}\n{"c":3}\n';

		const ITER = 50;
		const swapper = (async () => {
			for (let i = 0; i < ITER; i++) {
				const tmpA = `${path}.tmp.A.${i}`;
				const tmpB = `${path}.tmp.B.${i}`;
				// biome-ignore lint/performance/noAwaitInLoops: rename-based atomic swap pattern must run sequentially — the test's invariant is that the reader observes only one of the two consistent states, never a torn mix; parallel writes break that invariant
				await writeFile(tmpA, replaced);
				await rename(tmpA, path);
				await writeFile(tmpB, initial);
				await rename(tmpB, path);
			}
		})();

		const reader = (async () => {
			for (let i = 0; i < ITER * 2; i++) {
				// biome-ignore lint/performance/noAwaitInLoops: each read is a probe of the file's current state; parallelising loses the per-read assertion
				const r = await listQueueItems({ queuesRoot, ...COORDS });
				// Either the 3-item state or the 2-item state — never a mix.
				expect([2, 3]).toContain(r.total);
				if (r.total === 3) {
					expect(r.items).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
				} else {
					expect(r.items).toEqual([{ b: 2 }, { c: 3 }]);
				}
			}
		})();

		await Promise.all([swapper, reader]);
	});
});
