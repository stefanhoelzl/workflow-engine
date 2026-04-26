// Ambient declarations for the targeted core-js side-effect imports used by
// `entry.ts`. core-js does not ship per-feature module type declarations;
// each `core-js/stable/<feature>` import is a pure side-effect that mutates
// global intrinsics, so an `unknown` module shape is sufficient to satisfy
// `verbatimModuleSyntax` + `noUncheckedSideEffectImports`-adjacent rules.
declare module "core-js/stable/iterator";
declare module "core-js/stable/set";
declare module "core-js/stable/promise/with-resolvers";
declare module "core-js/stable/object/group-by";
declare module "core-js/stable/map/group-by";
declare module "core-js/stable/array/from-async";
declare module "core-js/stable/array-buffer/transfer";
