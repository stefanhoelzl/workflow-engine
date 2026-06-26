interface StorageBackend {
	write(path: string, data: Uint8Array): Promise<void>;
	read(path: string): Promise<Uint8Array>;
	list(prefix: string): AsyncIterable<string>;
}

// Thrown by `read` when no object exists at the requested key. Every backend
// maps its native miss signal (fs `ENOENT`, object-store HTTP 404) to this so
// callers branch on one backend-agnostic type.
class NotFoundError extends Error {
	constructor(path: string) {
		super(`storage: no object at "${path}"`);
		this.name = "NotFoundError";
	}
}

export type { StorageBackend };
export { NotFoundError };
