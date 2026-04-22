// fake-indexeddb polyfill — in-memory IDB per sandbox invocation.
// State lives in the module singleton; each QuickJS VM gets a fresh eval, so
// databases never outlive one sandbox run (no persistence, no host bridge).
//
// No prototype-chain widening for `instanceof Event` / `EventTarget`:
// event-target-shim's Event.prototype defines getter-only `type` / `target` /
// `currentTarget`, so retargeting FakeEvent.prototype to it makes FakeEvent's
// constructor throw when it assigns `this.type = ...`. Subtests that assert
// `evt instanceof Event` must stay in skip.ts.

import idb, {
	IDBCursor,
	IDBCursorWithValue,
	IDBDatabase,
	IDBFactory,
	IDBIndex,
	IDBKeyRange,
	IDBObjectStore,
	IDBOpenDBRequest,
	IDBRequest,
	IDBTransaction,
	IDBVersionChangeEvent,
} from "fake-indexeddb";

function install(name: string, value: unknown): void {
	Object.defineProperty(globalThis, name, {
		value,
		writable: true,
		configurable: true,
		enumerable: true,
	});
}

install("indexedDB", idb);
// fake-indexeddb names every class `FDB<Name>`; rewrite the prefix to `IDB<Name>`
// to match the WebIDL interface names that guest code expects on globalThis.
for (const ctor of [
	IDBFactory,
	IDBDatabase,
	IDBTransaction,
	IDBObjectStore,
	IDBIndex,
	IDBCursor,
	IDBCursorWithValue,
	IDBKeyRange,
	IDBRequest,
	IDBOpenDBRequest,
	IDBVersionChangeEvent,
]) {
	install(`IDB${ctor.name.slice(3)}`, ctor);
}
