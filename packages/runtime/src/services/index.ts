interface Service {
	start(): Promise<void>;
	stop(): Promise<void>;
}

export type { Service };
