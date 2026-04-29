---
description: Start pnpm dev on a random port and open the given path in Simple Browser
allowed-tools: Bash(pnpm:*), Bash(grep:*), Bash(for:*), Bash(sleep:*), Bash(tail:*), mcp__codehydra__workspace_execute_command
---

# /preview Command

Boot `pnpm dev` on a random port and open a given path in the VS Code Simple Browser.

## Arguments

$ARGUMENTS

- Required: a path like `dashboard`, `/trigger`, or `/dashboard/local/demo`. A leading `/` is optional.
- If empty: ABORT with `Usage: /preview <path>` (e.g. `/preview dashboard`).

## Execution

### 1. Normalise the path

- Strip a leading `/` if present, then prepend exactly one `/`. Result is `<path>`.

### 2. Start the dev server

Launch in the background:

```bash
pnpm dev --random-port --kill
```

Use `run_in_background: true` so the agent owns the process tree. Capture the output file id.

### 3. Wait for ready marker

Poll the output file (up to ~120s) for the line:

```
Dev ready on http://localhost:<port> (tenant=dev)
```

Parse `<port>` from that line. The literal `tenant=dev` is legacy — actual upload owner is `local`.

If the marker never appears: ABORT with the last 20 lines of the output file.

### 4. Open in Simple Browser

Call `mcp__codehydra__workspace_execute_command` with:

- `command`: `simpleBrowser.show`
- `args`: `["http://localhost:<port><path>"]`

### 5. Report

```
Preview ready: http://localhost:<port><path>
```
