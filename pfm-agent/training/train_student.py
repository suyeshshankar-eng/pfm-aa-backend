"""
training/train_student.py — fit the runtime model from Gemma's labels, export weights.

Not part of the image (scikit-learn is training-only).

    pip install numpy scikit-learn
    python training/train_student.py            # writes models/pfm-student.npz

Prints agreement with Gemma on statements held out of training, using 5 folds
grouped by statement, so a new customer is never in the training set.
labels.jsonl is Gemma's one-per-call labels over ~12k distinct mock-AA
narrations: about half sampled at random, half picked by active learning
(low-confidence rows and rare categories); its "sample" field says which.
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from sklearn.feature_extraction import DictVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from categorise import Model, features  # noqa: E402

LABELS = ROOT / "training" / "labels.jsonl"
OUT = ROOT / "models" / "pfm-student.npz"
MIN_ROWS = int(sys.argv[1]) if len(sys.argv) > 1 else 2


def fit(rows: list[dict], path: Path, min_rows: int = MIN_ROWS) -> Model:
    feats = [dict.fromkeys(features(r["narration"], r["amount"]), 1) for r in rows]
    # Drop tokens seen in fewer than min_rows labelled rows: mostly one-off
    # person names and UPI handles, which shouldn't ship in the image's vocab.
    seen = Counter(t for f in feats for t in f)
    feats = [{t: 1 for t in f if seen[t] >= min_rows} for f in feats]
    dv = DictVectorizer(dtype=np.float32)
    X = dv.fit_transform(feats)
    lr = LogisticRegression(C=10, max_iter=4000).fit(X, [r["label"] for r in rows])
    np.savez_compressed(
        path,
        Wb=np.vstack([lr.coef_.T, lr.intercept_]).astype(np.float32),
        classes=lr.classes_.astype(str),
        vocab=np.array(dv.get_feature_names_out(), dtype=str),
    )
    return Model(path)


def main() -> None:
    rows = [json.loads(line) for line in open(LABELS)]
    y = np.array([r["label"] for r in rows])
    groups = [r["statement"] for r in rows]
    tmp = OUT.with_suffix(".cv.npz")
    agree = []
    for tr, te in GroupKFold(5).split(rows, y, groups):
        # Score only the random sample: the active-learning rows were picked
        # for being hard, so including them understates real-world agreement.
        te = [i for i in te if rows[i]["sample"] == "random"]
        m = fit([rows[i] for i in tr], tmp)
        agree += list(np.array(m.predict([rows[i] for i in te])) == y[te])
    tmp.unlink()
    print(f"{len(rows)} labels, {len(set(groups))} statements; "
          f"agreement with Gemma on held-out statements (random sample) {np.mean(agree):.1%}")
    m = fit(rows, OUT)
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB, {len(m.vocab)} features)")


if __name__ == "__main__":
    main()
