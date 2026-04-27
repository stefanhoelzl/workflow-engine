import { inject } from "vitest";
import "./mocks/provided.js";

interface EchoApi {
	// Plain mock origin (`http://127.0.0.1:<port>`) — runtime-facing.
	readonly url: string;
	// Admin-protocol origin — `MockClient` consumers talk to this.
	readonly adminUrl: string;
	// Build a URL the spawned runtime fetches that, if it ever reached the
	// echo mock, would land in the slug bucket. Encapsulates the mock's
	// "first path segment is slug" convention so tests don't hand-concat.
	urlFor(slug: string, ...path: string[]): string;
}

interface MocksApi {
	readonly echo: EchoApi;
}

function getMocks(): MocksApi {
	const provided = inject("mocks");
	const url = provided.echo.url;
	return {
		echo: {
			url,
			adminUrl: provided.echo.adminUrl,
			urlFor(slug, ...path) {
				const tail = path.length === 0 ? "" : `/${path.join("/")}`;
				return `${url}/${slug}${tail}`;
			},
		},
	};
}

export type { EchoApi, MocksApi };
export { getMocks };
