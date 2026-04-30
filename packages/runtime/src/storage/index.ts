import type { Secret } from "../config.js";

type StorageLocator =
	| { kind: "fs"; root: string }
	| {
			kind: "s3";
			bucket: string;
			endpoint: string;
			region: string;
			accessKeyId: Secret;
			secretAccessKey: Secret;
			urlStyle: "path" | "virtual";
			useSsl: boolean;
	  };

interface StorageBackend {
	init(): Promise<void>;
	write(path: string, data: Uint8Array): Promise<void>;
	read(path: string): Promise<Uint8Array>;
	list(prefix: string): AsyncIterable<string>;
	locator(): StorageLocator;
}

export type { StorageBackend, StorageLocator };
