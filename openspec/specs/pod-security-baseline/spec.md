### Requirement: Baseline module creates workload namespaces

The `modules/baseline/` module SHALL accept a `namespaces` variable of type `list(string)` and create a `kubernetes_namespace_v1` resource for each entry. Each namespace SHALL carry the label `pod-security.kubernetes.io/enforce=restricted` (or `warn` during rollout).

#### Scenario: Namespaces created with PSA label

- **WHEN** the baseline module is applied with `namespaces = ["prod", "staging"]`
- **THEN** namespace `prod` SHALL exist with label `pod-security.kubernetes.io/enforce=restricted`
- **AND** namespace `staging` SHALL exist with label `pod-security.kubernetes.io/enforce=restricted`

#### Scenario: Single namespace for local env

- **WHEN** the baseline module is applied with `namespaces = ["workflow-engine"]`
- **THEN** namespace `workflow-engine` SHALL exist with the PSA enforcement label

### Requirement: Baseline module creates default-deny NetworkPolicy per namespace

The baseline module SHALL create a `kubernetes_network_policy_v1` named `default-deny` in each namespace from the `namespaces` input. The policy SHALL select all pods (`podSelector: {}`), declare `policyTypes: ["Ingress", "Egress"]`, and contain no allow rules. Any traffic not permitted by a more-specific NetworkPolicy is dropped (on CNIs that enforce NetworkPolicy).

#### Scenario: Default-deny blocks unlisted traffic

- **WHEN** a pod in namespace `prod` attempts egress to a destination not covered by any allow-rule NetworkPolicy
- **THEN** the CNI SHALL drop the packet (on enforcing CNIs like Cilium)

#### Scenario: Policy created but not enforced on kindnet

- **WHEN** `tofu apply` is run against the local kind cluster
- **THEN** the default-deny NetworkPolicy resource SHALL be created successfully
- **AND** kindnet SHALL NOT enforce it

### Requirement: Baseline module exports shared securityContext defaults

The baseline module SHALL output `pod_security_context` and `container_security_context` objects for consumption by all workload modules.

`pod_security_context` SHALL contain:
- `run_as_non_root = true`
- `run_as_user = 65532`
- `run_as_group = 65532`
- `fs_group = 65532`
- `fs_group_change_policy = "OnRootMismatch"`
- `seccomp_profile = { type = "RuntimeDefault" }`

`container_security_context` SHALL contain:
- `allow_privilege_escalation = false`
- `read_only_root_filesystem = true`
- `capabilities_drop = ["ALL"]`

#### Scenario: Outputs consumed by app-instance

- **WHEN** the app-instance module references `var.baseline.pod_security_context`
- **THEN** the Deployment pod spec SHALL use the baseline values for its `security_context` block

### Requirement: Baseline module exports shared NetworkPolicy constants

The baseline module SHALL output reusable constants for NetworkPolicy construction:

- `rfc1918_except`: `["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"]`
- `node_cidr`: the value of the `node_cidr` input variable (e.g., `"172.24.1.0/24"` for UpCloud)
- `coredns_selector`: `{ namespace = "kube-system", k8s_app_in = ["coredns", "kube-dns"] }`

#### Scenario: Constants used by netpol factory

- **WHEN** the netpol factory module receives `rfc1918_except` from baseline
- **THEN** the generated NetworkPolicy egress ipBlock `except` list SHALL match the baseline output

### Requirement: Warn-then-enforce rollout

The PSA enforcement label SHALL be rolled out in two phases within one PR:

1. Phase 1: `pod-security.kubernetes.io/warn=restricted` — every non-compliant pod creation logs a warning but succeeds.
2. Phase 2: `pod-security.kubernetes.io/enforce=restricted` — non-compliant pods are rejected at admission.

Phase 2 SHALL NOT be applied until all workload Deployments in the namespace include compliant securityContext fields.

#### Scenario: Warn phase surfaces non-compliant pods

- **WHEN** Phase 1 is applied and a Deployment creates a pod without securityContext
- **THEN** `tofu apply` output SHALL include a PodSecurity warning for the pod
- **AND** the pod SHALL be created successfully

#### Scenario: Enforce phase rejects non-compliant pods

- **WHEN** Phase 2 is applied and a Deployment creates a pod without securityContext
- **THEN** the Kubernetes API server SHALL reject the pod creation
- **AND** the Deployment SHALL report a failed replica

### Requirement: All workloads set pod and container securityContext

Every `kubernetes_deployment_v1` managed by this project (app, oauth2-proxy, s2) SHALL set pod-level `security_context` matching `baseline.pod_security_context` and container-level `security_context` matching `baseline.container_security_context`. Traefik pod and init container securityContext SHALL be set via Helm values overrides.

#### Scenario: App pod passes restricted admission

- **WHEN** the workflow-engine Deployment is applied with securityContext from baseline
- **THEN** the pod SHALL pass PodSecurity `restricted` admission

#### Scenario: oauth2-proxy pod passes restricted admission

- **WHEN** the oauth2-proxy Deployment is applied with securityContext from baseline
- **THEN** the pod SHALL pass PodSecurity `restricted` admission

#### Scenario: s2 pod passes restricted admission

- **WHEN** the s2 Deployment is applied with securityContext from baseline and emptyDir volumes at writable paths
- **THEN** the pod SHALL pass PodSecurity `restricted` admission

#### Scenario: Traefik pod passes restricted admission

- **WHEN** the Traefik Helm release is applied with explicit pod and container securityContext values
- **THEN** the Traefik pod and init container SHALL pass PodSecurity `restricted` admission

### Requirement: Writable paths via emptyDir

Pods requiring filesystem writes (despite `readOnlyRootFilesystem: true`) SHALL mount `emptyDir` volumes at the required paths. Specifically:
- workflow-engine: `/tmp`
- s2: `/data` and `/tmp`

#### Scenario: App writes to /tmp

- **WHEN** the workflow-engine container writes to `/tmp`
- **THEN** the write SHALL succeed (emptyDir is writable)
- **AND** the root filesystem SHALL remain read-only

#### Scenario: s2 writes to /data

- **WHEN** the s2 container writes to `/data` (osfs backend)
- **THEN** the write SHALL succeed (emptyDir is writable)

### Requirement: cert-manager namespace PSA enforcement

The baseline module SHALL apply PSA `restricted` enforcement to the `cert-manager` namespace (in addition to workload namespaces). cert-manager v1.16+ pods are expected to comply out of the box; the `warn` phase SHALL verify this before `enforce` is flipped.

#### Scenario: cert-manager namespace enforces restricted

- **WHEN** PSA enforcement is active on `cert-manager` namespace
- **THEN** cert-manager controller, webhook, and cainjector pods SHALL pass admission

### Requirement: Security context

The implementation SHALL conform to the threat model documented at `/SECURITY.md §5 Infrastructure and Deployment`. Changes to PodSecurity enforcement, namespace isolation, and securityContext additions MUST update `/SECURITY.md §5` in the same change proposal.

#### Scenario: SECURITY.md updated

- **GIVEN** this change adds PodSecurity enforcement and namespace isolation
- **WHEN** the change is implemented
- **THEN** `/SECURITY.md §5` SHALL be updated to document the new namespace isolation model, PodSecurity enforcement level, and securityContext requirements
