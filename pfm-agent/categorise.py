"""
pfm_agent/categorise.py — PFM categorisation over BS_Data statements.

The runtime model is a small linear classifier distilled from Gemma 4 E4B:
Gemma labelled ~12k distinct mock-AA narrations offline, one per call
(training/label_with_gemma.py), and training/train_student.py fitted a
logistic regression on narration words + amount band and exported its
weights to one .npz. Inference is a token->row lookup and a summed dot
product in numpy: ~1 ms for 140 transactions, ~230 ms for a cold process,
against ~60 s for Gemma itself on CPU. It agrees with per-row Gemma on
75.5% of rows (5-fold over held-out statements, train_student.py); the
README has the other measurement and the weak categories.

The model path is fixed to where the Dockerfile copies the weights inside the
image: a model change means a new image, per the FIU guide's rule for any
change to what the image carries.

The model only picks a category per transaction and never does arithmetic.
The summary is computed here from the categories.
"""
from __future__ import annotations

import math
import re
from collections import defaultdict
from pathlib import Path

import numpy as np

MODEL_PATH = Path("/opt/agent/models/pfm-student.npz")

CATEGORIES = [
    "INCOME", "RENT", "EMI_LOAN", "FOOD", "UTILITY", "TRANSFER_INTERNAL",
    "SHOPPING", "HEALTH", "TRAVEL", "ENTERTAINMENT", "FEES_CHARGES", "OTHER",
]

_TOK = re.compile(r"[a-z]{2,}")


def features(narration: str, amount: float) -> list[str]:
    """Shared by training and inference; changing it means retraining."""
    w = _TOK.findall(narration.lower())
    sign = "p" if amount > 0 else "n"
    return [
        *w,
        *(a + "_" + b for a, b in zip(w, w[1:])),
        f"__{sign}",
        f"__{sign}b{int(math.log10(abs(amount) + 1))}",
        f"__{sign}round" if amount and abs(amount) % 500 == 0 else f"__{sign}odd",
    ]


class Model:
    def __init__(self, path: Path = MODEL_PATH):
        if not path.exists():
            raise FileNotFoundError(
                f"Model weights not found at {path} — the image build must COPY "
                f"models/pfm-student.npz there (see Dockerfile)."
            )
        z = np.load(path, allow_pickle=False)
        self.classes = z["classes"]
        if not set(self.classes) <= set(CATEGORIES):
            raise ValueError(f"model classes {sorted(set(self.classes) - set(CATEGORIES))} not in CATEGORIES")
        self.Wb = z["Wb"]  # (n_features + 1, n_classes); last row is the bias
        self.vocab = {t: i for i, t in enumerate(z["vocab"].tolist())}

    def predict(self, rows: list[dict]) -> list[str]:
        if not rows:
            return []
        vocab, bias = self.vocab, len(self.vocab)
        ids: list[int] = []
        starts: list[int] = []
        for r in rows:
            # The bias row keeps every segment non-empty, so a narration with
            # no known tokens still gets the prior's best class.
            starts.append(len(ids))
            ids.append(bias)
            # dict.fromkeys: each token counts once per row, as in training.
            ids += [vocab[t] for t in dict.fromkeys(features(r["narration"], r["amount"])) if t in vocab]
        return self.classes[np.add.reduceat(self.Wb[ids], starts).argmax(1)].tolist()


_model: Model | None = None


def _get_model() -> Model:
    global _model
    if _model is None:
        _model = Model()
    return _model


def _rows(statements: list[dict]) -> list[dict]:
    # One list across every account, so a run answers for one customer's
    # consented statement, not a cross-customer batch.
    rows = []
    for stmt in statements:
        bank = stmt.get("bank", "unknown")
        for txn in stmt.get("transactions", []):
            rows.append({
                "bank": bank,
                "date": txn.get("date"),
                "amount": float(txn.get("amount") or 0),
                "narration": txn.get("narration") or "",
            })
    return rows


def summarise(rows: list[dict], categories: list[str]) -> dict:
    """Totals from the assigned categories. Internal transfers are neither income nor spend."""
    income = spend = 0.0
    by_category: dict[str, float] = defaultdict(float)
    for r, c in zip(rows, categories, strict=True):
        if c == "TRANSFER_INTERNAL":
            continue
        if r["amount"] > 0:
            income += r["amount"]
        elif r["amount"] < 0:
            spend += -r["amount"]
            by_category[c] += -r["amount"]
    top = sorted(by_category.items(), key=lambda kv: kv[1], reverse=True)[:3]
    return {
        "total_income": round(income, 2),
        "total_spend": round(spend, 2),
        "net_cashflow": round(income - spend, 2),
        "top_categories": [{"category": c, "amount": round(a, 2)} for c, a in top],
    }


def categorise_and_summarise(statements: list[dict], model: Model | None = None) -> dict:
    """
    Takes the list of parsed BS_Data statement dicts (one per `fi-N` the
    gate served) and returns the agent's answer: per-transaction categories
    plus a spending/saving/cashflow summary. Pure derivation — no decision,
    no retention, matching the manifest's sideEffectClass "derive-only".
    """
    model = model or _get_model()
    rows = _rows(statements)
    categories = model.predict(rows)
    return {
        "transactions": [
            {"date": r["date"], "amount": r["amount"], "narration": r["narration"], "category": c}
            for r, c in zip(rows, categories, strict=True)
        ],
        "summary": summarise(rows, categories),
    }
