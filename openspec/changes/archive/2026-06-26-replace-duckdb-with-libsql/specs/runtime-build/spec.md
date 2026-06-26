## MODIFIED Requirements

### Requirement: Native-binding externalization

The runtime Vite config SHALL list every package whose distribution carries a native binding in `ssr.external` so those packages remain as external references in the output bundle rather than being inlined. The current external list SHALL include `@libsql/client` (the libSQL native client binding) and `@jitl/quickjs-wasmfile-release-sync` (the WASI artifact bundled behind `quickjs-wasi`). Adding a new dependency with a native binding SHALL require extending this list; failing to externalize a native binding SHALL cause the runtime to fail at boot with a missing-binding error.

#### Scenario: libSQL native binding stays external

- **WHEN** `packages/runtime/dist/main.js` is inspected
- **THEN** it SHALL contain an external reference to `@libsql/client`
- **AND** it SHALL NOT inline the binding's JS wrapper

#### Scenario: QuickJS WASI artifact stays external

- **WHEN** `packages/runtime/dist/main.js` is inspected
- **THEN** it SHALL contain an external reference to `@jitl/quickjs-wasmfile-release-sync`
