## 1. SDK Type Infrastructure

- [x] 1.1 Add `ExtractParams<Path>` template literal type that extracts `:param` and `*wildcard` names from a path string, with `Record<string, string>` fallback for non-literal strings
- [x] 1.2 Update `HttpTriggerInput` to accept optional `params` Zod schema with compile-time key enforcement against `ExtractParams<Path>`
- [x] 1.3 Update `HttpPayloadSchema` type to include `params` field derived from path or explicit schema
- [x] 1.4 Update `http()` function to build the params Zod schema (from explicit schema or default `z.object({})`) and include it in the returned trigger schema
- [x] 1.5 Add type-level tests: single param, multiple params, wildcard, static path, non-literal fallback, mismatched params schema error

## 2. Manifest Schema

- [x] 2.1 Add `params: z.array(z.string())` to the trigger entry in `ManifestSchema`
- [x] 2.2 Update `TriggerConfig` interface to include `params: string[]`
- [x] 2.3 Update Vite plugin / build output to extract param names from trigger paths and include `params` array in manifest trigger entries
- [x] 2.4 Add tests: static path produces `params: []`, parameterized path produces correct param names, wildcard produces correct name

## 3. Runtime Registry

- [x] 3.1 Rewrite `HttpTriggerRegistry` to compile trigger paths into `URLPattern` instances at registration time
- [x] 3.2 Update `lookup()` to match via `URLPattern.exec()` and return extracted `params` alongside the trigger
- [x] 3.3 Implement static-over-parameterized priority: iterate static triggers first, then parameterized
- [x] 3.4 Update `HttpTriggerResolved` type and `lookup()` return type to include `params: Record<string, string>`
- [x] 3.5 Add tests: static match, named param extraction, multiple params, wildcard extraction, no match, wrong method, static-over-parameterized priority

## 4. Middleware Integration

- [x] 4.1 Update `httpTriggerMiddleware` to read `params` from `lookup()` result and merge into payload as `{ body, headers, url, method, params }`
- [x] 4.2 Add tests: parameterized trigger produces payload with params, static trigger produces payload with `params: {}`, params validation failure returns 422

## 5. Validation

- [x] 5.1 Run `pnpm validate` (lint, format, type check, tests) and fix any issues
- [x] 5.2 Verify existing workflow definitions still compile and work unchanged (backward compatibility)
