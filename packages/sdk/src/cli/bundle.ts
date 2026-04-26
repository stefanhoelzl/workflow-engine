import {
	awaitCryptoReady,
	sealCiphertext,
} from "@workflow-engine/core/secrets-crypto";
import {
	buildWorkflows,
	type UnsealedManifest,
	type UnsealedWorkflowManifest,
} from "./build-workflows.js";
import { fetchPublicKey } from "./seal-http.js";
import { packTarGz } from "./tar.js";

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

interface BundleOptions {
	cwd: string;
	url: string;
	owner: string;
	user?: string | undefined;
	token?: string | undefined;
	// Injected env source; defaults to process.env.
	env?: Record<string, string | undefined>;
}

interface SealedWorkflowManifest
	extends Omit<UnsealedWorkflowManifest, "secretBindings"> {
	secrets?: Record<string, string>;
	secretsKeyId?: string;
}

interface SealedManifest {
	workflows: SealedWorkflowManifest[];
}

function collectMissingSecretBindings(
	manifest: UnsealedManifest,
	env: Record<string, string | undefined>,
): string[] {
	const missing: string[] = [];
	for (const wf of manifest.workflows) {
		for (const name of wf.secretBindings ?? []) {
			if (env[name] === undefined) {
				missing.push(name);
			}
		}
	}
	return missing;
}

function sealManifest(
	manifest: UnsealedManifest,
	publicKey: Uint8Array,
	keyId: string,
	env: Record<string, string | undefined>,
): SealedManifest {
	const sealed: SealedWorkflowManifest[] = manifest.workflows.map((wf) => {
		const bindings = wf.secretBindings ?? [];
		const { secretBindings: _drop, ...rest } = wf;
		if (bindings.length === 0) {
			return rest;
		}
		const secrets: Record<string, string> = {};
		for (const name of bindings) {
			const plaintext = env[name];
			if (plaintext === undefined) {
				// Already validated by the caller; this is a defensive guard.
				throw new MissingSecretEnvError([name]);
			}
			const ct = sealCiphertext(plaintext, publicKey);
			secrets[name] = Buffer.from(ct).toString("base64");
		}
		return { ...rest, secrets, secretsKeyId: keyId };
	});
	return { workflows: sealed };
}

function manifestNeedsSealing(manifest: UnsealedManifest): boolean {
	return manifest.workflows.some((wf) => (wf.secretBindings?.length ?? 0) > 0);
}

/**
 * Builds workflows in-memory, optionally seals secrets against the server's
 * public key, packs a single gzipped tarball, and returns the bytes.
 *
 * Writes nothing to disk. Called by `wfe upload`. The returned tarball is
 * the deployable artifact: server's `ManifestSchema` accepts it directly.
 */
async function bundle(options: BundleOptions): Promise<Uint8Array> {
	// Forward `options.env` to `buildWorkflows` so the IIFE-eval VM sees the
	// caller's env (rather than process.env) when resolving build-time
	// `env({...})` bindings. The CLI passes nothing → falls back to
	// process.env. The e2e test framework passes a hermetic `buildEnv`.
	const buildEnvOverride = options.env
		? Object.fromEntries(
				Object.entries(options.env).filter(
					(entry): entry is [string, string] => entry[1] !== undefined,
				),
			)
		: undefined;
	const { files, manifest } = await buildWorkflows({
		cwd: options.cwd,
		...(buildEnvOverride === undefined ? {} : { env: buildEnvOverride }),
	});
	const env =
		options.env ??
		// biome-ignore lint/style/noProcessEnv: bundle reads env at CLI invocation time for sealing
		(process.env as Record<string, string | undefined>);

	let toShip: UnsealedManifest | SealedManifest = manifest;
	if (manifestNeedsSealing(manifest)) {
		const missing = collectMissingSecretBindings(manifest, env);
		if (missing.length > 0) {
			throw new MissingSecretEnvError(missing);
		}
		await awaitCryptoReady();
		const pkRes = await fetchPublicKey(options.url, options.owner, {
			user: options.user,
			token: options.token,
		});
		const pk = Uint8Array.from(Buffer.from(pkRes.publicKey, "base64"));
		toShip = sealManifest(manifest, pk, pkRes.keyId, env);
	}

	const manifestJson = `${JSON.stringify(toShip, null, 2)}\n`;
	const entries = [
		{ name: "manifest.json", content: manifestJson },
		...Array.from(files.entries()).map(([name, content]) => ({
			name,
			content,
		})),
	];
	return packTarGz(entries);
}

export type { BundleOptions, SealedManifest, SealedWorkflowManifest };
export { bundle, MissingSecretEnvError };
