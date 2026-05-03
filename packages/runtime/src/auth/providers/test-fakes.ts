import { vi } from "vitest";

interface FakeGitHubOpts {
	readonly user?: { login: string; email: string | null };
	readonly orgs?: ReadonlyArray<{ login: string }>;
	readonly tokenStatus?: number;
	readonly userStatus?: number;
	readonly orgsStatus?: number;
	readonly accessToken?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

// vi.fn shaped as `typeof globalThis.fetch` covering the GitHub OAuth surface
// the provider talks to: `/login/oauth/access_token`, `/user`, `/user/orgs`.
// All status codes default to 200; opts.{tokenStatus,userStatus,orgsStatus}
// override per-endpoint.
function createFakeGitHubFetch(opts: FakeGitHubOpts = {}) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = input.toString();
		if (url.endsWith("/login/oauth/access_token")) {
			if (opts.tokenStatus && opts.tokenStatus >= 400) {
				return jsonResponse({}, opts.tokenStatus);
			}
			return jsonResponse({ access_token: opts.accessToken ?? "gho_xxx" });
		}
		if (url.endsWith("/user/orgs")) {
			return jsonResponse(opts.orgs ?? [], opts.orgsStatus ?? 200);
		}
		if (url.endsWith("/user")) {
			return jsonResponse(
				opts.user ?? { login: "alice", email: null },
				opts.userStatus ?? 200,
			);
		}
		return jsonResponse({}, 404);
	});
}

export type { FakeGitHubOpts };
export { createFakeGitHubFetch };
