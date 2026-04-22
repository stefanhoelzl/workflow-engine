// Small Ajv-interop helpers shared by every runtime consumer that
// validates JSON against a schema: the trigger-input validator and the
// host-call-action plugin's validator instantiation path. Extracted so
// both paths agree on clone semantics and Ajv's instancePath → segment[]
// mapping.

function structuredCloneJson<T>(value: T): T {
	if (value === undefined) {
		return value;
	}
	try {
		return JSON.parse(JSON.stringify(value)) as T;
	} catch {
		return value;
	}
}

function ajvPathToSegments(instancePath: string): (string | number)[] {
	if (instancePath === "") {
		return [];
	}
	return instancePath
		.split("/")
		.slice(1)
		.map((seg) => {
			const n = Number(seg);
			return Number.isFinite(n) && seg !== "" ? n : seg;
		});
}

export { ajvPathToSegments, structuredCloneJson };
