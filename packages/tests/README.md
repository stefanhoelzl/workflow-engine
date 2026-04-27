# @workflow-engine/tests

End-to-end test framework. Spawns the assembled runtime as a real Node.js
subprocess and drives it through a frozen chain DSL.

## Running

```
pnpm test:e2e
```

## Playwright (browser tests)

The framework launches chromium for tests that use `.browser(...)`. On a
fresh checkout, install the chromium binary once:

```
pnpm exec playwright install chromium
```

CI handles this automatically (`.github/workflows/ci.yml`).
