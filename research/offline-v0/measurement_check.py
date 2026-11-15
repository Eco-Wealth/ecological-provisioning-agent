#!/usr/bin/env python3
"""Independent bounded Python oracle for selected research measurement rules.

Not a complete scientific standard validator. Does not reuse JavaScript rules
or calculate ecological improvement. Read JSON from stdin; output rule statuses.
"""
import hashlib
import json
import math
import re
import sys
from datetime import datetime

FORMAT = "ecowealth-quantitative-observation-v0"
HEX = re.compile(r"[0-9a-f]{64}\Z")
UNITS = ("mm", "cm", "m")


def timestamp(value):
    if not isinstance(value, str):
        return None
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})", value):
        return None
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return date if 1 <= date.year <= 9999 else None
    except ValueError:
        return None


def finite(value):
    return type(value) in (int, float) and math.isfinite(value) and abs(value) <= 1e12


def word(value, limit=256):
    return isinstance(value, str) and 0 < len(value) <= limit


def inspect(bundle):
    out = []
    referents = {}
    for r in bundle["referents"]:
        if not isinstance(r, dict) or not word(r.get("id")):
            continue
        ident = r["id"]
        referents[ident] = None if ident in referents else r.get("boundary")
    evidence = {}
    for e in bundle["evidence"]:
        if not isinstance(e, dict) or not word(e.get("id")):
            continue
        ident = e["id"]
        evidence[ident] = None if ident in evidence else e
    for a in bundle["attestations"]:
        m = a.get("measurement")
        if not isinstance(m, dict):
            continue
        statuses = {}
        f = m.get("featureOfInterest")
        ref_id = f.get("referentId") if isinstance(f, dict) else None
        boundary = referents.get(ref_id)
        boundary_hash = f.get("boundarySha256") if isinstance(f, dict) else None
        statuses["MV002"] = "PASS" if (
            isinstance(boundary, str) and word(ref_id) and ref_id == a.get("scopeReferent")
            and isinstance(a.get("concerns"), list) and ref_id in a["concerns"]
            and isinstance(boundary_hash, str) and HEX.fullmatch(boundary_hash)
            and hashlib.sha256(boundary.encode()).hexdigest() == boundary_hash
        ) else "FAIL"
        result = m.get("result")
        statuses["MV003"] = "PASS" if (
            isinstance(result, dict) and finite(result.get("value"))
            and result.get("unit") in UNITS
            and finite(result.get("uncertaintyAbsolute"))
            and result["uncertaintyAbsolute"] >= 0
        ) else "FAIL"
        interval = m.get("phenomenonTime")
        start = timestamp(interval.get("start")) if isinstance(interval, dict) else None
        end = timestamp(interval.get("end")) if isinstance(interval, dict) else None
        finished = timestamp(m.get("resultTime"))
        asserted = timestamp(a.get("assertedAt"))
        statuses["MV004"] = "PASS" if (
            start and end and finished and asserted
            and start <= end <= finished <= asserted
        ) else "FAIL"
        proc = m.get("procedure")
        sampling = m.get("sampling")
        limitations = m.get("limitations")
        count = sampling.get("sampleCount") if isinstance(sampling, dict) else None
        statuses["MV005"] = "PASS" if (
            word(m.get("observedProperty"), 500)
            and isinstance(proc, dict) and word(proc.get("id"), 500) and word(proc.get("version"), 100)
            and isinstance(sampling, dict) and word(sampling.get("description"), 1000)
            and type(count) is int and 1 <= count <= 1000000
            and word(m.get("source"), 500) and isinstance(limitations, list)
            and 1 <= len(limitations) <= 20
            and all(word(x, 1000) for x in limitations)
        ) else "FAIL"
        refs = m.get("evidenceRefs")
        record_refs = a.get("evidenceRefs")
        if not isinstance(refs, list) or not 1 <= len(refs) <= 100 or not isinstance(record_refs, list):
            statuses["MV006"] = "FAIL"
        else:
            status = "PASS"
            seen = set()
            for eid in refs:
                if not word(eid) or eid in seen or eid not in record_refs or eid not in evidence:
                    status = "FAIL"
                    break
                seen.add(eid)
                e = evidence[eid]
                if not isinstance(e, dict):
                    status = "FAIL"
                    break
                if e.get("access") == "inline":
                    h = e.get("sha256")
                    if not isinstance(e.get("text"), str) or not isinstance(h, str) or not HEX.fullmatch(h) or hashlib.sha256(e["text"].encode()).hexdigest() != h:
                        status = "FAIL"
                        break
                elif e.get("access") in ("restricted", "missing"):
                    status = "UNKNOWN"
                else:
                    status = "FAIL"
                    break
            statuses["MV006"] = status
        out.append(statuses)
    return out


def main():
    payload = sys.stdin.read(2 * 1024 * 1024 + 1)
    if len(payload.encode()) > 2 * 1024 * 1024:
        raise ValueError("input exceeds experimental limit")
    data = json.loads(payload)
    if not isinstance(data, dict) or any(not isinstance(data.get(k), list) for k in ("referents", "attestations", "evidence")):
        raise ValueError("bundle arrays missing")
    print(json.dumps(inspect(data), sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, TypeError, KeyError, UnicodeError) as exc:
        print("independent measurement checker error: " + str(exc), file=sys.stderr)
        sys.exit(2)
