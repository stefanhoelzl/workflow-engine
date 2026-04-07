import { describe, expect, it } from "vitest";
import { PayloadValidationError } from "./errors.js";

describe("PayloadValidationError", () => {
	it("carries event type and issues for invalid payload", () => {
		const cause = new Error("parse failed");
		const error = new PayloadValidationError(
			"order.received",
			[{ path: "orderId", message: "Expected string, received number" }],
			cause,
		);

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("PayloadValidationError");
		expect(error.eventType).toBe("order.received");
		expect(error.issues).toEqual([
			{ path: "orderId", message: "Expected string, received number" },
		]);
		expect(error.message).toBe(
			"Payload validation failed for event 'order.received'",
		);
		expect(error.cause).toBe(cause);
	});

	it("uses 'not defined' message for unknown event type (empty issues)", () => {
		const error = new PayloadValidationError("order.unknown", []);

		expect(error.eventType).toBe("order.unknown");
		expect(error.issues).toEqual([]);
		expect(error.message).toBe("Event type 'order.unknown' is not defined");
		expect(error.cause).toBeUndefined();
	});
});
