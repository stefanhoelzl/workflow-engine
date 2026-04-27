import type { MockCapture, MockClient } from "../types.js";

const DEFAULT_WAIT_HARDCAP_MS = 5000;

interface MockClientOpts {
	adminUrl: string;
}

function describeNetworkError(
	adminUrl: string,
	op: string,
	err: unknown,
): Error {
	const code = (err as NodeJS.ErrnoException).code;
	if (code === "ECONNREFUSED") {
		return new Error(
			`MockClient.${op}: ECONNREFUSED at ${adminUrl} — admin server not reachable; was globalSetup wired and was the mock booted?`,
		);
	}
	const msg = err instanceof Error ? err.message : String(err);
	return new Error(`MockClient.${op}: ${msg}`);
}

function createMockClient<TCapture extends MockCapture>(
	opts: MockClientOpts,
): MockClient<TCapture> {
	async function captures(o?: {
		slug?: string;
		since?: number;
	}): Promise<readonly TCapture[]> {
		const url = new URL("/captures", opts.adminUrl);
		if (o?.slug !== undefined) {
			url.searchParams.set("slug", o.slug);
		}
		if (o?.since !== undefined) {
			url.searchParams.set("since", String(o.since));
		}
		try {
			const res = await fetch(url);
			if (!res.ok) {
				throw new Error(`status ${String(res.status)}`);
			}
			return (await res.json()) as readonly TCapture[];
		} catch (err) {
			throw describeNetworkError(opts.adminUrl, "captures", err);
		}
	}

	async function reset(slug?: string): Promise<void> {
		const url = new URL("/reset", opts.adminUrl);
		if (slug !== undefined) {
			url.searchParams.set("slug", slug);
		}
		try {
			const res = await fetch(url, { method: "POST" });
			if (!res.ok) {
				throw new Error(`status ${String(res.status)}`);
			}
		} catch (err) {
			throw describeNetworkError(opts.adminUrl, "reset", err);
		}
	}

	async function waitFor(
		predicate: (c: TCapture) => boolean,
		o?: { slug?: string; hardCap?: number },
	): Promise<TCapture> {
		const hardCap = o?.hardCap ?? DEFAULT_WAIT_HARDCAP_MS;
		const url = new URL("/stream", opts.adminUrl);
		const slug = o?.slug;
		if (slug !== undefined) {
			url.searchParams.set("slug", slug);
		}
		const ac = new AbortController();
		const timeout = setTimeout(() => ac.abort(), hardCap);
		try {
			const res = await fetch(url, { signal: ac.signal });
			if (!(res.ok && res.body)) {
				throw new Error(`status ${String(res.status)}`);
			}
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buf = "";
			while (true) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				buf += decoder.decode(value, { stream: true });
				let sep = buf.indexOf("\n\n");
				while (sep >= 0) {
					const frame = buf.slice(0, sep);
					buf = buf.slice(sep + 2);
					const data = frame
						.split("\n")
						.filter((l) => l.startsWith("data: "))
						.map((l) => l.slice(6))
						.join("");
					if (data) {
						const capture = JSON.parse(data) as TCapture;
						if (predicate(capture)) {
							ac.abort();
							return capture;
						}
					}
					sep = buf.indexOf("\n\n");
				}
			}
			throw new Error("stream ended without a matching capture");
		} catch (err) {
			if (ac.signal.aborted && !(err as Error)?.message?.includes("matching")) {
				throw new Error(
					`MockClient.waitFor: timed out after ${String(hardCap)}ms (slug=${String(slug)})`,
				);
			}
			throw describeNetworkError(opts.adminUrl, "waitFor", err);
		} finally {
			clearTimeout(timeout);
		}
	}

	return { captures, waitFor, reset };
}

export type { MockClientOpts };
export { createMockClient };
