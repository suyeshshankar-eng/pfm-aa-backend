"""
pfm_agent/gate.py — the Airlock gate client.

Per the FIU guide and Octic's handoff doc: no SDK call for fetch_data
exists in a released SDK yet, so this talks to the gate directly over the
Unix socket in AIRLOCK_GATE_SOCKET. The host name in the URL is ignored by
the gate; http://gate is just a placeholder authority.
"""
from __future__ import annotations

import json
import os

import httpx

# The AA fetch (token -> consent check -> decrypt) can take up to 5 minutes
# per the FIU guide's timeout table; give the client enough headroom to see
# the gate's own answer rather than timing out client-side first.
_FETCH_TIMEOUT_S = 330.0


class GateRefused(Exception):
    def __init__(self, status_code: int, body: str):
        super().__init__(f"{status_code} {body}")
        self.status_code = status_code
        self.body = body


def _client() -> httpx.Client:
    socket_path = os.environ["AIRLOCK_GATE_SOCKET"]
    return httpx.Client(
        transport=httpx.HTTPTransport(uds=socket_path),
        base_url="http://gate",
        timeout=_FETCH_TIMEOUT_S,
    )


def fetch(credentials: dict) -> list[str]:
    """
    POST /v0/fetch with the credentials set, unchanged. consent_id and
    fi_data_range are deliberately omitted — the orchestrator uses the
    run's own values from Start run; sending them risks a mismatch
    (422 input_disagrees) for no benefit, since the agent doesn't choose
    them anyway.
    """
    with _client() as client:
        resp = client.post(
            "/v0/fetch",
            json={"schema": "airlock.fetch.request.v1", "credentials": credentials},
        )
    if resp.status_code != 200:
        raise GateRefused(resp.status_code, resp.text.strip())
    return resp.json().get("names", [])


def read_index(client: httpx.Client) -> dict:
    resp = client.get("/v0/data/index.json")
    resp.raise_for_status()
    return resp.json()


def read_document(client: httpx.Client, name: str) -> bytes:
    resp = client.get(f"/v0/data/{name}")
    resp.raise_for_status()
    return resp.content


def post_output(answer: dict) -> None:
    body = json.dumps(answer).encode("utf-8")
    if len(body) > 8 * 1024 * 1024:
        raise ValueError(f"answer is {len(body)} bytes, over the 8 MiB /v0/output limit")
    with _client() as client:
        resp = client.post("/v0/output", content=body)
    if resp.status_code != 204:
        raise GateRefused(resp.status_code, resp.text.strip())
