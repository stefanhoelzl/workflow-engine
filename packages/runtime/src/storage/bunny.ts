import { NotFoundError, type StorageBackend } from "./index.js";

// Bunny Edge Storage backend. All requests go to the storage HTTP *origin*
// (`https://<endpoint>/<zone>/<key>`) with the `AccessKey` header — never a CDN
// pull zone, so a `read` after a `write` never observes a cached, stale object.
// No retry anywhere: a transient error surfaces to the caller (at boot, that
// crashes the container, which Magic Containers restarts). See
// `openspec/specs/storage-backend/spec.md` "Bunny Edge Storage backend".

interface BunnyConfig {
	// Storage origin host, e.g. `storage.bunnycdn.com`. NOT a CDN pull-zone host.
	endpoint: string;
	storageZone: string;
	// Revealed access key. The `Secret` wrapper is unwrapped by the factory so
	// the cleartext only lives behind the HTTP `AccessKey` header here.
	accessKey: string;
	// Test seam: a fake `fetch` to mock the Edge Storage HTTP layer. Defaults to
	// `globalThis.fetch` in production (mirrors the auth layer's `fetchFn`).
	fetchFn?: typeof globalThis.fetch;
}

// Shape of a Bunny directory-listing entry (only the fields we depend on).
// PascalCase mirrors the Bunny API wire shape (see biome.jsonc storage adapter
// naming-convention override).
interface BunnyListEntry {
	ObjectName: string;
	IsDirectory: boolean;
}

// Per-backend request context shared by the module-level operations.
interface BunnyCtx {
	fetchFn: typeof globalThis.fetch;
	base: string;
	headers: { AccessKey: string };
	zone: string;
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

// List a directory key ("" = zone root, otherwise ends with "/"). A missing
// directory lists as empty.
async function listDir(
	ctx: BunnyCtx,
	dirKey: string,
): Promise<BunnyListEntry[]> {
	const res = await ctx.fetchFn(`${ctx.base}/${dirKey}`, {
		headers: ctx.headers,
	});
	if (res.status === HTTP_NOT_FOUND) {
		return [];
	}
	if (!res.ok) {
		throw new Error(`bunny: list "${dirKey}" failed (HTTP ${res.status})`);
	}
	return (await res.json()) as BunnyListEntry[];
}

// Recurse the directory tree, building keys from our own traversal path
// (prefix + ObjectName) rather than each entry's zone-prefixed `Path` field.
// Directory entries are recursed into, never yielded.
async function* walk(ctx: BunnyCtx, dirKey: string): AsyncIterable<string> {
	for (const entry of await listDir(ctx, dirKey)) {
		const childKey = `${dirKey}${entry.ObjectName}`;
		if (entry.IsDirectory) {
			yield* walk(ctx, `${childKey}/`);
		} else {
			yield childKey;
		}
	}
}

async function writeObject(
	ctx: BunnyCtx,
	path: string,
	data: Uint8Array,
): Promise<void> {
	const res = await ctx.fetchFn(`${ctx.base}/${path}`, {
		method: "PUT",
		headers: ctx.headers,
		// A Uint8Array is a valid fetch body at runtime; the cast satisfies the
		// lib.dom `BodyInit` type (whose generic ArrayBufferLike rejects it).
		// Same pattern as the SDK CLI upload (packages/sdk/src/cli/upload.ts).
		body: data as BodyInit,
	});
	if (!res.ok) {
		throw new Error(`bunny: write "${path}" failed (HTTP ${res.status})`);
	}
}

async function readObject(ctx: BunnyCtx, path: string): Promise<Uint8Array> {
	const res = await ctx.fetchFn(`${ctx.base}/${path}`, {
		headers: ctx.headers,
	});
	if (res.status === HTTP_NOT_FOUND) {
		throw new NotFoundError(path);
	}
	if (!res.ok) {
		throw new Error(`bunny: read "${path}" failed (HTTP ${res.status})`);
	}
	return new Uint8Array(await res.arrayBuffer());
}

// Boot probe: one zone-root listing, classified by status. 401/403 = bad or
// missing access key (fatal); 200 incl. an empty zone = healthy; any other
// non-2xx = fatal. A fresh empty zone is a healthy first boot.
async function probe(ctx: BunnyCtx): Promise<void> {
	const res = await ctx.fetchFn(`${ctx.base}/`, { headers: ctx.headers });
	if (res.status === HTTP_UNAUTHORIZED || res.status === HTTP_FORBIDDEN) {
		throw new Error(
			`bunny: storage zone "${ctx.zone}" rejected the access key (HTTP ${res.status})`,
		);
	}
	if (!res.ok) {
		throw new Error(
			`bunny: storage zone "${ctx.zone}" probe failed (HTTP ${res.status})`,
		);
	}
}

async function createBunnyStorage(
	config: BunnyConfig,
): Promise<StorageBackend> {
	const ctx: BunnyCtx = {
		fetchFn: config.fetchFn ?? globalThis.fetch,
		base: `https://${config.endpoint}/${config.storageZone}`,
		headers: { AccessKey: config.accessKey },
		zone: config.storageZone,
	};
	await probe(ctx);
	return {
		write: (path, data) => writeObject(ctx, path, data),
		read: (path) => readObject(ctx, path),
		list: (prefix) => walk(ctx, prefix),
	};
}

export type { BunnyConfig };
export { createBunnyStorage };
