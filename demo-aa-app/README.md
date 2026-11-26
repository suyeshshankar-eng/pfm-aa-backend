# demo-aa-app

A self-contained, independent Account Aggregator app + backend + TEE agent,
built to replicate Saafe's sandbox AA flow end to end — minus the SIM-binding
device-identity check, which blocks testing from an emulator/CI and which
this demo doesn't need to reproduce. Separate from `pfm-client`/
`pfm-fiu-backend` above (the FIU side): this is the **AA side**, plus our
own TEE-hosted agent, independent of Octic's Airlock.

- `aa-mobile/` — Flutter app: mobile+OTP login, local passcode, account
  linking (FIP discovery → identifiers → bank OTP → account select), and a
  consent-approval screen for the FIU-initiated half of the protocol. Uses
  Saafe's own branding (icon + "Demo AA" label) for this collaboration.
- `aa-backend/` — mock AA server (Bun): the same flow shape, deployed on
  Cloud Run. Its one sample statement is a real anonymised BS_Data
  statement with all real names/company/address scrubbed to synthetic
  placeholders (`Demo Bank`, `JANE DOE`, `JOHN SMITH`, `EXAMPLE
  TECHNOLOGIES INDIA PVT LTD`) — structure and category distribution are
  real, identities are not.
- `tee-agent/` — categorises FI data with the distilled PFM model
  (`categorise.py` + `models/pfm-student.npz`, copied unmodified from the
  pfm_agent handoff) and posts insights back for the app to display.
  Runs inside a real Confidential VM (Intel TDX) on GCP — attestation
  verified (Secure Boot + measured boot + TDX quote), not simulated.
  - `server.py` + `run.py` — the actual trigger path: an HTTP server
    (`POST /v1/runs {consentId}`, `GET /v1/runs/:id`) that `aa-backend`
    calls automatically the moment a consent goes ACTIVE, shaped like
    `pfm-fiu-backend`'s Airlock client (`src/airlock.ts` /
    `pfm-client/src/transport/airlockRuns.ts`) — same start-run/poll
    pattern, just pointed at our own TEE instead of Octic's Airlock API.
  - `agent.py` — a standalone connectivity smoke test only (its own
    OTP/link/consent walkthrough end to end); not part of the trigger path.

## Run it

```sh
cd demo-aa-app/aa-backend && bun install && bun src/main.ts   # :8788
cd demo-aa-app/aa-mobile && flutter run                        # point at :8788 via 10.0.2.2 on an emulator
```

Set `TEE_AGENT_URL` on `aa-backend` (e.g. `http://<tee-vm-ip>:8081`) to
auto-trigger a categorisation run on consent approval; unset, the backend
just skips the trigger (useful for local runs with no TEE agent reachable).

### Insights through Airlock

Built with `--dart-define=FIU_ACCESS_KEY=<key>`, the app runs the PFM agent
through Airlock instead, via `pfm-fiu-backend` in airlock mode on :8787
(the key is that backend's `PFM_ACCESS_KEY_FILE`):

```sh
flutter run --dart-define=FIU_ACCESS_KEY=$(cat <path>/access.key)
```

Home then shows **Get my insights**, which starts a run on consent
`sandbox-ok` (`FIU_CONSENT_ID`) and shows the answer with its Airlock
evidence, and **Insights history**, which lists past runs from
`GET /v1/runs` and opens each without starting a new one. `FIU_BASE`
overrides the backend address (default `http://10.0.2.2:8787`). Without the
key, the app reads aa-backend's TEE result as before. The key is compiled into
the app, which is fine for the demo; it must never be set in a release build.

`tee-agent/` needs a GCP project with Compute + Artifact Registry +
Confidential Computing APIs enabled, and a Confidential VM created with
Secure Boot on, port 8081 reachable from `aa-backend` — see inline comments
in `tee-agent/server.py` and `tee-agent/Dockerfile` for the exact shape.
