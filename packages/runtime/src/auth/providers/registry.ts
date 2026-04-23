import type {
	AuthProvider,
	AuthProviderFactory,
	ProviderRouteDeps,
} from "./types.js";

interface ProviderRegistry {
	readonly providers: readonly AuthProvider[];
	byId(id: string): AuthProvider | undefined;
}

function splitTopLevel(raw: string): string[] {
	const out: string[] = [];
	for (const seg of raw.split(",")) {
		const trimmed = seg.trim();
		if (trimmed !== "") {
			out.push(trimmed);
		}
	}
	return out;
}

function splitFirstColon(entry: string): [string, string] {
	const idx = entry.indexOf(":");
	if (idx < 0) {
		return [entry, ""];
	}
	return [entry.slice(0, idx), entry.slice(idx + 1)];
}

function buildRegistry(
	rawAuthAllow: string | undefined,
	factories: readonly AuthProviderFactory[],
	deps: ProviderRouteDeps,
): ProviderRegistry {
	const factoryById = new Map<string, AuthProviderFactory>();
	for (const f of factories) {
		factoryById.set(f.id, f);
	}

	const buckets = new Map<string, string[]>();
	const order: string[] = [];

	const entries = splitTopLevel(rawAuthAllow ?? "");
	for (const entry of entries) {
		const [id, rest] = splitFirstColon(entry);
		if (!factoryById.has(id)) {
			throw new Error(`unknown provider "${id}"`);
		}
		let bucket = buckets.get(id);
		if (!bucket) {
			bucket = [];
			buckets.set(id, bucket);
			order.push(id);
		}
		bucket.push(rest);
	}

	const providers: AuthProvider[] = [];
	const providerById = new Map<string, AuthProvider>();
	for (const id of order) {
		const factory = factoryById.get(id);
		if (!factory) {
			throw new Error(`unknown provider "${id}"`);
		}
		const bucket = buckets.get(id) ?? [];
		const provider = factory.create(bucket, deps);
		providers.push(provider);
		providerById.set(id, provider);
	}

	return {
		providers,
		byId: (id) => providerById.get(id),
	};
}

export type { ProviderRegistry };
export { buildRegistry };
