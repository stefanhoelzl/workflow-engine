const TRAILING_SLASHES = /\/+$/;

interface PublicKeyResponse {
	algorithm: string;
	publicKey: string;
	keyId: string;
}

interface SealAuth {
	readonly user?: string | undefined;
	readonly token?: string | undefined;
}

class PublicKeyFetchError extends Error {
	readonly status: number | "network-error";
	constructor(message: string, status: number | "network-error") {
		super(message);
		// biome-ignore lint/security/noSecrets: error class name, no secret material
		this.name = "PublicKeyFetchError";
		this.status = status;
	}
}

async function fetchPublicKey(
	url: string,
	owner: string,
	auth: SealAuth,
): Promise<PublicKeyResponse> {
	const endpoint = `${url.replace(
		TRAILING_SLASHES,
		"",
	)}/api/workflows/${owner}/public-key`;
	const headers: Record<string, string> = {};
	if (auth.user) {
		headers["X-Auth-Provider"] = "local";
		headers.Authorization = `User ${auth.user}`;
	} else if (auth.token) {
		headers["X-Auth-Provider"] = "github";
		headers.Authorization = `Bearer ${auth.token}`;
	}
	let response: Response;
	try {
		response = await fetch(endpoint, { headers });
	} catch (err) {
		throw new PublicKeyFetchError(
			`public-key fetch failed: ${err instanceof Error ? err.message : String(err)}`,
			"network-error",
		);
	}
	if (!response.ok) {
		throw new PublicKeyFetchError(
			`public-key fetch returned ${String(response.status)} ${response.statusText}`,
			response.status,
		);
	}
	const body = (await response.json()) as PublicKeyResponse;
	if (
		body.algorithm !== "x25519" ||
		typeof body.publicKey !== "string" ||
		typeof body.keyId !== "string"
	) {
		throw new PublicKeyFetchError(
			`public-key response shape is unexpected: ${JSON.stringify(body)}`,
			response.status,
		);
	}
	return body;
}

export type { PublicKeyResponse, SealAuth };
export { fetchPublicKey, PublicKeyFetchError };
