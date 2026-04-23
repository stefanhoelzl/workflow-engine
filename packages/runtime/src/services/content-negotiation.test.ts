import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { acceptsHtml } from "./content-negotiation.js";

async function resolve(header: string | undefined): Promise<boolean> {
	const app = new Hono();
	let result: boolean | undefined;
	app.get("/", (c) => {
		result = acceptsHtml(c);
		return c.text("");
	});
	const headers = new Headers();
	if (header !== undefined) {
		headers.set("Accept", header);
	}
	await app.request("/", { headers });
	return result ?? false;
}

describe("acceptsHtml", () => {
	it("returns true for plain text/html", async () => {
		expect(await resolve("text/html")).toBe(true);
	});

	it("returns true for browser-style Accept with text/html first", async () => {
		expect(await resolve("text/html,application/xhtml+xml,*/*;q=0.8")).toBe(
			true,
		);
	});

	it("returns true for text/html mixed with other types", async () => {
		expect(await resolve("application/json,text/html")).toBe(true);
	});

	it("returns true for text/html with q-value", async () => {
		expect(await resolve("text/html;q=0.9,application/json")).toBe(true);
	});

	it("returns false for */*", async () => {
		expect(await resolve("*/*")).toBe(false);
	});

	it("returns false for application/json", async () => {
		expect(await resolve("application/json")).toBe(false);
	});

	it("returns false for text/css", async () => {
		expect(await resolve("text/css,*/*;q=0.1")).toBe(false);
	});

	it("returns false when Accept header is absent", async () => {
		expect(await resolve(undefined)).toBe(false);
	});

	it("returns false for empty Accept header", async () => {
		expect(await resolve("")).toBe(false);
	});
});
