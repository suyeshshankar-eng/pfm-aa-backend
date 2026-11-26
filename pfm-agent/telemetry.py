"""
pfm_agent/telemetry.py — Octic Airlock telemetry, init'd before anything it observes.

Per Octic Airlock SDK Getting Started: call init() once per process, before
importing the libraries to be observed. It never raises — if telemetry can't
work, the run still proceeds. No content capture (default "none"): the data
this agent reads is a consented bank statement, and the one thing the
telemetry guide and the FIU guide agree on is that customer data, consent
ids and credentials never belong in spans or logs.
"""
from __future__ import annotations

import os

from octichq_airlock_sdk import Agent, init

telemetry = init(
    service_name="pfm-categorisation-agent",
    service_version="2.0.0",
    agent=Agent(agent_id="pfm-agent", name="PFM Categorisation Agent"),
    environment=os.environ.get("AIRLOCK_ENVIRONMENT", "sandbox"),
)
