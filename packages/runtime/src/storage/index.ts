interface StorageBackend {
	init(): Promise<void>;
	write(path: string, data: Uint8Array): Promise<void>;
	read(path: string): Promise<Uint8Array>;
	list(prefix: string): AsyncIterable<string>;
}

export type { StorageBackend };
