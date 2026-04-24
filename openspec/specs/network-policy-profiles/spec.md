# Network Policy Profiles Specification

## Purpose

Define the `modules/netpol/` OpenTofu module that renders Kubernetes `NetworkPolicy` resources for app pods, traefik, cert-manager acme-solver pods, and cross-namespace egress. Owns the default-deny-plus-allowlist posture that supports SECURITY.md §5 R-I1 (app-pod NetworkPolicy defence-in-depth for forged-header threats).

## Requirements

### Requirement: NetworkPolicy factory module interface

The `modules/netpol/` module SHALL accept the following variables and create one `kubernetes_network_policy_v1` resource:

- `name` (string): resource name
- `namespace` (string): target namespace
- `pod_selector` (map of string): labels selecting the target pods
- `egress_internet` (bool, default false): when true, adds an egress rule allowing `0.0.0.0/0` except RFC1918 + link-local CIDRs
- `egress_dns` (bool, default false): when true, adds an egress rule allowing UDP+TCP port 53 to CoreDNS pods in kube-system
- `egress_to` (list of objects): targeted egress rules with `pod_selector`, `namespace_selector` (optional), `port`, and `enabled` (optional, default true)
- `ingress_from_pods` (list of objects): targeted ingress rules with `pod_selector`, `namespace_selector` (optional), and `port`
- `ingress_from_cidrs` (list of objects): CIDR-based ingress rules with `cidr` and `ports` (list of numbers)
- `rfc1918_except` (list of string): passed from baseline module
- `coredns_selector` (object): passed from baseline module

#### Scenario: Factory creates NP with internet egress and DNS

- **WHEN** the netpol module is called with `egress_internet = true` and `egress_dns = true`
- **THEN** the generated NetworkPolicy SHALL include an egress rule for `0.0.0.0/0` with `except` matching the provided `rfc1918_except` list
- **AND** an egress rule for CoreDNS on UDP+TCP port 53

#### Scenario: Factory creates NP with targeted egress

- **WHEN** the netpol module is called with `egress_to = [{ pod_selector = { "app.kubernetes.io/name" = "s2" }, port = 9000, enabled = true }]`
- **THEN** the generated NetworkPolicy SHALL include an egress rule allowing TCP port 9000 to pods matching the selector

#### Scenario: Disabled egress_to entries are skipped

- **WHEN** the netpol module is called with an `egress_to` entry where `enabled = false`
- **THEN** the generated NetworkPolicy SHALL NOT include that egress rule

#### Scenario: Factory creates NP with cross-namespace ingress

- **WHEN** the netpol module is called with `ingress_from_pods = [{ pod_selector = { "app.kubernetes.io/name" = "traefik" }, namespace_selector = { "kubernetes.io/metadata.name" = "traefik" }, port = 8080 }]`
- **THEN** the generated NetworkPolicy SHALL include an ingress rule from pods matching the selector in the specified namespace

#### Scenario: Factory creates NP with CIDR ingress and multiple ports

- **WHEN** the netpol module is called with `ingress_from_cidrs = [{ cidr = "172.24.1.0/24", ports = [8000, 8443, 8080] }]`
- **THEN** the generated NetworkPolicy SHALL include an ingress rule from the CIDR with TCP ports 8000, 8443, and 8080

### Requirement: App workload uses netpol factory

The app-instance module SHALL create the workflow-engine app's NetworkPolicy via the netpol factory with a profile equivalent to the current hand-written NP:
- `egress_internet = true`
- `egress_dns = true`
- `egress_to`: S2 on port 9000 (conditional on `local_deployment`)
- `ingress_from_pods`: Traefik on port 8080 (cross-namespace from `ns/traefik`)
- `ingress_from_cidrs`: node CIDR on port 8080 (kubelet probes)

#### Scenario: App NP matches current behavior

- **WHEN** the app netpol factory call is applied
- **THEN** the generated NetworkPolicy SHALL permit the same traffic as the current hand-written `kubernetes_network_policy_v1.app`

### Requirement: Traefik workload uses netpol factory

The traefik module SHALL create the Traefik NetworkPolicy via the netpol factory. The profile SHALL include cross-namespace egress to app backends in all workload namespaces.

#### Scenario: Traefik NP egress crosses namespaces

- **WHEN** the traefik netpol factory call is applied with workload namespaces `["prod"]`
- **THEN** the generated NetworkPolicy SHALL permit egress to pods with `app.kubernetes.io/name=workflow-engine` in namespace `prod` on port 8080

### Requirement: S2 workload uses netpol factory

The s2 module SHALL create the S2 NetworkPolicy via the netpol factory with ingress from the app on port 9000.

#### Scenario: S2 NP matches current behavior

- **WHEN** the s2 netpol factory call is applied
- **THEN** the generated NetworkPolicy SHALL permit ingress from pods with `app.kubernetes.io/name=workflow-engine` on port 9000
