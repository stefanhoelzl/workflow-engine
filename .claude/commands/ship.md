---
description: Create PR with auto-merge, wait for merge via client-side queue
allowed-tools: Bash(git:*), Bash(gh:*), Bash(pnpm:*), mcp__codehydra__workspace_delete
---

# /ship Command

Ship the current branch by creating a PR with auto-merge and waiting for it to merge.

## Arguments

$ARGUMENTS

- Empty: Auto-generate PR title and summary from commits
- `feat` or `fix`: User-facing change. Agent proposes a PR title, user reviews.
- `feat(<title>)` or `fix(<title>)`: User-facing change with explicit PR title.
- `internal`: Internal change (no changelog entry). Skips user-facing detection.
- `--keep-workspace`: Keep workspace after successful merge (default: delete)
- `--resolves <issue>`: Link PR to a GitHub issue
  - `--resolves #123` or `--resolves 123`: Links to issue #123
  - `--resolves ?`: List all open issues and prompt for selection

## Execution

You are a BUILD AUTOMATION agent. Execute the workflow below. On FAILED or TIMEOUT,
return immediately with a report - do NOT attempt to diagnose or fix issues.

### 0. Derive repo and default branch

Parse the GitHub repo from the git remote:

```bash
git remote get-url origin
```

Extract `<owner>/<repo>` from the URL (handles both HTTPS and SSH formats).
Use this as `<repo>` in all subsequent `gh` commands.

Detect the default branch:

```bash
gh repo view <repo> --json defaultBranchRef --jq '.defaultBranchRef.name'
```

Use this as `<default-branch>` in all subsequent commands.

### 1. Validate preconditions

**1.1. Check for uncommitted changes:**

```bash
git status --porcelain
```

If output is non-empty: ABORT with:

```
Cannot ship with uncommitted changes.

**Uncommitted files:**
<list of files>

Commit your changes first, then run `/ship` again.
```

**1.2. Check we're not on default branch:**

```bash
git branch --show-current
```

If on `<default-branch>`: ABORT with "Cannot ship from <default-branch> branch"

**1.3. Check for un-archived openspec changes:**

```bash
pnpm exec openspec list --json
```

If the command fails: ABORT with "openspec list failed. Ensure openspec is installed and working."

If the JSON array is non-empty: ABORT with:

```
Cannot ship with un-archived openspec changes:
  - <change-name>
  - <change-name>

Archive them before shipping.
```

### 2. Rebase onto default branch

```bash
git fetch origin <default-branch>
git rebase origin/<default-branch>
```

If rebase fails: ABORT with:

```
Rebase onto <default-branch> failed (conflicts?).

Resolve conflicts manually, then run `/ship` again.
```

### 3. Run checks

```bash
pnpm validate
```

If validation fails: ABORT with:

```
Cannot ship: validation failed.

Fix the issues, then commit and run `/ship` again.
```

### 4. Resolve issue selection (if --resolves ? was passed)

If `--resolves ?` was provided:

1. Fetch open issues:

   ```bash
   gh issue list --repo <repo> --state open --json number,title --limit 100
   ```

2. If no open issues exist: ABORT with "No open issues found"

3. Display the list to the user:

   ```
   Open issues:

   #<number> <title>
   #<number> <title>
   ...
   ```

4. Ask the user explicitly:

   ```
   Which issue does this PR resolve? Enter the issue number (e.g., 123):
   ```

5. Wait for user response and store the issue number for step 8.

### 5. Check for existing PR (idempotency)

```bash
gh pr list --repo <repo> --head <current-branch> --json number,url,state
```

If a PR already exists for this branch:

- If state is OPEN: skip to step 9 (run ship-wait script)
- If state is MERGED: skip to step 10 (delete workspace) with exit code 0
- If state is CLOSED: continue to create new PR

### 6. Push

```bash
git push --force-with-lease origin HEAD
```

### 7. Create PR

Generate title and summary from commits:

```bash
git log origin/<default-branch>..HEAD --pretty=format:"%s%n%b"
```

Also get the diff for changelog analysis:

```bash
git diff origin/<default-branch>..HEAD
```

#### 7.1. Determine changelog category

A `changelog_category` variable tracks the result: `"feature"`, `"bugfix"`, or `null` (internal).

**If `feat` or `fix` argument was provided:**

Set `changelog_category` to `"feature"` or `"bugfix"` accordingly.

**If `internal` argument was provided:**

Set `changelog_category` to `null` (skip detection and user prompt).

**If no changelog argument was provided:**

Analyze the actual changes (diffs and commit messages) to determine if the changes are user-facing.
User-facing changes include: new features, bug fixes, UX improvements, new configuration options, API changes visible to users.
Internal changes include: refactors, test additions/fixes, documentation, CI/CD, dependency bumps, code style, chore tasks.

- If changes appear **user-facing**: Ask the user via AskUserQuestion: "This looks like a user-facing change. Should it appear in the changelog?" with options:
  - `Feature` — categorize as feature
  - `Bugfix` — categorize as bugfix
  - `No` — skip changelog (internal)
    Set `changelog_category` based on the user's choice (`"feature"`, `"bugfix"`, or `null`).
- If changes appear **purely internal**: set `changelog_category` to `null` (no prompt).

#### 7.2. Determine PR title

**If `changelog_category` is `"feature"` or `"bugfix"`:**

1. Determine the prefix: `feat: ` for feature, `fix: ` for bugfix.
2. If a title was provided in parentheses (e.g., `feat(Add dark mode)`): PR title = `feat: Add dark mode`
3. If no title in parentheses: Analyze the changes and propose 3 concise PR title options via AskUserQuestion (the user can also pick "Other" to enter a custom title). Prepend the appropriate prefix (`feat: ` or `fix: `) to the selected title.

**If `changelog_category` is `null`:**

Determine PR title using the standard convention:

- **PR title**: `<type>(<scope>): <description>` (from primary commit or summarized)

**Commit types (for internal PRs):**

| Type    | Description                                     |
| ------- | ----------------------------------------------- |
| `feat`  | new feature                                     |
| `fix`   | bug fix                                         |
| `docs`  | documentation only                              |
| `chore` | maintenance, deps, config, refactor, formatting |
| `test`  | adding/fixing tests                             |
| `infra` | CI/CD, build system                             |

#### 7.3. Create the PR

- **PR body**: Bullet-point summary of changes
  - If `--resolves <number>` was provided (directly or via `?` selection), append an empty line followed by `resolves #<number>`

**Example PR body with resolves:**

```
- Added feature X
- Fixed bug Y

resolves #123
```

Determine the label from `changelog_category`:

- `"feature"`: `enhancement`
- `"bugfix"`: `bug`
- `null` (internal): `internal`

Create PR with the label included:

```bash
gh pr create --repo <repo> --title "<title>" --label "<label>" --body "<body>"
```

Capture the PR URL and number from output.

### 8. Enable Auto-merge

```bash
gh pr merge --repo <repo> <number> --auto --rebase --delete-branch
```

This:

- Enables auto-merge (will merge when all checks pass and branch is up-to-date)
- Uses **rebase** to maintain linear history
- Sets branch to auto-delete after merge

### 9. Run ship-wait script

```bash
pnpx tsx .claude/commands/ship-wait.ts <repo> <number> <default-branch>
```

The script handles:

- Waiting for PRs ahead in queue (ordered by `autoMergeRequest.enabledAt`; re-enabling auto-merge moves a PR to the back)
- Skipping failed-ahead PRs (CLOSED, merge state DIRTY, or any check with conclusion in {FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED}). Once skipped, always skipped within a run
- Exiting early if our own PR merges or is closed while waiting (polled every iteration)
- Rebasing onto default branch when it's our turn
- Waiting for CI via `gh pr checks --watch`
- Waiting for auto-merge to complete
- Fetching latest default branch from origin

**Exit codes:**

- 0: MERGED
- 1: FAILED
- 2: TIMEOUT

### 10. Delete workspace

If `--keep-workspace` was NOT passed and merge succeeded (exit code 0):

1. Call `mcp__codehydra__workspace_delete` tool with `keepBranch: false`
2. Report: "Workspace deleted."

If `--keep-workspace` was passed, report: "Workspace kept."

## Report Formats

### MERGED (exit code 0)

```
PR merged successfully!

**PR**: <url>
**Commit**: <sha> merged to <default-branch>
**Workspace**: deleted (or "kept" if --keep-workspace)
```

### FAILED (exit code 1)

```
PR failed to merge.

**PR**: <url>
**Reason**: <explanation from script output>

Action required: Fix the issue and run `/ship` again.
```

### TIMEOUT (exit code 2)

```
PR still processing after 15 minutes.

**PR**: <url>
**Status**: <from script output>

Action required: Review the PR status and decide how to proceed.
```
