"""Self-check for the student model: python test_categorise.py (needs numpy only)."""
import glob
import json
import sys
import time
from pathlib import Path

from categorise import CATEGORIES, Model, categorise_and_summarise

HERE = Path(__file__).resolve().parent
MODEL = HERE / "models" / "pfm-student.npz"
if not MODEL.exists():
    print(f"skipped: {MODEL} is not in git; see the README's \"Not in this repo\"")
    sys.exit(0)
model = Model(MODEL)

# Unambiguous rows the model must get right.
rows = [
    {"date": "2026-01-01", "amount": 95000.0, "narration": "SALARY CREDIT FOR THE MONTH"},
    {"date": "2026-01-02", "amount": -5.9, "narration": "IMPS Charge"},
    {"date": "2026-01-03", "amount": -247.0, "narration": "UPI/DR/123/ZOMATO LIMITED/YESB/zomato-order"},
    {"date": "2026-01-04", "amount": -25000.0, "narration": "ACH DR HDFC HOME LOAN EMI"},
    {"date": "2026-01-05", "amount": 10.0, "narration": ""},  # empty narration still gets a category
]
out = categorise_and_summarise([{"bank": "t", "transactions": rows}], model=model)
cats = [t["category"] for t in out["transactions"]]
assert cats[:4] == ["INCOME", "FEES_CHARGES", "FOOD", "EMI_LOAN"], cats
assert all(c in CATEGORIES for c in cats)
s = out["summary"]
assert s["net_cashflow"] == round(s["total_income"] - s["total_spend"], 2)
assert categorise_and_summarise([], model=model)["transactions"] == []

# Speed on a real 140-row mock-AA statement, if the sibling airlock repo is present.
files = glob.glob(str(HERE.parent / "airlock/test_data/BS-Data/*/*.json"))
if files:
    stmt = json.load(open(files[0]))
    stmt["transactions"] = (stmt["transactions"] * 140)[:140]
    t = time.perf_counter()
    out = categorise_and_summarise([stmt], model=model)
    ms = (time.perf_counter() - t) * 1e3
    assert len(out["transactions"]) == 140 and ms < 1000, ms
    print(f"140 transactions in {ms:.1f} ms")
print("ok")
