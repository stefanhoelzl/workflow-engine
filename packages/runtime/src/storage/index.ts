interface StorageBackend {
	init(): Promise<void>;
	write(path: string, data: string): Promise<void>;
	writeBytes(path: string, data: Uint8Array): Promise<void>;
	read(path: string): Promise<string>;
	readBytes(path: string): Promise<Uint8Array>;
	list(prefix: string): AsyncIterable<string>;
	remove(path: string): Promise<void>;
	removePrefix(prefix: string): Promise<void>;
	move(from: string, to: string): Promise<void>;
}

export type { StorageBackend };
