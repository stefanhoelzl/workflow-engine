import { createFsStorage } from "./fs.js";
import type { StorageBackend } from "./index.js";

// Selects and constructs the StorageBackend by `config.storageBackend`. Async
// so the chosen backend can do its own initialization (fs `mkdir`, or a future
// remote backend's credentials/connectivity probe) and fail fast at boot. A
// future S3/Bunny backend is a pure addition: a new `case` here.
async function createStorage(config: {
	storageBackend: string;
	persistencePath: string;
}): Promise<StorageBackend> {
	switch (config.storageBackend) {
		case "fs":
			return await createFsStorage(config.persistencePath);
		default:
			throw new Error(
				`Unknown STORAGE_BACKEND "${config.storageBackend}" (expected "fs")`,
			);
	}
}

export { createStorage };
