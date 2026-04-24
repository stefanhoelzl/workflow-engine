## ADDED Requirements

### Requirement: GET /api/workflows/:tenant/public-key route

The runtime SHALL expose `GET /api/workflows/:tenant/public-key` returning the current primary public key and its fingerprint. The route SHALL be mounted under the `/api/workflows/:tenant` prefix and SHALL inherit the existing `requireTenantMember` middleware for authentication and tenant-regex validation.

Response body (on 200):

```json
{
  "algorithm": "x25519",
  "publicKey": "<base64 of 32-byte X25519 public key>",
  "keyId": "<16-char lowercase hex>"
}
```

The `publicKey` SHALL be `getPrimary().pk` base64-encoded. The `keyId` SHALL equal `computeKeyId(publicKey)`.

#### Scenario: Member gets public key

- **GIVEN** a tenant `"acme"` with a member user authenticated
- **WHEN** `GET /api/workflows/acme/public-key` is called with valid auth
- **THEN** response SHALL be 200 with body `{ algorithm: "x25519", publicKey: <b64>, keyId: <16-hex> }`
- **AND** the response SHALL contain no ciphertext or private-key material

#### Scenario: Non-member receives 404

- **GIVEN** a tenant `"acme"` and a user who is not a member
- **WHEN** `GET /api/workflows/acme/public-key` is called
- **THEN** the response SHALL be 404 (identical to "tenant does not exist" per existing requireTenantMember behavior)

#### Scenario: Invalid tenant identifier receives 404

- **GIVEN** a malformed tenant name not matching the tenant regex
- **WHEN** `GET /api/workflows/.../public-key` is called
- **THEN** the response SHALL be 404

#### Scenario: Unauthenticated request is rejected

- **GIVEN** no authentication is provided
- **WHEN** `GET /api/workflows/acme/public-key` is called
- **THEN** the response SHALL follow the existing requireTenantMember rejection behavior (401 or 404 as documented for other `/api/workflows/:tenant` routes)

#### Scenario: KeyId matches public key fingerprint

- **GIVEN** a 200 response to the endpoint
- **WHEN** the caller computes `computeKeyId(base64.decode(response.publicKey))`
- **THEN** the result SHALL equal `response.keyId`

### Requirement: Public-key endpoint returns only primary key

The endpoint SHALL only reveal the primary key. Retained keys (if any) used for decrypting older bundles SHALL NOT be exposed. Callers seeking to detect rotation SHALL poll this endpoint and observe the `keyId` changing.

#### Scenario: Multiple keys resident, only primary returned

- **GIVEN** `SECRETS_PRIVATE_KEYS = "k1:...,k2:..."` with `k1` primary
- **WHEN** `GET /api/workflows/:tenant/public-key` is called
- **THEN** the response `keyId` SHALL equal `k1`
- **AND** the response `publicKey` SHALL equal the pk derived from `k1`'s sk
