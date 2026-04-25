import { createGunzip, createGzip } from "node:zlib";
import {
	awaitCryptoReady,
	sealCiphertext,
} from "@workflow-engine/core/secrets-crypto";
import { extract as tarExtract, pack as tarPack } from "tar-stream";

const TRAILING_SLASHES = /\/+$/;

interface PublicKeyResponse {
	algorithm: string;
	publicKey: string;
	keyId: string;
}

interface TenantManifest {
	workflows: Record<string, unknown>[];
}

interface SealAuth {
	readonly user?: string | undefined;
	readonly token?: string | undefined;
}

interface SealOptions {
	url: string;
	owner: string;
	auth: SealAuth;
	// Injected env source; defaults to process.env.
	env?: Record<string, string | undefined>;
}

class MissingSecretEnvError extends Error {
	readonly missing: readonly string[];
	constructor(missing: readonly string[]) {
		super(
			`Missing env vars for secret bindings: ${missing.join(", ")}. ` +
				"Set them in the shell running `wfe upload`.",
		);
		this.name = "MissingSecretEnvError";
		this.missing = missing;
	}
}

class PublicKeyFetchError extends Error {
	readonly status: number | "network-error";
	constructor(message: string, status: number | "network-error") {
		super(message);
		// biome-ignore lint/security/noSecrets: error class name, no secret material
		this.name = "PublicKeyFetchError";
		this.status = status;
	}
}

async function fetchPublicKey(
	url: string,
	owner: string,
	auth: SealAuth,
): Promise<PublicKeyResponse> {
	const endpoint = `${url.replace(
		TRAILING_SLASHES,
		"",
	)}/api/workflows/${owner}/public-key`;
	const headers: Record<string, string> = {};
	if (auth.user) {
		headers["X-Auth-Provider"] = "local";
		headers.Authorization = `User ${auth.user}`;
	} else if (auth.token) {
		headers["X-Auth-Provider"] = "github";
		headers.Authorization = `Bearer ${auth.token}`;
	}
	let response: Response;
	try {
		response = await fetch(endpoint, { headers });
	} catch (err) {
		throw new PublicKeyFetchError(
			`public-key fetch failed: ${err instanceof Error ? err.message : String(err)}`,
			"network-error",
		);
	}
	if (!response.ok) {
		throw new PublicKeyFetchError(
			`public-key fetch returned ${String(response.status)} ${response.statusText}`,
			response.status,
		);
	}
	const body = (await response.json()) as PublicKeyResponse;
	if (
		body.algorithm !== "x25519" ||
		typeof body.publicKey !== "string" ||
		typeof body.keyId !== "string"
	) {
		throw new PublicKeyFetchError(
			`public-key response shape is unexpected: ${JSON.stringify(body)}`,
			response.status,
		);
	}
	return body;
}

function collectSecretBindings(manifest: TenantManifest): {
	total: number;
	byWorkflow: Map<string, string[]>;
} {
	const byWorkflow = new Map<string, string[]>();
	let total = 0;
	for (const workflow of manifest.workflows) {
		const bindings = (workflow as { secretBindings?: unknown }).secretBindings;
		if (Array.isArray(bindings) && bindings.length > 0) {
			const names = bindings.filter((b): b is string => typeof b === "string");
			byWorkflow.set(String(workflow.name), names);
			total += names.length;
		}
	}
	return { total, byWorkflow };
}

interface SealInputs {
	readonly manifest: TenantManifest;
	readonly bindingsByWorkflow: Map<string, string[]>;
	readonly publicKey: Uint8Array;
	readonly keyId: string;
	readonly env: Record<string, string | undefined>;
}

interface SealOneInputs {
	readonly workflow: Record<string, unknown>;
	readonly envNames: readonly string[];
	readonly publicKey: Uint8Array;
	readonly keyId: string;
	readonly env: Record<string, string | undefined>;
}

function sealOneWorkflow(inputs: SealOneInputs): void {
	const { workflow, envNames, publicKey, keyId, env } = inputs;
	const secrets: Record<string, string> = {};
	for (const envName of envNames) {
		const plaintext = env[envName];
		if (plaintext === undefined) {
			throw new MissingSecretEnvError([envName]);
		}
		const ct = sealCiphertext(plaintext, publicKey);
		secrets[envName] = Buffer.from(ct).toString("base64");
	}
	workflow.secrets = secrets;
	workflow.secretsKeyId = keyId;
	workflow.secretBindings = undefined;
}

function sealAndRewrite(inputs: SealInputs): void {
	const { manifest, bindingsByWorkflow, publicKey, keyId, env } = inputs;
	const missing: string[] = [];
	for (const envNames of bindingsByWorkflow.values()) {
		for (const name of envNames) {
			if (env[name] === undefined) {
				missing.push(name);
			}
		}
	}
	if (missing.length > 0) {
		throw new MissingSecretEnvError(missing);
	}
	for (const workflow of manifest.workflows) {
		const names = bindingsByWorkflow.get(String(workflow.name));
		if (!names || names.length === 0) {
			continue;
		}
		sealOneWorkflow({
			workflow,
			envNames: names,
			publicKey,
			keyId,
			env,
		});
	}
}

async function readTarGzEntries(
	bytes: Uint8Array,
): Promise<Array<{ name: string; content: Buffer }>> {
	const { Readable } = await import("node:stream");
	const entries: Array<{ name: string; content: Buffer }> = [];
	const gz = createGunzip();
	const tar = tarExtract();
	// `Readable.from(uint8)` iterates byte-by-byte (yields numbers). Wrap in
	// an array so the single Buffer is emitted as one chunk.
	const src = Readable.from([Buffer.from(bytes)]);
	// Wire stream errors to a rejection so malformed inputs surface as a
	// thrown promise the caller can catch, rather than an uncaught
	// exception.
	const streamError = new Promise<never>((_, reject) => {
		const onErr = (err: unknown) => {
			reject(err instanceof Error ? err : new Error(String(err)));
		};
		src.once("error", onErr);
		gz.once("error", onErr);
		tar.once("error", onErr);
	});
	src.pipe(gz).pipe(tar);
	const drain = (async () => {
		for await (const entry of tar) {
			const chunks: Buffer[] = [];
			for await (const c of entry) {
				chunks.push(c as Buffer);
			}
			entries.push({
				name: entry.header.name,
				content: Buffer.concat(chunks),
			});
		}
		return entries;
	})();
	return await Promise.race([drain, streamError]);
}

async function writeTarGz(
	entries: Array<{ name: string; content: Buffer }>,
): Promise<Buffer> {
	const tar = tarPack();
	for (const { name, content } of entries) {
		tar.entry({ name }, content);
	}
	tar.finalize();
	const gz = createGzip();
	const chunks: Buffer[] = [];
	const { pipeline } = await import("node:stream/promises");
	const { Writable } = await import("node:stream");
	const sink = new Writable({
		write(chunk, _enc, cb) {
			chunks.push(chunk);
			cb();
		},
	});
	await pipeline(tar, gz, sink);
	return Buffer.concat(chunks);
}

/**
 * If any workflow's manifest contains `secretBindings`, fetches the
 * server public key, seals each binding's value from `env`, rewrites
 * each workflow manifest (drops `secretBindings`, adds `secrets` +
 * `secretsKeyId`), and returns the new bundle bytes. If no secret
 * bindings are present, returns the original bytes unchanged without
 * a network round-trip.
 *
 * All processing is in-memory — the rewritten tarball is never
 * written to disk.
 */
async function sealBundleIfNeeded(
	bundleBytes: Uint8Array,
	options: SealOptions,
): Promise<Uint8Array> {
	let entries: Array<{ name: string; content: Buffer }>;
	try {
		entries = await readTarGzEntries(bundleBytes);
	} catch {
		// Not a valid gzipped tar (e.g., test fixture or malformed bundle).
		// Pass the bytes through unchanged — the server will reject with 415
		// if the bundle is actually malformed; sealing a non-tar doesn't
		// make sense.
		return bundleBytes;
	}
	const manifestEntry = entries.find((e) => e.name === "manifest.json");
	if (!manifestEntry) {
		return bundleBytes;
	}
	let manifest: TenantManifest;
	try {
		manifest = JSON.parse(
			manifestEntry.content.toString("utf8"),
		) as TenantManifest;
	} catch {
		return bundleBytes;
	}
	const { total, byWorkflow } = collectSecretBindings(manifest);
	if (total === 0) {
		return bundleBytes;
	}
	await awaitCryptoReady();
	const pkRes = await fetchPublicKey(options.url, options.owner, options.auth);
	const pk = Uint8Array.from(Buffer.from(pkRes.publicKey, "base64"));
	const env =
		options.env ??
		// biome-ignore lint/style/noProcessEnv: upload reads env at CLI invocation time
		(process.env as Record<string, string | undefined>);
	sealAndRewrite({
		manifest,
		bindingsByWorkflow: byWorkflow,
		publicKey: pk,
		keyId: pkRes.keyId,
		env,
	});
	manifestEntry.content = Buffer.from(JSON.stringify(manifest), "utf8");
	return await writeTarGz(entries);
}

export type { PublicKeyResponse, SealOptions };
export {
	collectSecretBindings,
	MissingSecretEnvError,
	PublicKeyFetchError,
	sealBundleIfNeeded,
};
