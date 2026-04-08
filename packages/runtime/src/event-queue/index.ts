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
	ack(eventId: string): Promise<Event>;
	fail(eventId: string): Promise<Event>;
}

export type { Event, EventQueue };
