## ADDED Requirements

### Requirement: Namespace default-deny NetworkPolicy

The workflow-engine umbrella module SHALL create a namespace-wide `NetworkPolicy` in the `default` namespace with `podSelector: {}`, `policyTypes: ["Ingress", "Egress"]`, and no allow rules. This policy establishes deny-by-default for every pod in the namespace whose traffic is not permitted by a more specific allow-rule NetworkPolicy.

The policy SHALL be declared as a Kubernetes resource in the same environments where the module is instantiated. Local environments running kindnet (which does not enforce NetworkPolicy) SHALL tolerate the resource as an inert object; production environments running Cilium (UpCloud UKS) SHALL enforce it.

#### Scenario: Default-deny blocks unlisted egress in production

- **WHEN** a pod in `default` namespace attempts egress to a destination not covered by any allow-rule NetworkPolicy
- **THEN** the Cilium CNI SHALL drop the packet

#### Scenario: Default-deny blocks unlisted ingress in production

- **WHEN** a peer attempts to connect to a pod in `default` namespace on a port not covered by any allow-rule NetworkPolicy
- **THEN** the Cilium CNI SHALL drop the packet

#### Scenario: Local kindnet accepts but does not enforce

- **WHEN** `tofu apply` is run against the local kind cluster
- **THEN** the NetworkPolicy resource SHALL be created successfully
- **AND** kindnet SHALL NOT enforce it
- **AND** existing local traffic patterns SHALL continue to work unchanged

### Requirement: App workload network allow-rules

The `app` submodule SHALL create a `NetworkPolicy` selecting the app Deployment's pods (`podSelector` matching the app's Deployment labels, e.g. `app=workflow-engine`) with `policyTypes: ["Ingress", "Egress"]`. The policy SHALL express:

**Egress allow-rules**:
- `to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"] } }]` with no port restriction — covers UpCloud Object Storage, `api.github.com`, and sandboxed-action `__hostFetch` destinations.
- `to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } }, podSelector: { matchLabels: { "k8s-app": "coredns" } } }]` on `UDP :53` and `TCP :53` — DNS resolution via CoreDNS.

**Ingress allow-rules**:
- `from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } } }]` on `TCP :8080` — only Traefik pods may reach the app's HTTP port.
- `from: [{ ipBlock: { cidr: "172.24.1.0/24" } }]` on `TCP :8080` — node CIDR allows kubelet liveness/readiness probes.

#### Scenario: App reaches UpCloud Object Storage over the public Internet

- **WHEN** the app issues an HTTPS request to `7aqmi.upcloudobjects.com` (public IPs)
- **THEN** the egress ipBlock rule SHALL permit the connection

#### Scenario: App reaches api.github.com for token validation

- **WHEN** the app calls `api.github.com/user` during API auth
- **THEN** the egress ipBlock rule SHALL permit the connection

#### Scenario: App cannot reach cloud metadata endpoint

- **WHEN** a sandboxed action attempts to fetch `http://169.254.169.254/`
- **THEN** the egress ipBlock `except` on `169.254.0.0/16` SHALL cause the packet to be dropped

#### Scenario: App cannot reach other in-cluster pods directly

- **WHEN** a sandboxed action attempts to fetch any in-cluster Service or pod IP (within `10.0.0.0/8` or `172.16.0.0/12`)
- **THEN** the egress ipBlock `except` SHALL cause the packet to be dropped

#### Scenario: App resolves DNS via CoreDNS

- **WHEN** the app resolves a hostname
- **THEN** the egress DNS rule SHALL permit the query to CoreDNS pods in `kube-system`

#### Scenario: Non-Traefik pod cannot reach app:8080

- **WHEN** any pod other than Traefik (for example oauth2-proxy) attempts to connect to the app on `:8080`
- **THEN** the ingress rule restricting to `app.kubernetes.io/name=traefik` SHALL cause the connection to be dropped

#### Scenario: Kubelet probes reach app

- **WHEN** the kubelet (from the node at an IP in `172.24.1.0/24`) issues a readiness or liveness probe to the app's `:8080`
- **THEN** the ingress node-CIDR rule SHALL permit the probe

### Requirement: oauth2-proxy workload network allow-rules

The `oauth2-proxy` submodule SHALL create a `NetworkPolicy` selecting the oauth2-proxy Deployment's pods with `policyTypes: ["Ingress", "Egress"]`. The policy SHALL express:

**Egress allow-rules**:
- `to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"] } }]` — covers `github.com` (OAuth token exchange) and `api.github.com` (user info).
- DNS rule identical to the app workload's (CoreDNS on UDP+TCP `:53`).

**Ingress allow-rules**:
- `from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "traefik" } } }]` on `TCP :4180` — only Traefik's forward-auth calls reach oauth2-proxy.
- Node CIDR `172.24.1.0/24` on `TCP :4180` for kubelet probes.

#### Scenario: oauth2-proxy reaches github.com for OAuth

- **WHEN** oauth2-proxy exchanges an authorization code for an access token
- **THEN** the egress ipBlock rule SHALL permit the outbound HTTPS connection to `github.com`

#### Scenario: oauth2-proxy reaches api.github.com for user lookup

- **WHEN** oauth2-proxy calls `api.github.com/user` to resolve the signed-in login
- **THEN** the egress ipBlock rule SHALL permit the connection

#### Scenario: Only Traefik forward-auth reaches oauth2-proxy

- **WHEN** a pod other than Traefik attempts to connect to oauth2-proxy on `:4180`
- **THEN** the ingress rule SHALL cause the connection to be dropped

#### Scenario: Kubelet probes reach oauth2-proxy

- **WHEN** the kubelet issues a liveness probe to oauth2-proxy's `/ping` on `:4180`
- **THEN** the ingress node-CIDR rule SHALL permit the probe

### Requirement: Traefik workload network allow-rules

The routing module SHALL declare the Traefik NetworkPolicy as a first-class `kubernetes_network_policy_v1` Terraform resource (not via Helm `extraObjects`) and make `helm_release.traefik` explicitly depend on it. This ordering ensures the NP is created and enforced by the CNI before the Traefik pod boots; otherwise ACME resolver initialization can race with NP enforcement and fail to reach Let's Encrypt at startup, leaving the resolver permanently unavailable.

The policy SHALL select pods with label `app.kubernetes.io/name=traefik` and set `policyTypes: ["Ingress", "Egress"]`. It SHALL express:

**Egress allow-rules**:
- `to: [{ ipBlock: { cidr: "0.0.0.0/0", except: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"] } }]` — covers Let's Encrypt ACME directory endpoints for cert issuance/renewal.
- DNS rule identical to the app workload's (CoreDNS on UDP+TCP `:53`).
- `to: [{ podSelector: { matchLabels: { "app": "workflow-engine" } } }]` on `TCP :8080` — backend to the app.
- `to: [{ podSelector: { matchLabels: { "app": "oauth2-proxy" } } }]` on `TCP :4180` — forward-auth to oauth2-proxy.

**Ingress allow-rules**:
- Node CIDR `172.24.1.0/24` on TCP `:8000` (web entrypoint), `:8443` (websecure entrypoint), `:8080` (admin/ping for kubelet probes). With `externalTrafficPolicy=Cluster`, kube-proxy SNATs external client IP to the receiving node IP before DNAT to the pod, so at the pod's NP enforcement point the source IP is always in the node CIDR. Ports are the pod's internal `containerPort` values (chart convention: service port `:80` → pod port `:8000`, service port `:443` → pod port `:8443`), NOT the service-level `:80`/`:443`. Cilium evaluates NP ports against the post-DNAT destination port on the pod. Cilium additionally treats `ipBlock: 0.0.0.0/0` as the "world" identity which excludes "host"/"remote-node" traffic, so an explicit node CIDR rule is required even though `0.0.0.0/0` would include it in principle.

#### Scenario: Traefik reaches Let's Encrypt for ACME

- **WHEN** Traefik's cert resolver initiates an ACME order against `acme-v02.api.letsencrypt.org` (or staging)
- **THEN** the egress ipBlock rule SHALL permit the connection

#### Scenario: Traefik reaches app backend

- **WHEN** Traefik routes a request to the app's `:8080`
- **THEN** the egress pod-selector rule SHALL permit the connection

#### Scenario: Traefik performs forward-auth against oauth2-proxy

- **WHEN** Traefik makes a forward-auth call to oauth2-proxy on `:4180`
- **THEN** the egress pod-selector rule SHALL permit the connection

#### Scenario: Public traffic reaches Traefik on 443

- **WHEN** an external client connects to the UpCloud LoadBalancer which forwards to Traefik on `:443`
- **THEN** the ingress rule from `0.0.0.0/0` SHALL permit the connection

#### Scenario: Pods cannot reach Traefik admin or dashboard ports

- **WHEN** another pod attempts to connect to Traefik on any port other than `:80` or `:443`
- **THEN** the default-deny SHALL cause the connection to be dropped

### Requirement: Traefik inline-response plugin source fetched and vendored at apply time

The workflow-engine umbrella module SHALL fetch the `traefik_inline_response` plugin source tarball from the GitHub tagged-commit archive URL at `tofu apply` time. The tarball SHALL be:

1. Fetched via a `terraform_data` resource with a `local-exec` `curl` provisioner, writing to `${path.module}/.plugin-cache/traefik_inline_response-<version>.tar.gz`. The `triggers_replace` SHALL include the pinned version only (not a `fileexists()`-derived token, which causes perpetual drift: the value differs between plan-time evaluation before the provisioner runs and refresh after). If the cache file is missing (fresh clone, manually cleared), the operator SHALL recover with `tofu taint module.workflow_engine.terraform_data.traefik_plugin_fetch` followed by `tofu apply`.
2. Read by a `data "local_file"` data source (with `depends_on = [terraform_data...]` so it reads at apply time after the curl completes).
3. Stored in a Kubernetes `ConfigMap` via `binary_data` using `content_base64` from the data source.
4. Mounted into the Traefik pod via the Helm chart's `deployment.additionalVolumes` + the chart's own `experimental.localPlugins.inline-response` (type `localPath`) mechanism.

The plugin version SHALL be declared in a `locals` block (`plugin_version`) so that bumping the version is an explicit, reviewable change. Integrity relies on the stability of the GitHub tagged-commit URL at `archive/refs/tags/<tag>.tar.gz`; no separate sha256 verification is performed (OpenTofu cannot ergonomically hash binary HTTP responses in-memory — see design.md D6a).

The rationale for the filesystem-cache approach (vs the simpler `data "http"` pattern) is to avoid the `hashicorp/http` provider's unconditional "Response body is not recognized as UTF-8" warning for binary responses. `data "http"`'s `response_body_base64` is correct for binary but the provider emits the warning regardless of which attribute the caller reads. The cache directory `.plugin-cache/` is gitignored; the `file_presence` trigger makes missing-cache-after-clone self-healing.

#### Scenario: Plugin tarball fetched from pinned archive URL

- **WHEN** `tofu apply` runs in an environment with Internet access
- **THEN** the `terraform_data` resource's `local-exec` provisioner SHALL `curl` the archive from the URL computed from `local.plugin_version`
- **AND** the `ConfigMap` `binary_data` SHALL contain the tarball as base64

#### Scenario: Cache file regenerated after manual taint

- **WHEN** the cache file is missing (fresh clone, manually cleared) and the operator runs `tofu taint module.workflow_engine.terraform_data.traefik_plugin_fetch && tofu apply`
- **THEN** the `terraform_data` resource SHALL be replaced
- **AND** the `local-exec` provisioner SHALL re-fetch the tarball to the cache path

#### Scenario: Plugin source available to Traefik at runtime

- **WHEN** the Traefik pod starts
- **THEN** the plugin source tree SHALL be present at `/plugins-local/src/github.com/tuxgal/traefik_inline_response/`
- **AND** no outbound network call to `github.com` SHALL be required for plugin loading

#### Scenario: Plugin tarball fetched from pinned release URL

- **WHEN** `tofu apply` runs in an environment with Internet access
- **THEN** the `http` data source SHALL download the release asset from the URL computed from `local.plugin_version`
- **AND** the `ConfigMap` `binary_data` SHALL contain the tarball as base64

#### Scenario: Plugin source available to Traefik at runtime

- **WHEN** the Traefik pod starts
- **THEN** the plugin source tree SHALL be present at `/plugins-local/src/github.com/tuxgal/traefik_inline_response/`
- **AND** no outbound network call to `github.com` SHALL be required for plugin loading

## MODIFIED Requirements

### Requirement: Traefik Helm release

The routing module SHALL create a `helm_release` installing the `traefik/traefik` chart version `39.0.7`. The Helm release SHALL use `traefik_helm_sets` for environment-specific Helm `set` values, `traefik_extra_objects` for CRD objects deployed via the chart's `extraObjects` feature, and an optional `wait` variable (bool, default `false`) controlling whether Helm waits for all resources to be ready.

The Traefik plugin `traefik_inline_response` SHALL be loaded from a vendored local source tree rather than fetched from GitHub at pod startup. The Helm values SHALL declare `experimental.localPlugins.inline-response` with `moduleName = "github.com/tuxgal/traefik_inline_response"` (no `version` field — `localPlugins` reads from disk). An init container declared via Helm `deployment.initContainers` SHALL extract the plugin tarball (mounted from a ConfigMap as `binary_data`) into an `emptyDir` volume, which is in turn mounted into the main Traefik container at `/plugins-local`. The main container SHALL read the plugin source from the extracted tree.

#### Scenario: Traefik installed via Helm with parameterized config

- **WHEN** `tofu apply` completes
- **THEN** Traefik SHALL be running in the cluster
- **AND** the Helm `set` values SHALL match the provided `traefik_helm_sets`
- **AND** the Helm `extraObjects` SHALL contain the provided `traefik_extra_objects`

#### Scenario: Wait disabled (default)

- **WHEN** `tofu apply` is run with `wait` not set
- **THEN** Helm SHALL not wait for resources to be ready before marking the release as successful

#### Scenario: Wait enabled

- **WHEN** `tofu apply` is run with `wait = true`
- **THEN** Helm SHALL wait for all pods to be ready and LoadBalancer services to receive an external IP before marking the release as successful

#### Scenario: Web entrypoint enabled internally

- **WHEN** the Traefik pod is running
- **THEN** the web entrypoint SHALL listen on port 80 inside the pod
- **AND** the Traefik K8s Service SHALL include port 80
- **AND** no NodePort SHALL be mapped to port 80

#### Scenario: Plugin loaded from vendored source

- **WHEN** the Traefik pod starts
- **THEN** the init container SHALL extract the plugin tarball to the shared `emptyDir`
- **AND** the main Traefik container SHALL load the `traefik_inline_response` plugin from `/plugins-local/src/github.com/tuxgal/traefik_inline_response/`
- **AND** the plugin SHALL be available for middleware configuration
- **AND** no runtime HTTPS request to `github.com` SHALL be made by the Traefik container for plugin loading
