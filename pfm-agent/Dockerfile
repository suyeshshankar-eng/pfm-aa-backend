# PFM Categorisation Agent — Airlock data_fetch agent, image source "own".
#
# Build for amd64 explicitly: the Confidential VMs are Intel TDX, and an
# arm64 laptop (Mac) defaults to arm64 otherwise.
#   docker build --platform linux/amd64 -t <image>:<tag> .
#
# This image carries the model weights AND the AA credentials (section 9 of
# the Airlock FIU guide — by design on this deployment, not a mistake).
# Everything the agent reads must be world-readable: it runs as an
# unprivileged, non-root uid under gVisor with a read-only root filesystem.

FROM python:3.11-slim

WORKDIR /opt/agent

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY telemetry.py categorise.py gate.py main.py ./

# The student model's weights (~0.6 MB), baked in at build time, never fetched
# at runtime (zero model egress). Produced by training/train_student.py from
# Gemma's offline labels; Gemma itself is not in the image.
COPY models/pfm-student.npz /opt/agent/models/pfm-student.npz

# AA credentials, sandbox + production sets, one file (section 9). Never
# commit it — it is gitignored; see the README's "Not in this repo".
COPY .secrets/aa-credentials.json /opt/agent/aa-credentials.json

# Readable by any uid: the agent runs as one Airlock assigns, not one this
# image controls.
RUN chmod -R a+rX /opt/agent

ENTRYPOINT ["python", "main.py"]
