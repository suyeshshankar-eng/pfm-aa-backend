# pfm-fiu-backend (MOCK)

A stand-in for the FIU's own server in the PFM architecture ([PFM-DESIGN §6](../../pfm-tee-kit/docs/PFM-DESIGN.md),
ADR-006 option D). **Synthetic data only; auth is a mock.** One runtime dependency (`jose`, pulled in by the shared mock-enclave code).

```
app ──HTTPS──▶ this backend ──(mock enclave in-process | Pub/Sub + KMS envelope)──▶ enclave
app ◀──────── this backend ◀──────────────── sealed reply (ciphertext) ──────────────┘
```

## What it does, and refuses to do

| Does | Does not |
|---|---|
| Authenticates the app (mock bearer session, `customer-test-*` only) | Decode the presentation or the reply — the enclave verifies the VP, only the device unseals |
| Holds the queue-requester identity (queue mode) | Verify anything on the enclave's behalf |
| Relays `{jobId, body}` and returns `{outcome, output \| errorType}` | Log content: events carry ids, sizes, outcomes, error types (tested) |
| Keeps the latest **sealed** reply per customer; app opens read it (no AA fetch, PFM-DESIGN §11) | Hold a plaintext document or any key |
| Rejects replayed `jobId` (409), oversized bodies (413), a 2nd concurrent request (429) | Make per-customer authorisation decisions beyond "session owns its own latest reply" |

## Routes

`GET /v1/config` · `POST /v1/session {customerId}` · `POST /v1/credentials {holder:{did,jwk}}` (mock mode only; stands in
for the credential issuer) · `POST /v1/insights {jobId, body}` · `GET /v1/insights/latest`

## Run

```sh
bun install
bun test                                   # 9 tests, in-process, no sockets
bun src/main.ts                            # mock enclave, :8787
```
Point `pfm-client` at it: browser dev `http://localhost:8787`; Android emulator `http://10.0.2.2:8787`
(a physical phone needs your LAN IP; debug builds allow cleartext, release builds do not).

Queue mode relays to a real slot with the requester identity from the environment — never a file in the repo:
```sh
PFM_BACKEND_MODE=queue PFM_ENV=sandbox PFM_PARTNER=pfm \
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) bun src/main.ts
```
Queue mode has no `/v1/credentials` (issuance isn't built; the app imports its credentials) and will be refused by
today's PFM worker, which does not yet accept schema-2 jobs.

## Airlock mode (the FIU's system calling Airlock)

Per Octic's handoff (Airlock ≥ 1.0.0-beta.44, org `kaushal-agent-test`). The backend does every Airlock step —
login, start run (`consentId` + `fiDataRange` in the clear), find the row, sign the request, poll, fetch and open the
reply (HPKE, `src/hpke.ts`), save the chain — and the app only calls `POST /v1/runs` and polls `GET /v1/runs/:id`
(`/chain` downloads the evidence). `GET /v1/runs` lists the customer's runs since the backend started, newest first,
for the app's history screen. `src/airlock.ts` is the client; tests run it against a fake Airlock that checks the
presentations' signatures, claims and the HPKE `info`.

```sh
PFM_BACKEND_MODE=airlock PFM_AIRLOCK_WORKLOAD_ID=… PFM_AIRLOCK_DIGEST=sha256:… \
PFM_AIRLOCK_SYSTEM_KEY_FILE=… PFM_AIRLOCK_CREDENTIAL_FILE=… PFM_AIRLOCK_REPLY_KEY_FILE=… PFM_ACCESS_KEY_FILE=… \
bun src/main.ts
```

- **Secrets are files** outside the repo (Secret Manager mounts on Cloud Run): `system.key`, `system.credential.jwt`,
  `reply.key`, and an access key (≥ 16 chars). Never env values, never logged, never in the image.
- **Do not deploy this mode with the existing unauthenticated service.** A session can start runs as the org's system
  identity, so airlock mode refuses to start without an access key and `POST /v1/session` then needs `x-access-key`.
  Prefer Cloud Run IAM in front of it as well. That key is a demo gate, not customer login.
- **Privacy change:** the reply is sealed to the *org's* reply key, which this backend holds, so the backend sees the
  insights in plaintext (the relay path did not). Logs carry ids, stages and error types only; answers and chains are
  held in memory and returned only to the customer that started the run.
- `scripts/publish-reply-key.ts <new-path>` makes the X25519 reply key, writes the private half (0600, refuses to
  overwrite) *before* publishing, revokes the current reply key and checks the list shows exactly the new one. Keep every
  revoked key. Run from your own shell: the system key is an admin key.
- Allowed consent ids default to `sandbox-ok,sandbox-manual` (`PFM_AIRLOCK_CONSENT_IDS`); the range is the last 90
  days. `sandbox-manual` waits for a human at Octic's mock AA screen: the AA fetch gives up after 5 minutes.
- **Verified against the real API** on 2026-11-23 (`sandbox-ok`): app → backend → Airlock → opened reply in about
  12 s, 19 receipts, api verdict ok. Octic's development api (`api.airlock-development.gcp.octichq.com`) does
  not know this org (`INVALID_ASSERTION unknown_issuer`). `sandbox-manual` not yet run through the backend. Receipt timestamps are shown only if a receipt body
  carries a string `issued_at`/`timestamp`/`at`/`time` (field names unconfirmed). The api `verdict` is passed through as
  "not independently verified".
- Dependency added: `@noble/ciphers` (Bun's `node:crypto` lacks ChaCha20-Poly1305). HPKE open is cross-checked against a
  blob sealed by Python `cryptography` (`tests/fixtures/make-hpke-vector.py`).

## Deployed instance

`https://pfm-fiu-backend-334610188311.asia-south1.run.app` — Cloud Run, project `sahamati-labs`, asia-south1, mock mode.
Redeploy with `./scripts/deploy-cloud-run.sh` (stages both folders, Cloud Build from source). Deliberate settings:
**unauthenticated** (the app has no Google identity; the service holds no secrets, serves synthetic data only and has no
real enclave behind it), **max 1 instance** (state is in memory), min 0 (cold start on first request after idle).
Anyone on the internet can open a session and run the mock. Delete with
`gcloud run services delete pfm-fiu-backend --project sahamati-labs --region asia-south1`.

## Shared code

Imports `../pfm-client/src/{mock,transport,lib}` so the envelope, Pub/Sub client and mock enclave cannot drift from
the app's. Both folders must be checked out together.

## Mock-only simplifications (a real FIU must replace these)

- Sessions are in-memory bearer tokens issued to anyone naming a synthetic customer; no login, expiry or rotation.
- Dedupe, in-flight and latest-reply state is in memory: restart loses it, and it is not multi-instance safe.
- One shared requester token for all customers; no per-customer rate limits beyond one in flight.
- Latest-reply storage is not encrypted at rest (it is already ciphertext to the device, but metadata sits beside it).
- Plain HTTP, permissive only for listed dev origins. Production needs TLS and a real origin policy.
- It cannot bind a session to the customer named inside the consent credential (that check belongs to the enclave
  verifier and the FIU's own identity system).
