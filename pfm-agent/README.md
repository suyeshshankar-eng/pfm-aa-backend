# PFM Categorisation Agent — Airlock `data_fetch` agent

An Airlock agent for the Sahamati deployment (run mode `data_fetch`, image source `own`). It reads one
customer's consented bank statement (BS_Data JSON, from the mock AA) and returns per-transaction categories
plus a spend, income and cash-flow summary. It makes no lending decision; see `manifest.json`'s
`prohibitedActions`.

## Status

Verified against the real API on 2026-11-23: a run on `sandbox-ok` completed in about 12 s with 19 receipts,
and the version is active in production. The deployment's identifiers (project, registry, workload, runs,
baked image, AA entity) are kept in an internal note, not here. `manifest.json` carries the image digest
because Airlock needs it.

On this deployment sandbox and production use the same mock AA, so the production set in
`.secrets/aa-credentials.json` is identical to the sandbox set. A real production AA would need its own
set, a new image and a new version.

## Model — a student distilled from Gemma 4 E4B

Gemma 4 E4B on CPU took ~60 s for 140 transactions. It is now the offline **teacher** only:
`training/label_with_gemma.py` labelled ~12k distinct mock-AA narrations one row per call, and
`training/train_student.py` fits a logistic regression on narration words + amount band, exported to
`models/pfm-student.npz` (0.6 MB, numpy-only at runtime; tokens seen in only one labelled row — mostly
one-off names and UPI handles — are dropped). 140 transactions categorise in ~1 ms. The image is 74 MB,
down from 5 GB.

Accuracy. There are no human labels yet, so every figure is agreement with per-row Gemma:

| Measurement | Student | Batched Gemma (replaced) |
|---|---|---|
| 5-fold, held-out statements, random sample (`train_student.py`) | 75.5 % | — |
| Three whole held-out statements, row-weighted (420 rows) | 78.8 % | 67.6 % |

The batched Gemma path drifted when asked for 40 categories as a bare array (69 % agreement at chunk
position 0, 24 % by position 35). Weak categories: RENT and ENTERTAINMENT (<10 % recall),
SHOPPING/UTILITY/HEALTH/TRAVEL (23–43 %). The remaining ceiling is Gemma guessing on person-to-person UPI
and cash rows, which the 12 categories don't cover.

**The summary inherits those weaknesses.** `top_categories` can be wrong for a customer whose largest
outflow is rent, since rent is usually labelled something else, and totals can swing when one large row
lands in a different category.

Retrain: `python training/train_student.py` (needs scikit-learn), then `python test_categorise.py`, then
rebuild the image. The test skips with a message when `models/pfm-student.npz` is absent.

## How this differs from the PFM kit's delta path

This agent and the kit's delta path (`pfm-delta-mode`) answer the same question differently and are not
interchangeable:

| | This agent | PFM kit, delta path |
|---|---|---|
| Categories | 12, upper-case (`INCOME`, `EMI_LOAN`, …) | 19, lower-case (`urn:sahamati:pfm-taxonomy:1`) |
| Reply | `{transactions, summary}`, totals computed in the enclave | labelled rows only; the device computes totals |
| Who can read the reply | the FIU backend opens it | sealed to the device key; the backend sees ciphertext |
| Income | every credit | salary and interest only |
| Repeat runs | whole statement reclassified each run | only narrations the device has not seen |
| Narrations | returned as fetched | normalised (digits masked) |

`TRANSFER_INTERNAL` here is decided per row by the model, which will not match the planned multi-account
support (own-account transfer pairing on the device). Which taxonomy and reply shape the app converges on
is still open.

## Protocol notes

- One `POST /v0/fetch` per run, not retried. `credentials` only — no `consent_id` or `fi_data_range`; the
  orchestrator uses the run's own.
- `GET /v0/data/index.json`, then `GET /v0/data/{name}` for each `fi-N`. Each is BS_Data JSON (`bank`,
  `account`, `transactions[]`), **not** ReBIT XML — a consent nobody has pointed at BS_Data on the mock AA
  screen serves the XML sample instead, which this agent treats as a setup error (exit 22), not a crash.
- `POST /v0/output` once, plain JSON, ≤ 8 MiB, then exit 0.
- `egress` is empty in the manifest: the model is baked into the image, so the agent never calls out.
- Telemetry goes to `OCTIC_SPOOL_DIR` via `octichq-airlock-sdk` 0.2.0. `record_receipt`/`sealed_input`
  aren't in 0.2.0, but those are for `data_blind` mode, which this agent doesn't use.

## Not in this repo

The image build needs three things that are kept out of git:

- `.secrets/aa-credentials.json`: the AA credentials, one set per environment. Get it from whoever holds the
  org's AA registration. Never commit it.
- `models/pfm-student.npz`: the student model's weights. Produce it with `training/train_student.py`, or get
  the current file from the agent's maintainers.
- `training/labels.jsonl`: the teacher labels used for training. It holds raw statement narrations, so it
  stays out of a public repository.
