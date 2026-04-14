globalThis.self = globalThis;
// `fast-text-encoding` only checks window/global/this — not self — so without
// this alias its IIFE resolves to undefined and TextEncoder fails to install.
globalThis.global = globalThis;
