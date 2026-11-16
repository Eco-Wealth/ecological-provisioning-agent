#!/usr/bin/env python3
"""Independent Python byte-level verification for public research journal v0.

Hashes the raw canonical body of each JSONL entry, rather than converting JSON
numbers and serializing them again. This avoids Python/ECMAScript float notation
differences. Does not independently attest time, actor, authority, or ecology.
"""
import hashlib
import json
import re
import sys
from datetime import datetime

FORMAT = "ecowealth-local-journal-v0"
CONSTITUTION = "fa5d86dcaf9eb54ecfe68588752c2ddfb3387532c0adcba47e1c5c794e892cdd"
HEX = re.compile(r"^[a-f0-9]{64}$")
TOP = re.compile(rb'^\{"hash":"([0-9a-f]{64})",')
STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$")


def pairs_unique(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON key")
        value[key] = item
    return value


def parse_time(value):
    if not isinstance(value, str) or not STAMP.fullmatch(value):
        raise ValueError("invalid RFC3339 record time")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError("timezone required")
        return result
    except (ValueError, OverflowError) as error:
        raise ValueError("invalid calendar time") from error


def inspect(raw, expected=None):
    if len(raw) > 64 * 1024 * 1024 or not raw.endswith(b"\n"):
        raise ValueError("journal exceeds byte limit or lacks trailing newline")
    lines = raw[:-1].split(b"\n")
    if not 1 <= len(lines) <= 25001:
        raise ValueError("journal entry count outside bounds")
    previous = "0" * 64
    recorded_time = None
    for i, line in enumerate(lines):
        if len(line) > 17 * 1024 * 1024:
            raise ValueError("oversized journal entry")
        match = TOP.match(line)
        if match is None:
            raise ValueError("noncanonical top-level journal entry")
        actual = match.group(1).decode("ascii")
        # The JavaScript writer places hash first and uses canonical ordering.
        # All remaining bytes, beginning with '{', are precisely the signed
        # hash preimage. No float round-trip or JSON reserialization occurs.
        preimage = b"{" + line[match.end():]
        if hashlib.sha256(preimage).hexdigest() != actual:
            raise ValueError("journal digest mismatch at entry %d" % i)
        try:
            record = json.loads(line.decode("utf-8"), object_pairs_hook=pairs_unique,
                                parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite number")))
        except (UnicodeError, ValueError) as error:
            raise ValueError("invalid or ambiguous JSON at entry %d" % i) from error
        if type(record) is not dict or set(record) != {"hash", "prevHash", "record", "recordedAt", "seq"}:
            raise ValueError("unexpected journal envelope at entry %d" % i)
        if type(record["seq"]) is not int or record["seq"] != i or record["prevHash"] != previous:
            raise ValueError("reordered or disconnected journal at entry %d" % i)
        current_time = parse_time(record["recordedAt"])
        if recorded_time is not None and current_time < recorded_time:
            raise ValueError("journal time regressed")
        value = record["record"]
        if not isinstance(value, dict) or set(value) != {"kind", "value"} or not isinstance(value["value"], dict):
            raise ValueError("malformed record at entry %d" % i)
        if i == 0:
            if value["kind"] != "genesis" or value["value"].get("journalFormat") != FORMAT or not value["value"].get("source"):
                raise ValueError("missing versioned genesis")
            if value["value"].get("constitution") != {
                    "identifier": "ECOWEALTH-CONSTITUTION-v1", "sha256": CONSTITUTION}:
                raise ValueError("unexpected constitutional digest")
        else:
            if value["kind"] not in ("referent", "attestation", "evidence"):
                raise ValueError("unsupported record kind")
            if value["kind"] == "attestation":
                asserted = parse_time(value["value"].get("assertedAt"))
                if asserted > current_time:
                    raise ValueError("backdated local journal receipt")
        previous = actual
        recorded_time = current_time
    if expected is not None and (not HEX.fullmatch(expected) or expected != previous):
        raise ValueError("trusted head checkpoint does not match")
    return {"valid": True, "head": previous, "entries": len(lines),
            "scope": "byte-chain and local timestamps only"}


def main(argv):
    if len(argv) > 1:
        print("Usage: python3 research/offline-v0/journal_check.py [trusted-head]", file=sys.stderr)
        return 2
    try:
        result = inspect(sys.stdin.buffer.read(64 * 1024 * 1024 + 1),
                         argv[0] if argv else None)
        print(json.dumps(result, sort_keys=True))
        return 0
    except ValueError as error:
        print(json.dumps({"valid": False, "error": str(error)}, sort_keys=True))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
