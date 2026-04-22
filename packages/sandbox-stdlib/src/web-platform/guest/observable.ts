// WICG Observable polyfill — provides Observable + Subscriber and patches
// EventTarget.prototype.when via observable-polyfill@^0.0.29 (MIT, keithamus;
// referenced by WICG/observable#107 as the canonical implementation).
//
// Host surface: none. The upstream polyfill layers on queueMicrotask + the
// already-allowlisted AbortController/AbortSignal. See SECURITY.md §2.
//
// Force-applies via the `/fn` entry so install is deterministic regardless of
// upstream host-feature detection; upstream's isBrowserContext() short-circuits
// to false here because globalThis.Window is undefined (destructured on module
// load) and is never a browser context.

import { apply } from "observable-polyfill/fn";

apply();
