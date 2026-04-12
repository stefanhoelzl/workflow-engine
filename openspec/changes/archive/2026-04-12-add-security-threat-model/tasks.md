## 1. Write `/SECURITY.md`

- [x] 1.1 Create `/SECURITY.md` with the §1 header: purpose, audience,
      "How to use this document" checklist, and the trust-boundaries
      overview (ASCII request-flow diagram, surface table, trust-level
      glossary with UNTRUSTED / PUBLIC / AUTHENTICATED / INTERNAL
      definitions).
- [x] 1.2 Write §2 Sandbox Boundary: trust level, entry points (spawn
      signature, exposed globals, bridged host APIs), threats S1–S9,
      current mitigations (fresh context, no Node surface, allowlisted
      globals, JSON-serialized event/env, per-action env scoping, emit
      validation, static analysis), residual risks R-S1–R-S6 with
      status labels (include `R-S4` SSRF gap as high priority), rules
      for AI agents, file references to
      `packages/runtime/src/sandbox/*`, `event-source.ts`, and the
      `action-sandbox` + `context` specs.
- [x] 1.3 Write §3 Webhook Ingress: trust level, entry points
      (`POST /webhooks/{name}`, URLPattern matching, payload shape),
      threats W1–W8, current mitigations (Zod validation, sandbox
      downstream, TLS, deterministic path matching), residual risks
      R-W1–R-W6 (mark `R-W4` verbatim-header forwarding as high
      priority with allowlist recommendation), "Implementation
      guidance for signed webhooks" subsection, rules for AI agents,
      file references to `triggers/http.ts`, `event-source.ts`,
      `routing.tf`, and the `triggers` + `payload-validation` specs.
- [x] 1.4 Write §4 Authentication covering UI and API as sub-surfaces
      (use "UI" as the category name so it covers `/dashboard`,
      `/trigger`, and future authenticated UIs): per-route-family
      entry-point table, threats A1–A11, current mitigations
      (cookie flags, per-deployment cookie secret, user allowlist,
      per-request GitHub validation, TLS, forward-auth integration,
      separate trust domains for UI and API), residual risks
      R-A1–R-A8 with status labels (document `R-A1` as-is since
      remediation is tracked separately; no prescriptive fail-closed
      rule), rules for AI agents, file references to `api/auth.ts`,
      `config.ts`, `api/index.ts`, `ui/dashboard/middleware.ts`,
      `oauth2-proxy.tf`, `routing.tf`, and the `dashboard-auth` +
      `github-auth` + `oauth2-proxy` specs.
- [x] 1.5 Write §5 Infrastructure and Deployment: trust level, entry
      points (exposure table for Traefik, oauth2-proxy, app, S2,
      DuckDB, GitHub API egress), threats I1–I10 (no supply-chain
      threat), current mitigations (K8s Secrets, Terraform
      `sensitive`, distroless non-root image, internal-only Services,
      TLS at Traefik, pinned S2 image), residual risks
      R-I1–R-I5, R-I7–R-I9 with status labels (no R-I6 image-digest
      item), the seven-item "Production deployment notes" checklist
      (NetworkPolicy, pod securityContext, resource limits, real
      TLS, egress policy, encrypted event storage, secret rotation —
      no image-digest pinning), rules for AI agents, file references
      to `infrastructure/modules/**` and the `infrastructure` +
      `routing` specs.

## 2. Update `CLAUDE.md`

- [x] 2.1 Add a "Security Invariants" section below the existing
      "Code Conventions" section. Include a pointer to `/SECURITY.md`
      and the seven hard rules: no new sandbox globals or host
      bridges (§2); no auth on `/webhooks/*` (§3); no new UI route
      without forward-auth (§4); no new `/api/*` route without
      `githubAuthMiddleware` (§4); do not trust `X-Auth-Request-*`
      or `X-Forwarded-*` as authoritative while NetworkPolicy is
      absent (§4/§5); never hardcode or commit secrets (§5); never
      log Authorization headers, cookies, or OAuth secrets (§4).

## 3. Update `openspec/project.md`

- [x] 3.1 Replace the `### Security Model` subsection (currently
      lines 73–83, inside "Domain Context") with a one-line pointer:
      "See `/SECURITY.md` for the authoritative threat model." Do
      not duplicate any content that now lives in `/SECURITY.md`.

## 4. Cross-check and verify

- [x] 4.1 Verify every section reference in CLAUDE.md's Security
      Invariants (§2/§3/§4/§5) matches the final numbering in
      `/SECURITY.md`.
- [x] 4.2 Verify every section reference in the 11 spec deltas
      (`openspec/changes/add-security-threat-model/specs/*/spec.md`)
      matches the final numbering in `/SECURITY.md`.
- [x] 4.3 Walk the file references in each `/SECURITY.md` section and
      confirm every path exists in the repo at the current commit.
      Broken references must be fixed before archiving this change.
- [x] 4.4 Run `pnpm exec openspec validate add-security-threat-model
      --strict` and resolve any issues.
- [x] 4.5 Run `pnpm validate` and resolve any issues. The change
      introduces no code, so this should pass without modification;
      surface any failures as out-of-scope.
