// Side-effect-free constants. Imported by the sandbox worker, which must not
// pull in zod/ManifestSchema just to learn the IIFE namespace string.
//
// Each sandbox worker evaluates exactly one workflow in an isolated VM, so
// the namespace need not be per-workflow. Plugin, runtime, and sandbox all
// import this single constant to agree on the global that Rollup's IIFE
// output assigns exports to.

export const IIFE_NAMESPACE = "__wfe_exports__";
