## REMOVED Requirements

The single factory requirement is absorbed into `wpt-compliance-harness`.

### Requirement: createWptHarnessPlugin factory

**Reason**: A one-requirement capability describing a factory that serves the wpt-compliance-harness belongs in the parent capability. Per project `openspec/config.yaml` rules, a spec with only one requirement should be a requirement in a parent spec.

**Migration**: See `wpt-compliance-harness` — the `createWptHarnessPlugin({collect})` factory is specced there with both scenarios preserved (`__wptReport` private descriptor routes collect callbacks to the main thread; descriptor auto-deleted from globalThis at Phase 3 unless the harness source captures it into its IIFE closure first).
