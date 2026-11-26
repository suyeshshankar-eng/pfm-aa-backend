"""
training/label_with_gemma.py — Gemma 4 E4B as the offline teacher for the student model.

Not part of the image. Labels BS_Data rows one per call: asking for a whole
chunk as a bare JSON array (what the agent used to do at runtime) drifts —
agreement with one-per-call labels fell from 69% at chunk position 0 to 24%
at position 35 over a 40-row chunk.

    pip install llama-cpp-python==0.3.35   # Mac: CC=/usr/bin/clang CXX=/usr/bin/clang++ CMAKE_ARGS="-DGGML_METAL=on"
    python training/label_with_gemma.py rows.jsonl labelled.jsonl

Input rows: one JSON object per line with "narration" and "amount".
Output: the same objects plus "label". Appends, so a stopped run resumes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from categorise import CATEGORIES  # noqa: E402

GGUF = Path(__file__).resolve().parent.parent / "models" / "gemma-4-E4B-it-Q4_K_M.gguf"

SYSTEM_PROMPT = (
    "You are a personal finance categorisation assistant. You read numbered "
    "bank statement transactions from one customer's consented statement and "
    "reply with JSON only. For each transaction, in the same order, pick "
    f"exactly one category from this fixed list: {', '.join(CATEGORIES)}. "
    "A positive amount is money in, a negative amount is money out. "
    "TRANSFER_INTERNAL is a transfer between the customer's own accounts. "
    "Never comment on creditworthiness or make a lending decision."
)
SCHEMA = {
    "type": "object",
    "properties": {"categories": {"type": "array", "items": {"type": "string", "enum": CATEGORIES},
                                  "minItems": 1, "maxItems": 1}},
    "required": ["categories"],
}


def label(llm, row: dict) -> str:
    response = llm.create_chat_completion(
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": (
                f"1 transactions:\n1. amount={row['amount']:+.2f} narration={row['narration']}\n\n"
                'Reply {"categories": [...]} with exactly 1 entries, in order.'
            )},
        ],
        temperature=0,
        max_tokens=80,
        response_format={"type": "json_object", "schema": SCHEMA},
    )
    cat = json.loads(response["choices"][0]["message"]["content"])["categories"][0]
    if cat not in CATEGORIES:
        raise ValueError(f"model returned {cat!r}")
    return cat


def main(src: str, out: str) -> None:
    from llama_cpp import Llama

    done = sum(1 for _ in open(out)) if Path(out).exists() else 0
    rows = [json.loads(line) for line in open(src)][done:]
    llm = Llama(model_path=str(GGUF), n_ctx=2048, n_gpu_layers=-1, verbose=False)
    with open(out, "a") as f:
        for i, row in enumerate(rows, done + 1):
            f.write(json.dumps({**row, "label": label(llm, row)}) + "\n")
            if i % 100 == 0:
                print(f"{i} labelled", flush=True)


if __name__ == "__main__":
    main(*sys.argv[1:3])
