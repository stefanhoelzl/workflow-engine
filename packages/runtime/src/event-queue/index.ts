interface Event {
	id: string;
	type: string;
	payload: unknown;
	targetAction?: string;
	correlationId: string;
	parentEventId?: string;
	createdAt: Date;
}

interface EventQueue {
	enqueue(event: Event): Promise<void>;
	dequeue(): Promise<Event>;
	ack(eventId: string): Promise<void>;
	fail(eventId: string): Promise<void>;
}

export type { Event, EventQueue };
