import { describe, expect, it } from "vitest";
import type { ManualTriggerDescriptor } from "../executor/types.js";
import { createManualTriggerSource } from "./manual.js";
import type { TriggerEntry } from "./source.js";
import { makeManualDescriptor, makeTriggerEntry } from "./test-descriptors.js";

function makeEntry(name: string): TriggerEntry<ManualTriggerDescriptor> {
	return makeTriggerEntry(makeManualDescriptor({ name }), {
		onFire: async () => ({ ok: true, output: {} }),
	});
}

describe("createManualTriggerSource", () => {
	it("exposes kind: 'manual'", () => {
		const source = createManualTriggerSource();
		expect(source.kind).toBe("manual");
	});

	it("start() and stop() resolve without side effects", async () => {
		const source = createManualTriggerSource();
		await expect(source.start()).resolves.toBeUndefined();
		await expect(source.stop()).resolves.toBeUndefined();
	});

	it("reconfigure returns {ok: true} for any entries", async () => {
		const source = createManualTriggerSource();
		const empty = await source.reconfigure("t0", "r0", []);
		expect(empty.ok).toBe(true);
		const oneEntry = await source.reconfigure("t0", "r0", [makeEntry("a")]);
		expect(oneEntry.ok).toBe(true);
		const manyEntries = await source.reconfigure("t0", "r0", [
			makeEntry("a"),
			makeEntry("b"),
			makeEntry("c"),
		]);
		expect(manyEntries.ok).toBe(true);
	});

	it("does not invoke any entry's fire closure", async () => {
		const source = createManualTriggerSource();
		const entry = makeEntry("rerun");
		await source.reconfigure("t0", "r0", [entry]);
		await source.reconfigure("t0", "r0", []);
		expect(entry.fire).not.toHaveBeenCalled();
	});

	it("reconfigure is scoped across owners independently", async () => {
		const source = createManualTriggerSource();
		const a = await source.reconfigure("acme", "r0", [makeEntry("rerun")]);
		const b = await source.reconfigure("globex", "r0", [
			makeEntry("reprocess"),
		]);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
	});
});
