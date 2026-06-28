import type { Secret } from "../config.js";
import { createBunnyStorage } from "./bunny.js";
import { createFsStorage } from "./fs.js";
import type { StorageBackend } from "./index.js";

// Selects and constructs the StorageBackend by `config.storageBackend`. Async
// so the chosen backend can do its own initialization (fs `mkdir`, or a remote
// backend's credentials/connectivity probe) and fail fast at boot.
//
// This factory — not the config schema — owns per-backend required-config
// validation: the config layer carries `STORAGE_BUNNY_*` as optional fields and
// never enumerates backends, so the whole backend registry lives here.
async function createStorage(config: {
	storageBackend: string;
	persistencePath: string;
	// `| undefined` (not bare optional): the config transform always sets these
	// keys, to undefined when unset, which `exactOptionalPropertyTypes` rejects
	// against a bare `?:`.
	storageBunnyEndpoint?: string | undefined;
	storageBunnyStorageZone?: string | undefined;
	storageBunnyAccessKey?: Secret | undefined;
}): Promise<StorageBackend> {
	switch (config.storageBackend) {
		case "fs":
			return await createFsStorage(config.persistencePath);
		case "bunny": {
			const {
				storageBunnyEndpoint,
				storageBunnyStorageZone,
				storageBunnyAccessKey,
			} = config;
			if (
				storageBunnyEndpoint === undefined ||
				storageBunnyStorageZone === undefined ||
				storageBunnyAccessKey === undefined
			) {
				const missing: string[] = [];
				if (storageBunnyEndpoint === undefined) {
					missing.push("STORAGE_BUNNY_ENDPOINT");
				}
				if (storageBunnyStorageZone === undefined) {
					missing.push("STORAGE_BUNNY_STORAGE_ZONE");
				}
				if (storageBunnyAccessKey === undefined) {
					missing.push("STORAGE_BUNNY_ACCESS_KEY");
				}
				throw new Error(
					`STORAGE_BACKEND=bunny requires ${missing.join(", ")} to be set`,
				);
			}
			return await createBunnyStorage({
				endpoint: storageBunnyEndpoint,
				storageZone: storageBunnyStorageZone,
				accessKey: storageBunnyAccessKey.reveal(),
			});
		}
		default:
			throw new Error(
				`Unknown STORAGE_BACKEND "${config.storageBackend}" (expected "fs" or "bunny")`,
			);
	}
}

export { createStorage };
