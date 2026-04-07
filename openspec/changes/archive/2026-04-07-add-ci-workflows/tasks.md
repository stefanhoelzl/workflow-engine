## 1. CI Workflow

- [x] 1.1 Create `.github/workflows/ci.yml` with `on: pull_request` trigger
- [x] 1.2 Add job with Node.js 24 setup, pnpm install with corepack, and pnpm store caching via `actions/setup-node`
- [x] 1.3 Add sequential steps: `pnpm lint`, `pnpm check`, `pnpm test`, `pnpm build`

## 2. Release Workflow

- [x] 2.1 Create `.github/workflows/release.yml` with `on: push: tags: ['release']` trigger and `contents: write` + `packages: write` permissions
- [x] 2.2 Add checkout step (default SHA) followed by `git push --delete origin release` to remove the reusable tag
- [x] 2.3 Add calver computation step: extract committer date, format as `vYYYY.MM.DD`, check for existing tags with `fetch-tags: true`, append `.N` build number if needed
- [x] 2.4 Add Docker image build and push using `docker/login-action`, `docker/setup-buildx-action`, and `docker/build-push-action` targeting `ghcr.io/${{ github.repository }}` with calver (no `v` prefix) + `latest` tags
- [x] 2.5 Add calver git tag creation and push step (after successful image push)
