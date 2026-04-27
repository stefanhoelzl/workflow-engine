import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { MockCapture } from "../types.js";
import type { Mock, MockHandle } from "./types.js";

// Live SSE subscribers keyed by slug-or-"". Each holds a `write` callback
// the server invokes per matching capture.
interface Subscriber<TCapture extends MockCapture> {
	slug: string | undefined;
	write(capture: TCapture): void;
}

// Wires a uniform admin HTTP layer around any `Mock` implementation.
// Routes:
//   GET  /captures?slug=<slug>&since=<ts>   → application/json [TCapture]
//   GET  /stream?slug=<slug>                 → text/event-stream (replay + live)
//   POST /reset?slug=<slug>                  → 204
async function createMockServer<TCapture extends MockCapture, TConn>(
	mock: Mock<TCapture, TConn>,
): Promise<MockHandle<TCapture, TConn>> {
	const captures: TCapture[] = [];
	const subscribers = new Set<Subscriber<TCapture>>();

	function record(capture: TCapture): void {
		captures.push(capture);
		for (const sub of subscribers) {
			if (sub.slug !== undefined && sub.slug !== capture.slug) {
				continue;
			}
			sub.write(capture);
		}
	}

	const conn = await mock.start(record);

	function filter(slug: string | undefined, since: number): TCapture[] {
		return captures.filter((c) => {
			if (slug !== undefined && c.slug !== slug) {
				return false;
			}
			if (c.ts < since) {
				return false;
			}
			return true;
		});
	}

	function handleCaptures(
		_req: IncomingMessage,
		res: ServerResponse,
		url: URL,
	): void {
		const slug = url.searchParams.get("slug") ?? undefined;
		const sinceRaw = url.searchParams.get("since");
		const since = sinceRaw ? Number(sinceRaw) : 0;
		const matched = filter(slug, Number.isFinite(since) ? since : 0);
		res.statusCode = 200;
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(matched));
	}

	function handleStream(
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
	): void {
		const slug = url.searchParams.get("slug") ?? undefined;
		res.statusCode = 200;
		res.setHeader("content-type", "text/event-stream");
		res.setHeader("cache-control", "no-cache");
		res.setHeader("connection", "keep-alive");
		res.flushHeaders?.();

		const write = (capture: TCapture): void => {
			res.write(`data: ${JSON.stringify(capture)}\n\n`);
		};

		// Replay backlog matching the slug filter.
		for (const capture of filter(slug, 0)) {
			write(capture);
		}

		const sub: Subscriber<TCapture> = { slug, write };
		subscribers.add(sub);
		req.on("close", () => {
			subscribers.delete(sub);
		});
	}

	function handleReset(
		_req: IncomingMessage,
		res: ServerResponse,
		url: URL,
	): void {
		const slug = url.searchParams.get("slug") ?? undefined;
		if (slug === undefined) {
			captures.length = 0;
		} else {
			for (let i = captures.length - 1; i >= 0; i--) {
				if (captures[i]?.slug === slug) {
					captures.splice(i, 1);
				}
			}
		}
		res.statusCode = 204;
		res.end();
	}

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "GET" && url.pathname === "/captures") {
			handleCaptures(req, res, url);
			return;
		}
		if (req.method === "GET" && url.pathname === "/stream") {
			handleStream(req, res, url);
			return;
		}
		if (req.method === "POST" && url.pathname === "/reset") {
			handleReset(req, res, url);
			return;
		}
		res.statusCode = 404;
		res.end();
	});

	await new Promise<void>((res) => {
		server.listen(0, "127.0.0.1", () => res());
	});
	const addr = server.address() as AddressInfo;
	const adminUrl = `http://127.0.0.1:${String(addr.port)}`;

	async function stop(): Promise<void> {
		for (const sub of subscribers) {
			sub.write = () => {};
		}
		subscribers.clear();
		await new Promise<void>((res, rej) => {
			server.close((err) => (err ? rej(err) : res()));
		});
		await mock.stop();
	}

	return { conn, adminUrl, stop };
}

export { createMockServer };
