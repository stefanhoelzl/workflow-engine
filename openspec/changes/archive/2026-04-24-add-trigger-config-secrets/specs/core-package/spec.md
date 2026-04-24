## ADDED Requirements

### Requirement: Core package exports the secret-sentinel module

The `@workflow-engine/core` package SHALL export `encodeSentinel` and `SENTINEL_SUBSTRING_RE` from its main entrypoint (`packages/core/src/index.ts`), providing the single source of truth for the `\x00secret:NAME\x00` encoding used to reference workflow secrets in trigger descriptor string fields. The helpers are inlined into `index.ts` (matching the existing convention documented in the `Guest-globals contract` section: the `?sandbox-plugin` esbuild transform resolves `@workflow-engine/core` directly to `index.ts` and does not reliably pick up sibling `.ts` modules).

The exports SHALL be exactly:

- `encodeSentinel(name: string): string` — returns `"\x00secret:" + name + "\x00"`. The `name` SHALL match `/^[A-Za-z_][A-Za-z0-9_]*$/`; otherwise `encodeSentinel` SHALL throw a descriptive `Error`.
- `SENTINEL_SUBSTRING_RE: RegExp` — a global regex equal to `/\x00secret:([A-Za-z_][A-Za-z0-9_]*)\x00/g` capturing the sentinel name in group 1. The regex is suitable for both `String.prototype.replace` and iterating `matchAll`.

All producers (the SDK's build-time env resolver) and consumers (the runtime's main-side trigger-config resolver) SHALL import these from `@workflow-engine/core`. The encoding SHALL NOT be re-implemented elsewhere.

#### Scenario: encodeSentinel returns the canonical byte sequence

- **WHEN** `encodeSentinel("MY_SECRET")` is called
- **THEN** the return SHALL equal the 19-code-unit string starting with `\x00secret:` and ending with `\x00`, containing `MY_SECRET` between

#### Scenario: encodeSentinel rejects invalid names

- **WHEN** `encodeSentinel("has-dash")`, `encodeSentinel("")`, or `encodeSentinel("has space")` is called
- **THEN** the call SHALL throw `Error` with a message identifying the invalid name

#### Scenario: SENTINEL_SUBSTRING_RE matches a whole-value sentinel

- **WHEN** `"\x00secret:TOKEN\x00".match(SENTINEL_SUBSTRING_RE)` is evaluated (via replace or matchAll)
- **THEN** exactly one match SHALL be found with capture group 1 equal to `"TOKEN"`

#### Scenario: SENTINEL_SUBSTRING_RE matches embedded sentinels

- **WHEN** `"Bearer \x00secret:TOKEN\x00 rest".replace(SENTINEL_SUBSTRING_RE, (_, n) => `<${n}>`)` is evaluated
- **THEN** the result SHALL be `"Bearer <TOKEN> rest"`

#### Scenario: SENTINEL_SUBSTRING_RE matches multiple sentinels in one string

- **WHEN** `"\x00secret:A\x00-\x00secret:B\x00".replace(SENTINEL_SUBSTRING_RE, (_, n) => n.toLowerCase())` is evaluated
- **THEN** the result SHALL be `"a-b"`
