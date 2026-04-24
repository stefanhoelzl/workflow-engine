import { Hono } from "hono";
import sodium from "libsodium-wrappers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	buildRegistry,
	type ProviderRegistry,
} from "../auth/providers/index.js";
import { localProviderFactory } from "../auth/providers/local.js";
import type { Executor } from "../executor/index.js";
import { createKeyStore, readySodium } from "../secrets/index.js";
import { createWorkflowRegistry } from "../workflow-registry.js";
import { apiMiddleware } from "./index.js";

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(() => logger),
};

const stubExecutor: Executor = {
	invoke: vi.fn(async () => ({ ok: true as const, output: {} })),
};

function makeCsv(skBytes: Uint8Array): string {
	return `k1:${Buffer.from(skBytes).toString("base64")}`;
}

// Allow a single local user "acme" — tests send matching X-Auth-Provider/
// Authorization headers on every request so the membership check passes.
const AUTH_ALLOW = "local:acme";
const AUTH_HEADERS: Record<string, string> = {
	"x-auth-provider": "local",
	authorization: "User acme",
};

function openAuthRegistry(): ProviderRegistry {
	return buildRegistry(AUTH_ALLOW, [localProviderFactory], {
		secureCookies: false,
		nowFn: () => Date.now(),
	});
}

describe("GET /api/workflows/:owner/public-key", () => {
	beforeAll(async () => {
		await readySodium();
	});

	function mount(keyStore: ReturnType<typeof createKeyStore>) {
		const registry = createWorkflowRegistry({
			logger,
			executor: stubExecutor,
			keyStore,
		});
		const middleware = apiMiddleware({
			authRegistry: openAuthRegistry(),
			registry,
			logger,
			keyStore,
		});
		const app = new Hono();
		app.all(middleware.match, middleware.handler);
		return app;
	}

	it("returns the primary public key and keyId", async () => {
		const sk = sodium.randombytes_buf(32);
		const keyStore = createKeyStore(makeCsv(sk));
		const app = mount(keyStore);

		const res = await app.request("/api/workflows/acme/public-key", {
			method: "GET",
			headers: AUTH_HEADERS,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			algorithm: string;
			publicKey: string;
			keyId: string;
		};
		expect(body.algorithm).toBe("x25519");
		const decoded = Uint8Array.from(Buffer.from(body.publicKey, "base64"));
		const expectedPk = sodium.crypto_scalarmult_base(sk);
		expect(decoded).toEqual(expectedPk);
		expect(body.keyId).toMatch(/^[0-9a-f]{16}$/);
	});

	it("returns a keyId that matches the published public key", async () => {
		const sk = sodium.randombytes_buf(32);
		const keyStore = createKeyStore(makeCsv(sk));
		const app = mount(keyStore);

		const res = await app.request("/api/workflows/acme/public-key", {
			headers: AUTH_HEADERS,
		});
		const body = (await res.json()) as { publicKey: string; keyId: string };
		const digest = await crypto.subtle.digest(
			"SHA-256",
			Uint8Array.from(Buffer.from(body.publicKey, "base64")),
		);
		const firstBytes = new Uint8Array(digest).slice(0, 8);
		const hex = [...firstBytes]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		expect(body.keyId).toBe(hex);
	});

	it("returns 404 for an invalid owner identifier", async () => {
		const sk = sodium.randombytes_buf(32);
		const app = mount(createKeyStore(makeCsv(sk)));
		const res = await app.request("/api/workflows/$bad/public-key", {
			headers: AUTH_HEADERS,
		});
		expect(res.status).toBe(404);
	});
});
