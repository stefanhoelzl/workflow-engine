import type { Bridge } from "./bridge-factory.js";

function bridgeHostFetch(
	b: Bridge,
	fetchFn: typeof globalThis.fetch,
	signalProvider: () => AbortSignal | undefined = () => undefined,
): void {
	b.async(b.vm.global, "__hostFetch", {
		method: "xhr.send",
		args: [b.arg.string, b.arg.string, b.arg.json, b.arg.json],
		marshal: b.marshal.json,
		impl: async (method, url, headers, body) => {
			const signal = signalProvider();
			const response = await fetchFn(url, {
				method,
				headers: headers as Record<string, string>,
				body: body as string | null,
				...(signal ? { signal } : {}),
			});
			const responseHeaders: Record<string, string> = {};
			response.headers.forEach((v, k) => {
				responseHeaders[k] = v;
			});
			return {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
				body: await response.text(),
			};
		},
	});
}

export { bridgeHostFetch };
