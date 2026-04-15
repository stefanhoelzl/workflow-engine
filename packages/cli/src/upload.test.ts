import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoWorkflowsFoundError } from "./build.js";
import { upload } from "./upload.js";

interface CapturedRequest {
	path: string;
	method: string;
	headers: Record<string, string>;
	body: Buffer;
}

interface MockRuntime {
	url: string;
	requests: CapturedRequest[];
	close: () => Promise<void>;
	setResponder: (
		responder: (req: CapturedRequest) => {
			status: number;
			body?: object | undefined;
		},
	) => void;
}

async function startMockRuntime(): Promise<MockRuntime> {
	const requests: CapturedRequest[] = [];
	let closed = false;
	let responder: (req: CapturedRequest) => {
		status: number;
		body?: object | undefined;
	} = () => ({
		status: 204,
	});
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === "string") {
					headers[k.toLowerCase()] = v;
				}
			}
			const captured: CapturedRequest = {
				path: req.url ?? "",
				method: req.method ?? "",
				headers,
				body: Buffer.concat(chunks),
			};
			requests.push(captured);
			const { status, body } = responder(captured);
			if (body === undefined) {
				res.writeHead(status);
				res.end();
			} else {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			}
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	if (!addr || typeof addr !== "object") {
		throw new Error("mock server address is unexpectedly null");
	}
	return {
		url: `http://127.0.0.1:${String(addr.port)}`,
		requests,
		setResponder(next) {
			responder = next;
		},
		close: () => {
			if (closed) {
				return Promise.resolve();
			}
			closed = true;
			return new Promise<void>((resolve, reject) => {
				server.close((err) => (err ? reject(err) : resolve()));
			});
		},
	};
}

async function createProjectWithBundles(
	names: string[],
): Promise<{ cwd: string; cleanup: () => Promise<void> }> {
	const cwd = await mkdtemp(join(tmpdir(), "wfe-cli-upload-"));
	const distDir = join(cwd, "dist");
	await mkdir(distDir);
	await Promise.all(
		names.map(async (name) => {
			const sub = join(distDir, name);
			await mkdir(sub);
			await writeFile(join(sub, "bundle.tar.gz"), `${name}-bundle-contents`);
		}),
	);
	await writeFile(
		join(cwd, "package.json"),
		JSON.stringify({ type: "module", name: "wfe-cli-upload-test" }),
	);
	return { cwd, cleanup: async () => {} };
}

// The real `upload()` invokes `build()` first, which requires src/. For
// unit-testing the upload logic in isolation we mock build().
vi.mock("./build.js", async () => {
	const actual =
		await vi.importActual<typeof import("./build.js")>("./build.js");
	return {
		...actual,
		build: vi.fn(async () => {}),
	};
});

describe("upload", () => {
	let runtime: MockRuntime;

	beforeEach(async () => {
		runtime = await startMockRuntime();
	});

	afterEach(async () => {
		await runtime.close();
		// biome-ignore lint/performance/noDelete: test cleanup; token must actually be absent, not empty
		// biome-ignore lint/style/noProcessEnv: test needs to manipulate the CLI's documented env var
		delete process.env.GITHUB_TOKEN;
	});

	it("uploads all bundles and reports success", async () => {
		const { cwd } = await createProjectWithBundles(["alpha", "beta"]);
		runtime.setResponder(() => ({ status: 204 }));

		const result = await upload({ cwd, url: runtime.url });

		expect(result).toEqual({ uploaded: 2, failed: 0 });
		expect(runtime.requests).toHaveLength(2);
		expect(runtime.requests[0]?.path).toBe("/api/workflows");
		expect(runtime.requests[0]?.headers["content-type"]).toBe(
			"application/gzip",
		);
		expect(runtime.requests[0]?.headers.authorization).toBeUndefined();
	});

	it("sends Authorization header when GITHUB_TOKEN is set", async () => {
		const { cwd } = await createProjectWithBundles(["alpha"]);
		// biome-ignore lint/style/noProcessEnv: test needs to manipulate the CLI's documented env var
		process.env.GITHUB_TOKEN = "ghp_test";
		runtime.setResponder(() => ({ status: 204 }));

		await upload({ cwd, url: runtime.url });

		expect(runtime.requests[0]?.headers.authorization).toBe("Bearer ghp_test");
	});

	it("continues after one bundle fails (best-effort)", async () => {
		const { cwd } = await createProjectWithBundles(["alpha", "beta", "gamma"]);
		runtime.setResponder((req) => {
			if (req.body.toString().startsWith("beta")) {
				return {
					status: 422,
					body: { error: "missing action module: actions.js" },
				};
			}
			return { status: 204 };
		});

		const result = await upload({ cwd, url: runtime.url });

		expect(result).toEqual({ uploaded: 2, failed: 1 });
		expect(runtime.requests).toHaveLength(3);
	});

	it("surfaces 401 as a failure", async () => {
		const { cwd } = await createProjectWithBundles(["alpha"]);
		runtime.setResponder(() => ({
			status: 401,
			body: { error: "Unauthorized" },
		}));

		const result = await upload({ cwd, url: runtime.url });

		expect(result).toEqual({ uploaded: 0, failed: 1 });
	});

	it("surfaces 422 with issues as a failure and formats them", async () => {
		const { cwd } = await createProjectWithBundles(["alpha"]);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		runtime.setResponder(() => ({
			status: 422,
			body: {
				error: "invalid manifest",
				issues: [
					{ path: ["actions", 0, "name"], message: "Required" },
					{ path: ["triggers", 0, "path"], message: "must match /^[a-z]+$/" },
				],
			},
		}));

		const result = await upload({ cwd, url: runtime.url });

		expect(result).toEqual({ uploaded: 0, failed: 1 });
		const joined = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
		expect(joined).toContain("actions[0].name: Required");
		expect(joined).toContain("triggers[0].path: must match /^[a-z]+$/");
		errorSpy.mockRestore();
	});

	it("reports network errors without retrying", async () => {
		const { cwd } = await createProjectWithBundles(["alpha"]);
		await runtime.close();

		const result = await upload({ cwd, url: runtime.url });

		expect(result).toEqual({ uploaded: 0, failed: 1 });
	});

	it("throws NoWorkflowsFoundError when dist is empty after build", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "wfe-cli-empty-"));

		await expect(upload({ cwd, url: runtime.url })).rejects.toBeInstanceOf(
			NoWorkflowsFoundError,
		);
	});
});
