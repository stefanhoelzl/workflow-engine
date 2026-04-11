import type { QuickJSHandle } from "quickjs-emscripten";
import type { Bridge } from "./bridge-factory.js";

function toBuffer(data: unknown): ArrayBuffer {
	return new Uint8Array(data as number[]).buffer as ArrayBuffer;
}

function fromBuffer(buf: ArrayBuffer): number[] {
	return Array.from(new Uint8Array(buf));
}

function resolveAlgo(algo: unknown, deref: <T>(ref: unknown) => T): unknown {
	if (typeof algo !== "object" || algo === null) {
		return algo;
	}
	const result = { ...(algo as Record<string, unknown>) };
	for (const key of [
		"iv",
		"counter",
		"salt",
		"info",
		"label",
		"additionalData",
	]) {
		if (Array.isArray(result[key])) {
			result[key] = toBuffer(result[key]);
		}
	}
	if (
		typeof result.public === "object" &&
		result.public !== null &&
		"__opaqueId" in (result.public as Record<string, unknown>)
	) {
		result.public = deref<CryptoKey>(result.public);
	}
	return result;
}

function marshalCryptoKey(b: Bridge, key: CryptoKey): QuickJSHandle {
	const id = b.storeOpaque(key);
	const algoJson = JSON.stringify(key.algorithm, (_k, v) =>
		v instanceof Uint8Array ? Array.from(v) : v,
	);
	const obj = `Object.freeze({type:${JSON.stringify(key.type)},algorithm:${algoJson},extractable:${key.extractable},usages:${JSON.stringify(Array.from(key.usages))},__opaqueId:${id}})`;
	const result = b.vm.evalCode(`(${obj})`);
	if (result.error) {
		result.error.dispose();
		throw new Error("Failed to marshal CryptoKey");
	}
	return result.value;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: all crypto.subtle bridges registered together sharing helpers and bridge instance
function setupCrypto(b: Bridge): void {
	const cryptoObj = b.vm.newObject();
	const subtleObj = b.vm.newObject();

	// --- crypto.subtle methods ---

	b.async(subtleObj, "digest", {
		method: "crypto.subtle.digest",
		args: [b.arg.json, b.arg.json],
		marshal: b.marshal.json,
		impl: async (algo, data) => {
			const result = await crypto.subtle.digest(
				algo as AlgorithmIdentifier,
				toBuffer(data),
			);
			return fromBuffer(result);
		},
	});

	b.async(subtleObj, "importKey", {
		method: "crypto.subtle.importKey",
		args: [b.arg.string, b.arg.json, b.arg.json, b.arg.boolean, b.arg.json],
		marshal: (key: CryptoKey) => marshalCryptoKey(b, key),
		// biome-ignore lint/complexity/useMaxParams: mirrors WebCrypto importKey(format, keyData, algo, extractable, usages)
		impl: async (format, keyData, algo, extractable, usages) => {
			if (format === "jwk") {
				return await crypto.subtle.importKey(
					"jwk",
					keyData as JsonWebKey,
					algo as Algorithm,
					extractable as boolean,
					usages as KeyUsage[],
				);
			}
			return await crypto.subtle.importKey(
				format as "raw" | "pkcs8" | "spki",
				toBuffer(keyData),
				algo as Algorithm,
				extractable as boolean,
				usages as KeyUsage[],
			);
		},
	});

	b.async(subtleObj, "exportKey", {
		method: "crypto.subtle.exportKey",
		args: [b.arg.string, b.arg.json],
		marshal: b.marshal.json,
		impl: async (format, keyRef) => {
			const key = b.derefOpaque<CryptoKey>(keyRef);
			const result = await crypto.subtle.exportKey(format as KeyFormat, key);
			if (result instanceof ArrayBuffer) {
				return fromBuffer(result);
			}
			return result;
		},
	});

	b.async(subtleObj, "sign", {
		method: "crypto.subtle.sign",
		args: [b.arg.json, b.arg.json, b.arg.json],
		marshal: b.marshal.json,
		impl: async (algo, keyRef, data) => {
			const key = b.derefOpaque<CryptoKey>(keyRef);
			const result = await crypto.subtle.sign(
				algo as AlgorithmIdentifier,
				key,
				toBuffer(data),
			);
			return fromBuffer(result);
		},
	});

	b.async(subtleObj, "verify", {
		method: "crypto.subtle.verify",
		args: [b.arg.json, b.arg.json, b.arg.json, b.arg.json],
		marshal: b.marshal.boolean,
		impl: async (algo, keyRef, signature, data) => {
			const key = b.derefOpaque<CryptoKey>(keyRef);
			return await crypto.subtle.verify(
				algo as AlgorithmIdentifier,
				key,
				toBuffer(signature),
				toBuffer(data),
			);
		},
	});

	b.async(subtleObj, "encrypt", {
		method: "crypto.subtle.encrypt",
		args: [b.arg.json, b.arg.json, b.arg.json],
		marshal: b.marshal.json,
		impl: async (algo, keyRef, data) => {
			const key = b.derefOpaque<CryptoKey>(keyRef);
			const resolved = resolveAlgo(algo, b.derefOpaque);
			const result = await crypto.subtle.encrypt(
				resolved as Algorithm,
				key,
				toBuffer(data),
			);
			return fromBuffer(result);
		},
	});

	b.async(subtleObj, "decrypt", {
		method: "crypto.subtle.decrypt",
		args: [b.arg.json, b.arg.json, b.arg.json],
		marshal: b.marshal.json,
		impl: async (algo, keyRef, data) => {
			const key = b.derefOpaque<CryptoKey>(keyRef);
			const resolved = resolveAlgo(algo, b.derefOpaque);
			const result = await crypto.subtle.decrypt(
				resolved as Algorithm,
				key,
				toBuffer(data),
			);
			return fromBuffer(result);
		},
	});

	b.async(subtleObj, "generateKey", {
		method: "crypto.subtle.generateKey",
		args: [b.arg.json, b.arg.boolean, b.arg.json],
		marshal: (result: CryptoKey | CryptoKeyPair) => {
			if ("publicKey" in result && "privateKey" in result) {
				const obj = b.vm.newObject();
				const pubHandle = marshalCryptoKey(b, result.publicKey);
				b.vm.setProp(obj, "publicKey", pubHandle);
				pubHandle.dispose();
				const privHandle = marshalCryptoKey(b, result.privateKey);
				b.vm.setProp(obj, "privateKey", privHandle);
				privHandle.dispose();
				return obj;
			}
			return marshalCryptoKey(b, result as CryptoKey);
		},
		impl: async (algo, extractable, usages) =>
			crypto.subtle.generateKey(
				algo as Algorithm,
				extractable as boolean,
				usages as KeyUsage[],
			),
	});

	b.async(subtleObj, "deriveBits", {
		method: "crypto.subtle.deriveBits",
		args: [b.arg.json, b.arg.json, b.arg.json],
		marshal: b.marshal.json,
		impl: async (algo, baseKeyRef, length) => {
			const baseKey = b.derefOpaque<CryptoKey>(baseKeyRef);
			const resolved = resolveAlgo(algo, b.derefOpaque);
			const result = await crypto.subtle.deriveBits(
				resolved as Algorithm,
				baseKey,
				length as number,
			);
			return fromBuffer(result);
		},
	});

	b.async(subtleObj, "deriveKey", {
		method: "crypto.subtle.deriveKey",
		args: [b.arg.json, b.arg.json, b.arg.json, b.arg.boolean, b.arg.json],
		marshal: (key: CryptoKey) => marshalCryptoKey(b, key),
		// biome-ignore lint/complexity/useMaxParams: mirrors WebCrypto deriveKey(algo, baseKey, derivedKeyType, extractable, usages)
		impl: async (algo, baseKeyRef, derivedKeyType, extractable, usages) => {
			const baseKey = b.derefOpaque<CryptoKey>(baseKeyRef);
			const resolved = resolveAlgo(algo, b.derefOpaque);
			return await crypto.subtle.deriveKey(
				resolved as Algorithm,
				baseKey,
				derivedKeyType as Algorithm,
				extractable as boolean,
				usages as KeyUsage[],
			);
		},
	});

	b.async(subtleObj, "wrapKey", {
		method: "crypto.subtle.wrapKey",
		args: [b.arg.string, b.arg.json, b.arg.json, b.arg.json],
		marshal: b.marshal.json,
		impl: async (format, keyRef, wrappingKeyRef, wrapAlgo) => {
			const key = b.derefOpaque<CryptoKey>(keyRef);
			const wrappingKey = b.derefOpaque<CryptoKey>(wrappingKeyRef);
			const resolved = resolveAlgo(wrapAlgo, b.derefOpaque);
			const result = await crypto.subtle.wrapKey(
				format as KeyFormat,
				key,
				wrappingKey,
				resolved as Algorithm,
			);
			return fromBuffer(result);
		},
	});

	b.async(subtleObj, "unwrapKey", {
		method: "crypto.subtle.unwrapKey",
		args: [
			b.arg.string,
			b.arg.json,
			b.arg.json,
			b.arg.json,
			b.arg.json,
			b.arg.boolean,
			b.arg.json,
		],
		marshal: (key: CryptoKey) => marshalCryptoKey(b, key),
		// biome-ignore lint/complexity/useMaxParams: mirrors WebCrypto unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgo, unwrappedKeyAlgo, extractable, usages)
		impl: async (
			format,
			wrappedKey,
			unwrappingKeyRef,
			unwrapAlgo,
			unwrappedKeyAlgo,
			extractable,
			usages,
		) => {
			const unwrappingKey = b.derefOpaque<CryptoKey>(unwrappingKeyRef);
			const resolvedUnwrapAlgo = resolveAlgo(unwrapAlgo, b.derefOpaque);
			return await crypto.subtle.unwrapKey(
				format as KeyFormat,
				toBuffer(wrappedKey),
				unwrappingKey,
				resolvedUnwrapAlgo as Algorithm,
				unwrappedKeyAlgo as Algorithm,
				extractable as boolean,
				usages as KeyUsage[],
			);
		},
	});

	b.vm.setProp(cryptoObj, "subtle", subtleObj);
	subtleObj.dispose();

	// --- crypto top-level methods ---

	b.sync(cryptoObj, "randomUUID", {
		args: [],
		marshal: b.marshal.string,
		impl: () => crypto.randomUUID(),
	});

	b.sync(cryptoObj, "getRandomValues", {
		args: [b.arg.json],
		marshal: b.marshal.json,
		impl: (typedArray) => {
			const arr = new Uint8Array(typedArray as number[]);
			crypto.getRandomValues(arr);
			return Array.from(arr);
		},
	});

	b.vm.setProp(b.vm.global, "crypto", cryptoObj);
	cryptoObj.dispose();
}

export { setupCrypto };
