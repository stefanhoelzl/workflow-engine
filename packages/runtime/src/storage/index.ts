interface StorageBackend {
	init(): Promise<void>;
	write(path: string, data: string): Promise<void>;
	read(path: string): Promise<string>;
	list(prefix: string): AsyncIterable<string>;
	remove(path: string): Promise<void>;
	move(from: string, to: string): Promise<void>;
}

export type { StorageBackend };
