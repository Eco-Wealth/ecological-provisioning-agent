#!/usr/bin/env python3
"""Independent, deliberately bounded Python cross-check for research-v0 bundles.

No dependency on the JavaScript implementation, no authority or ecological verdict.
Only structural identity, graph, SHA-256, and claimed obligation closure are covered.
"""
import hashlib
import json
from collections import deque
import re
import sys
from datetime import datetime

HEX = re.compile(r"^[0-9a-f]{64}$")
FORMAT = "ecowealth-offline-research-v0"
CONSTITUTION = "fa5d86dcaf9eb54ecfe68588752c2ddfb3387532c0adcba47e1c5c794e892cdd"


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})", value):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def identity(value):
    if not isinstance(value, dict):
        return None
    scope, local = value.get("scopeReferent"), value.get("localId")
    if isinstance(scope, str) and scope and isinstance(local, str) and local:
        return (scope, local)
    return None


def inspect(bundle):
    """Check a narrow, defined intersection of the JS verifier's guarantees."""
    errors = set()
    if not isinstance(bundle, dict):
        return {"fail": True, "open": [], "closures": []}
    if bundle.get("format") != FORMAT:
        errors.add("format")
    constitution = bundle.get("constitution")
    if not isinstance(constitution, dict) or (constitution.get("identifier"), constitution.get("sha256")) != (
            "ECOWEALTH-CONSTITUTION-v1", CONSTITUTION):
        errors.add("constitution")
    raw_refs, raw_atts, raw_evidence = (bundle.get(k) for k in ("referents", "attestations", "evidence"))
    if not all(isinstance(v, list) for v in (raw_refs, raw_atts, raw_evidence)):
        return {"fail": True, "open": [], "closures": []}

    referents = set()
    ambiguous_referents = set()
    for r in raw_refs:
        if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not r["id"] or not isinstance(r.get("boundary"), str) or not r["boundary"]:
            errors.add("referent-format")
            continue
        if r["id"] in referents:
            errors.add("duplicate-referent")
            ambiguous_referents.add(r["id"])
        referents.add(r["id"])

    items, invalid = {}, set()
    for a in raw_atts:
        key = identity(a)
        if key is None or not isinstance(a.get("actor"), str) or not a["actor"] or not isinstance(a.get("role"), str) or not a["role"] or not isinstance(a.get("method"), str) or not a["method"] or timestamp(a.get("assertedAt")) is None or timestamp(a.get("effectiveAt")) is None or "authority" not in a or not all(isinstance(a.get(k), list) for k in ("concerns", "evidenceRefs", "relations")):
            errors.add("attestation-format")
            continue
        if key in items:
            errors.add("duplicate-attestation")
            invalid.add(key)
        else:
            items[key] = a
        if key[0] not in referents or key[0] in ambiguous_referents or not a["concerns"] or any(x not in referents or x in ambiguous_referents for x in a["concerns"]):
            errors.add("referent-resolution")
            invalid.add(key)

    evidence, bad_evidence = {}, set()
    for e in raw_evidence:
        if not isinstance(e, dict) or not isinstance(e.get("id"), str) or not e["id"] or e.get("access") not in ("inline", "restricted", "missing"):
            errors.add("evidence-format")
            continue
        eid = e["id"]
        if eid in evidence:
            errors.add("duplicate-evidence")
            bad_evidence.add(eid)
            continue
        evidence[eid] = e
        h = e.get("sha256")
        if "sha256" in e and (not isinstance(h, str) or HEX.fullmatch(h) is None):
            errors.add("invalid-sha")
            bad_evidence.add(eid)
        if e["access"] == "inline":
            if not isinstance(e.get("text"), str) or not isinstance(h, str) or HEX.fullmatch(h) is None:
                errors.add("missing-sha")
                bad_evidence.add(eid)
            elif hashlib.sha256(e["text"].encode("utf-8")).hexdigest() != h:
                errors.add("sha-mismatch")
                bad_evidence.add(eid)
        elif "text" in e:
            errors.add("withheld-exposure")
            bad_evidence.add(eid)

    graph = {key: [] for key in items}
    for key, a in items.items():
        for ref in a["evidenceRefs"]:
            if not isinstance(ref, str) or not ref or ref not in evidence:
                errors.add("bad-evidence-ref")
                invalid.add(key)
            if isinstance(ref, str) and ref in bad_evidence:
                invalid.add(key)
                if a["role"] == "disposition":
                    errors.add("tainted-disposition")
        for edge in a["relations"]:
            target = identity(edge.get("to")) if isinstance(edge, dict) else None
            if target not in items or not isinstance(edge.get("kind"), str) or not edge["kind"]:
                errors.add("bad-edge")
                invalid.add(key)
                continue
            if timestamp(items[target]["assertedAt"]) > timestamp(a["assertedAt"]):
                errors.add("forward-edge")
                invalid.add(key)
            if edge["kind"] != "contradicts":
                graph[key].append(target)
    colors = {}
    for root in graph:
        if root in colors:
            continue
        colors[root] = 1
        stack = [(root, iter(graph[root]))]
        while stack:
            node, edges = stack[-1]
            nxt = next(edges, None)
            if nxt is None:
                colors[node] = 2
                stack.pop()
            elif colors.get(nxt) == 1:
                errors.add("cycle")
            elif nxt not in colors:
                colors[nxt] = 1
                stack.append((nxt, iter(graph[nxt])))

    # Independent bounded projection: eliminate cycle participants and their
    # dependents, then propagate any other invalid causal ancestry upstream.
    dependents = {key: [] for key in graph}
    outstanding = {key: len(edges) for key, edges in graph.items()}
    for key, edges in graph.items():
        for target in edges:
            dependents[target].append(key)
    ready = deque(key for key, degree in outstanding.items() if degree == 0)
    while ready:
        node = ready.popleft()
        for dependant in dependents[node]:
            outstanding[dependant] -= 1
            if outstanding[dependant] == 0:
                ready.append(dependant)
    invalid.update(key for key, degree in outstanding.items() if degree > 0)
    queue = deque(invalid)
    while queue:
        for dependant in dependents[queue.popleft()]:
            if dependant not in invalid:
                invalid.add(dependant)
                queue.append(dependant)

    admitted = {key for key, a in items.items()
                if a["role"] == "obligation_admission" and key not in invalid}
    closure = set()
    for key, a in items.items():
        if a["role"] != "disposition":
            continue
        if a.get("effect") not in ("close", "confirm_open", "transform"):
            errors.add("invalid-effect")
        if a.get("effect") != "close":
            continue
        targets = {identity(edge.get("to")) for edge in a["relations"]
                   if isinstance(edge, dict) and edge.get("kind") == "disposes"}
        if not targets.intersection({k for k, value in items.items() if value["role"] == "obligation_admission"}):
            errors.add("orphan-close")
        if key not in invalid:
            closure.update(targets.intersection(admitted))
    return {"fail": bool(errors), "open": sorted(admitted - closure), "closures": sorted(closure)}


if __name__ == "__main__":
    print(json.dumps(inspect(json.load(sys.stdin)), sort_keys=True))
