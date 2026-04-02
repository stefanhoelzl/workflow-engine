interface Event {
	id: string;
	type: string;
	payload: unknown;
	createdAt: Date;
}

interface EventQueue {
	enqueue(event: Event): void;
}

export type { Event, EventQueue };
