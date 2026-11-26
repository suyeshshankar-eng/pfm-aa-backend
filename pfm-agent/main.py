"""
pfm_agent/main.py — the PFM Categorisation Agent's entrypoint.

Run, in order (per pfm-demo-agent-handoff.md): pick the credentials, fetch
once, read index.json then each fi-N, categorise and summarise, post the
answer, exit 0. One fetch per run, not retried — any failure here means the
orchestrator's run must be started again, not that this process should retry
internally.
"""
from __future__ import annotations

import json
import os
import sys

# Telemetry must be imported, and init() run, before anything it will
# observe — importing it first is what makes that happen (see telemetry.py
# and the Airlock SDK guide's own warning about instrumentation order).
from telemetry import telemetry  # noqa: E402

from categorise import categorise_and_summarise  # noqa: E402
from gate import GateRefused, _client, fetch, post_output, read_document, read_index  # noqa: E402

from octichq_airlock_sdk import with_workflow  # noqa: E402

CREDENTIALS_PATH = "/opt/agent/aa-credentials.json"


def _load_credentials() -> dict:
    environment = os.environ["AIRLOCK_ENVIRONMENT"]
    with open(CREDENTIALS_PATH) as f:
        all_sets = json.load(f)
    return all_sets[environment]


def _read_statements() -> list[dict]:
    """
    Reads index.json and every fi-N document, parsing each as BS_Data JSON.
    A document that isn't JSON (the mock AA's built-in ReBIT XML sample,
    served when nobody has picked BS_Data for the test consent) is a setup
    problem, not a run the agent can answer — caught and re-raised with a
    clear message rather than crashing on an opaque .json() error.
    """
    statements: list[dict] = []
    with _client() as client:
        index = read_index(client)
        for doc in index.get("documents", []):
            name = doc["name"]
            raw = read_document(client, name)
            try:
                statements.append(json.loads(raw))
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"document {name!r} is not JSON (BS_Data expected) — the test "
                    f"consent likely still serves the mock AA's default ReBIT XML "
                    f"sample; pick BS_Data and a bank for it first: {e}"
                ) from e
    return statements


def run() -> int:
    run_id = os.environ.get("AIRLOCK_RUN_ID")

    def _do_run() -> dict:
        credentials = _load_credentials()

        try:
            fetch(credentials)
        finally:
            # Never hold the credentials in memory longer than the one call
            # that needs them.
            del credentials

        statements = _read_statements()
        return categorise_and_summarise(statements)

    try:
        answer = with_workflow(name="pfm-categorise", run_id=run_id)(_do_run)()
    except GateRefused as e:
        print(f"fetch or output refused: {e.status_code} {e.body}", file=sys.stderr)
        return 20
    except (KeyError, FileNotFoundError) as e:
        print(f"credentials setup problem: {e}", file=sys.stderr)
        return 10
    except ValueError as e:
        print(f"bad run data: {e}", file=sys.stderr)
        return 22
    except Exception as e:  # noqa: BLE001 — last resort: fail loudly, not silently
        print(f"unexpected failure: {type(e).__name__}: {e}", file=sys.stderr)
        return 1

    try:
        post_output(answer)
    except GateRefused as e:
        print(f"output refused: {e.status_code} {e.body}", file=sys.stderr)
        return 21

    return 0


if __name__ == "__main__":
    exit_code = run()
    telemetry.shutdown()
    sys.exit(exit_code)
