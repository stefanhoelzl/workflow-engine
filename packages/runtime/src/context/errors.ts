interface ValidationIssue {
	path: string;
	message: string;
}

class PayloadValidationError extends Error {
	readonly eventType: string;
	readonly issues: ValidationIssue[];

	constructor(eventType: string, issues: ValidationIssue[], cause?: Error) {
		const message =
			issues.length > 0
				? `Payload validation failed for event '${eventType}'`
				: `Event type '${eventType}' is not defined`;
		super(message, { cause });
		this.name = "PayloadValidationError";
		this.eventType = eventType;
		this.issues = issues;
	}
}

export { PayloadValidationError, type ValidationIssue };
