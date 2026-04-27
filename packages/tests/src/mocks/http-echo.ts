import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpCapture } from "../types.js";
import type { Mock } from "./types.js";

interface HttpEchoConn {
	url: string;
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((res, rej) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
		req.on("error", rej);
	});
}

function parseBody(text: string, contentType: string): unknown {
	if (text.length === 0) {
		return null;
	}
	if (contentType.includes("application/json")) {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}
	return text;
}

// HTTP echo mock — captures any incoming request. Slug is the first path
// segment; everything after is preserved in `url`. Tests fire HTTP from
// the runtime to `<echoUrl>/<slug>/<path>` and read captures filtered by
// slug.
function createHttpEchoMock(): Mock<HttpCapture, HttpEchoConn> {
	let server: Server | null = null;
	let connUrl = "";
	return {
		name: "http-echo",
		async start(record): Promise<HttpEchoConn> {
			server = createServer(async (req, res) => {
				const headers: Record<string, string> = {};
				for (const [k, v] of Object.entries(req.headers)) {
					if (typeof v === "string") {
						headers[k] = v;
					} else if (Array.isArray(v)) {
						headers[k] = v.join(",");
					}
				}
				const text = await readBody(req);
				const url = req.url ?? "/";
				const trimmed = url.startsWith("/") ? url.slice(1) : url;
				const sep = trimmed.indexOf("/");
				const querySep = trimmed.indexOf("?");
				const end = [sep, querySep].filter((i) => i >= 0)[0] ?? trimmed.length;
				const slug = trimmed.slice(0, end) || undefined;
				record({
					ts: Date.now(),
					...(slug === undefined ? {} : { slug }),
					method: req.method ?? "GET",
					url,
					headers,
					body: parseBody(text, headers["content-type"] ?? ""),
				});
				res.statusCode = 200;
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify({ ok: true }));
			});
			await new Promise<void>((res) => {
				server?.listen(0, "127.0.0.1", () => res());
			});
			const addr = server.address() as AddressInfo;
			connUrl = `http://127.0.0.1:${String(addr.port)}`;
			return { url: connUrl };
		},
		async stop(): Promise<void> {
			if (!server) {
				return;
			}
			await new Promise<void>((res, rej) => {
				server?.close((err) => (err ? rej(err) : res()));
			});
			server = null;
		},
	};
}

export type { HttpEchoConn };
export { createHttpEchoMock };
