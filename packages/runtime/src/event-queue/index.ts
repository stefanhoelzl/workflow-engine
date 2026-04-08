import { z } from "@workflow-engine/sdk";

const EventSchema = z.object({
	id: z.string(),
	type: z.string(),
	payload: z.unknown(),
	targetAction: z.exactOptional(z.string()),
	correlationId: z.string(),
	parentEventId: z.exactOptional(z.string()),
	createdAt: z.coerce.date(),
});

type Event = z.infer<typeof EventSchema>;

interface EventQueue {
	enqueue(event: Event): Promise<void>;
	dequeue(signal?: AbortSignal): Promise<Event>;
	ack(eventId: string): Promise<Event>;
	fail(eventId: string): Promise<Event>;
}

export { EventSchema };
export type { Event, EventQueue };
