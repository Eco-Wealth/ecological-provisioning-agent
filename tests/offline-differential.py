#!/usr/bin/env python3
"""Differential test: Python oracle vs Node CLI, against deterministic adversarial bundles."""
import copy
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "research" / "offline-v0"
spec = importlib.util.spec_from_file_location("independent_check", SOURCE / "independent_check.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SEED = json.loads((SOURCE / "fixtures" / "synthetic.json").read_text())


def by_id(b, id_):
    return next(a for a in b["attestations"] if a["localId"] == id_)


def node_inspect(bundle):
    with tempfile.TemporaryDirectory() as folder:
        path = pathlib.Path(folder) / "bundle.json"
        path.write_text(json.dumps(bundle))
        proc = subprocess.run(
            ["node", str(SOURCE / "cli.mjs"), str(path)],
            capture_output=True, text=True, check=False, timeout=30)
        if proc.returncode not in (0, 1):
            raise AssertionError(f"Node crashed: {proc.returncode}: {proc.stderr}")
        report = json.loads(proc.stdout)
        open_keys = sorted(tuple(json.loads(x)) for x in report["recordedState"]["openObligationAssertions"])
        closed = sorted(tuple(json.loads(x["obligation"])) for x in report["recordedState"]["closureAssertions"])
        return {"fail": proc.returncode == 1, "open": open_keys, "closures": closed}


def cases():
    yield "baseline", lambda b: None
    yield "tamper-inline", lambda b: b["evidence"][0].update(text="changed")
    yield "malformed-sha", lambda b: b["evidence"][0].update(sha256="xyz")
    yield "duplicate-evidence", lambda b: b["evidence"].append(copy.deepcopy(b["evidence"][0]))
    yield "duplicate-referent", lambda b: b["referents"].append(copy.deepcopy(b["referents"][0]))
    yield "missing-concern", lambda b: by_id(b, "obligation").update(concerns=["missing"])
    yield "missing-scope", lambda b: by_id(b, "disposition").update(scopeReferent="missing")
    yield "evidence-absent", lambda b: by_id(b, "disposition").update(evidenceRefs=["missing"])
    yield "evidence-object", lambda b: by_id(b, "disposition").update(evidenceRefs=[{"id": "note"}])
    yield "invalid-effect", lambda b: by_id(b, "disposition").update(effect="imaginary")
    yield "duplicate-obligation", lambda b: b["attestations"].append(copy.deepcopy(by_id(b, "obligation")))
    yield "future-disposition", lambda b: by_id(b, "disposition").update(assertedAt="2026-01-01T00:00:00Z")
    yield "self-edge", lambda b: by_id(b, "observation").update(relations=[{
        "kind": "based_on", "to": {"scopeReferent": "synthetic-place", "localId": "observation"}}])
    yield "disposition-tamper", lambda b: (
        by_id(b, "disposition").update(evidenceRefs=["note"]),
        b["evidence"][0].update(text="tampered"))
    yield "cyclic-admission", lambda b: by_id(b, "obligation").update(relations=[{
        "kind": "based_on", "to": {"scopeReferent": "synthetic-place", "localId": "obligation"}}])
    yield "cyclic-disposition", lambda b: by_id(b, "disposition")["relations"].append({
        "kind": "based_on", "to": {"scopeReferent": "synthetic-place", "localId": "disposition"}})
    yield "tainted-admission", lambda b: (
        by_id(b, "obligation").update(evidenceRefs=["note"]),
        b["evidence"][0].update(text="corrupt-attested-obligation"))
    yield "compromised-ancestor", lambda b: (
        b["attestations"].append({
            **copy.deepcopy(by_id(b, "observation")),
            "localId": "compromised-ancestor",
            "evidenceRefs": ["not-there"],
            "relations": []
        }),
        by_id(b, "disposition")["relations"].append({
            "kind": "based_on", "to": {
                "scopeReferent": "synthetic-place", "localId": "compromised-ancestor"
            }
        }))



class Differential(unittest.TestCase):
    def test_independent_oracle_matches_bounded_js_outcomes(self):
        for name, mutate in cases():
            with self.subTest(name=name):
                b = copy.deepcopy(SEED)
                mutate(b)
                py = module.inspect(b)
                js = node_inspect(b)
                self.assertEqual(py, js, f"differential disagreement for {name}")


if __name__ == "__main__":
    unittest.main()
