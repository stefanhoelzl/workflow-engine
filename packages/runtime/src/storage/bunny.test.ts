import { describe, expect, it } from "vitest";
import { createSecret } from "../config.js";
import { createBunnyStorage } from "./bunny.js";
import { collect, conformanceSuite } from "./conformance-suite.js";
import { createStorage } from "./factory.js";
import { NotFoundError } from "./index.js";

const ENDPOINT = "storage.bunnycdn.com";
const ZONE = "wfe-staging-bundles";
const ACCESS_KEY = "test-access-key";
const BASE = `https://${ENDPOINT}/${ZONE}`;

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

interface FakeBunny {
	fetchFn: typeof globalThis.fetch;
	store: Map<string, Uint8Array>;
	requests: Array<{ method: string; url: string }>;
}

function headerValue(
	headers: HeadersInit | undefined,
	name: string,
): string | undefined {
	if (!headers) {
		return;
	}
	const want = name.toLowerCase();
	if (headers instanceof Headers) {
		return headers.get(name) ?? undefined;
	}
	const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
	for (const [key, value] of pairs) {
		if (key.toLowerCase() === want) {
			return value;
		}
	}
	return;
}

async function bodyBytes(
	body: BodyInit | null | undefined,
): Promise<Uint8Array> {
	if (body == null) {
		return new Uint8Array();
	}
	if (body instanceof Uint8Array) {
		return body;
	}
	if (body instanceof ArrayBuffer) {
		return new Uint8Array(body);
	}
	if (typeof body === "string") {
		return new TextEncoder().encode(body);
	}
	throw new Error("fake bunny: unsupported request body type");
}

// Immediate children of a directory key ("" = root, else ends with "/"),
// matching Bunny's per-directory listing: subdirs as IsDirectory entries, files
// as plain entries.
function listing(
	store: Map<string, Uint8Array>,
	dirKey: string,
): Array<{ ObjectName: string; IsDirectory: boolean }> {
	const dirs = new Set<string>();
	const files: string[] = [];
	for (const key of store.keys()) {
		if (!key.startsWith(dirKey)) {
			continue;
		}
		const rest = key.slice(dirKey.length);
		const slash = rest.indexOf("/");
		if (slash === -1) {
			files.push(rest);
		} else {
			dirs.add(rest.slice(0, slash));
		}
	}
	return [
		...[...dirs].map((name) => ({ ObjectName: name, IsDirectory: true })),
		...files.map((name) => ({ ObjectName: name, IsDirectory: false })),
	];
}

// A fake `fetch` emulating the Bunny Edge Storage API surface the backend uses:
// PUT object replace, GET returning bytes or 404, and directory-listing JSON.
// Backed by an in-memory Map; rejects requests carrying the wrong access key
// with 401 (so the boot-probe classification is exercised).
function makeFakeBunny(accessKey = ACCESS_KEY): FakeBunny {
	const store = new Map<string, Uint8Array>();
	const requests: Array<{ method: string; url: string }> = [];
	const fetchFn = (async (input, init) => {
		const url = input instanceof URL ? input.toString() : String(input);
		const method = (init?.method ?? "GET").toUpperCase();
		requests.push({ method, url });

		if (headerValue(init?.headers, "AccessKey") !== accessKey) {
			return new Response("Unauthorized", { status: HTTP_UNAUTHORIZED });
		}
		if (url !== `${BASE}/` && !url.startsWith(`${BASE}/`)) {
			return new Response("Not Found", { status: HTTP_NOT_FOUND });
		}
		const key = decodeURIComponent(url.slice(`${BASE}/`.length));

		if (method === "PUT") {
			store.set(key, await bodyBytes(init?.body));
			return new Response(null, { status: HTTP_CREATED });
		}
		// GET: a key ending in "/" (or the empty root key) is a directory listing.
		if (key === "" || key.endsWith("/")) {
			return new Response(JSON.stringify(listing(store, key)), {
				status: HTTP_OK,
				headers: { "content-type": "application/json" },
			});
		}
		const data = store.get(key);
		if (data === undefined) {
			return new Response("Not Found", { status: HTTP_NOT_FOUND });
		}
		return new Response(data as BodyInit, { status: HTTP_OK });
	}) as typeof globalThis.fetch;

	return { fetchFn, store, requests };
}

// A fresh fake per backend so each conformance test starts from an empty zone.
conformanceSuite("bunny", async () =>
	createBunnyStorage({
		endpoint: ENDPOINT,
		storageZone: ZONE,
		accessKey: ACCESS_KEY,
		fetchFn: makeFakeBunny().fetchFn,
	}),
);

describe("StorageBackend bunny: backend specifics", () => {
	async function make(fake = makeFakeBunny()) {
		const backend = await createBunnyStorage({
			endpoint: ENDPOINT,
			storageZone: ZONE,
			accessKey: ACCESS_KEY,
			fetchFn: fake.fetchFn,
		});
		return { backend, fake };
	}

	it("maps a 404 read to NotFoundError", async () => {
		const { backend } = await make();
		await expect(
			backend.read("workflows/missing.tar.gz"),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	it("lists object keys recursively, never directory entries", async () => {
		const { backend } = await make();
		await backend.write("workflows/acme/foo.tar.gz", new Uint8Array([1]));
		await backend.write("workflows/acme/bar.tar.gz", new Uint8Array([2]));
		await backend.write("workflows/other/baz.tar.gz", new Uint8Array([3]));

		const keys = await collect(backend.list("workflows/"));

		expect(keys.sort()).toEqual([
			"workflows/acme/bar.tar.gz",
			"workflows/acme/foo.tar.gz",
			"workflows/other/baz.tar.gz",
		]);
		expect(keys.some((k) => k.endsWith("/"))).toBe(false);
	});

	it("targets the storage origin host, never a CDN host", async () => {
		const { backend, fake } = await make();
		await backend.write("workflows/foo.tar.gz", new Uint8Array([1]));
		await backend.read("workflows/foo.tar.gz");
		await collect(backend.list("workflows/"));

		expect(fake.requests.length).toBeGreaterThan(0);
		for (const req of fake.requests) {
			expect(new URL(req.url).host).toBe(ENDPOINT);
			expect(req.url).not.toContain("b-cdn.net");
		}
	});

	it("crashes at boot when the access key is rejected (401)", async () => {
		// Backend configured with the wrong key → the fake replies 401 to the probe.
		await expect(
			createBunnyStorage({
				endpoint: ENDPOINT,
				storageZone: ZONE,
				accessKey: "wrong-key",
				fetchFn: makeFakeBunny(ACCESS_KEY).fetchFn,
			}),
		).rejects.toThrow(/access key/i);
	});

	it("treats an empty zone as a healthy boot", async () => {
		const { backend } = await make();
		expect(await collect(backend.list("workflows/"))).toEqual([]);
	});
});

describe("createStorage: bunny backend wiring", () => {
	const baseConfig = {
		storageBackend: "bunny",
		persistencePath: "/data",
		storageBunnyEndpoint: ENDPOINT,
		storageBunnyStorageZone: ZONE,
		storageBunnyAccessKey: createSecret(ACCESS_KEY),
	};

	it("fails fast naming a missing STORAGE_BUNNY_* field", async () => {
		await expect(
			createStorage({
				storageBackend: "bunny",
				persistencePath: "/data",
				storageBunnyEndpoint: ENDPOINT,
				storageBunnyStorageZone: ZONE,
			}),
		).rejects.toThrow(/STORAGE_BUNNY_ACCESS_KEY/);
	});

	it("rejects an unknown backend value", async () => {
		await expect(
			createStorage({ ...baseConfig, storageBackend: "s3" }),
		).rejects.toThrow(/Unknown STORAGE_BACKEND/);
	});
});
