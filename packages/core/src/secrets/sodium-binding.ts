// File-private libsodium binding. The ONLY `import sodium from
// "libsodium-wrappers"` line in the monorepo. Other files in this directory
// import from here; nothing outside `packages/core/src/secrets/` may import
// this module.
// biome-ignore lint/performance/noBarrelFile: single-symbol file-private re-export — exists solely to centralise the libsodium import so the rest of `secrets/` depends on `./sodium-binding` instead of the npm dep
export { default as sodium } from "libsodium-wrappers";
