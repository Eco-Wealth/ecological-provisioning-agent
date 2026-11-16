#!/usr/bin/env python3
"""Independent experimental DSSE Ed25519 signature + journal replay cross-check.

Requires Python >=3.10 and OpenSSL 3 command-line utility. Uses the independently
written journal_check.py for the byte-chain. Does not import JavaScript logic.
This is narrower than the main verifier: no measurement validity, authority,
identity authentication, ecological outcome, revocation, or trusted timestamp.
Input: canonical signed-exchange JSON on stdin, optional expected key SHA256
as argument. The full journal is required; no network or secret keys are used.
"""
import base64
import binascii
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from journal_check import inspect as inspect_journal, pairs_unique, parse_time

FORMAT = "ecowealth-offline-signed-exchange-v0"
CHECKPOINT = "ecowealth-offline-checkpoint-v0"
TYPE = "application/vnd.ecowealth.offline-checkpoint-v0+json"
HEX = re.compile(r"[a-f0-9]{64}\Z")
MAX = 70 * 1024 * 1024
# A small-order public key lets anyone make a signature that passes, with no private key. These are the seven
# y encodings of libsodium's blocklist (1.0.20-RELEASE, src/libsodium/crypto_core/ed25519/ref10/ed25519_ref10.c,
# ge25519_has_small_order); as there, the top bit of the last byte (the sign of x) is ignored: 14 encodings.
SMALL_ORDER_Y = tuple(bytes.fromhex(y) for y in (
    "00000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000",  # 0 (order 4)
    "01000000 00000000 00000000 00000000 00000000 00000000 00000000 00000000",  # 1 (order 1)
    "26e8958f c2b227b0 45c3f489 f2ef98f0 d5dfac05 d3c63339 b1380288 6d53fc05",  # order 8
    "c7176a70 3d4dd84f ba3c0b76 0d10670f 2a2053fa 2c39ccc6 4ec7fd77 92ac037a",  # order 8
    "ecffffff ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff ffffff7f",  # p-1 (order 2)
    "edffffff ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff ffffff7f",  # p (=0, order 4)
    "eeffffff ffffffff ffffffff ffffffff ffffffff ffffffff ffffffff ffffff7f",  # p+1 (=1, order 1)
))


def small_order(point):
    return point[:31] + bytes([point[31] & 0x7F]) in SMALL_ORDER_Y


def decode(value, limit):
    if not isinstance(value, str) or len(value) > (limit * 4 // 3 + 16):
        raise ValueError("bounded base64 string required")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("invalid base64") from exc
    if len(raw) > limit or base64.b64encode(raw).decode() != value:
        raise ValueError("noncanonical or oversized base64")
    return raw


def inspect(raw, expected_key=None):
    if len(raw) > MAX or not raw.endswith(b"\n"):
        raise ValueError("package byte bound or newline error")
    envelope = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs_unique)
    if not isinstance(envelope, dict) or set(envelope) != {
        "format", "journal", "publicKeySpki", "envelope"
    } or envelope["format"] != FORMAT:
        raise ValueError("unsupported exchange format")
    signed = envelope["envelope"]
    if not isinstance(signed, dict) or set(signed) != {"payloadType", "payload", "signatures"}:
        raise ValueError("invalid DSSE envelope")
    if signed["payloadType"] != TYPE or not isinstance(signed["signatures"], list) or len(signed["signatures"]) != 1:
        raise ValueError("unsupported DSSE signature configuration")
    journal = envelope["journal"]
    if not isinstance(journal, str):
        raise ValueError("journal must be UTF-8 text")
    journal_bytes = journal.encode("utf-8")
    chain = inspect_journal(journal_bytes)
    public = decode(envelope["publicKeySpki"], 160)
    if not public.startswith(bytes.fromhex("302a300506032b6570032100")) or len(public) != 44:
        raise ValueError("expected canonical Ed25519 SPKI DER")
    if small_order(public[12:]):
        raise ValueError("public key is a small-order point")
    fingerprint = hashlib.sha256(public).hexdigest()
    if expected_key is not None and fingerprint != expected_key:
        raise ValueError("pinned Ed25519 key fingerprint mismatch")
    sig_record = signed["signatures"][0]
    if not isinstance(sig_record, dict) or set(sig_record) != {"keyid", "sig"} or sig_record["keyid"] != fingerprint:
        raise ValueError("signature key hint mismatch")
    signature = decode(sig_record["sig"], 64)
    if len(signature) != 64:
        raise ValueError("invalid Ed25519 signature length")
    payload = decode(signed["payload"], 4096)
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("checkpoint payload is not valid UTF-8") from exc
    checkpoint = json.loads(text, object_pairs_hook=pairs_unique)
    if not isinstance(checkpoint, dict) or set(checkpoint) != {
        "format", "publisher", "journalHead", "entryCount", "sequence",
        "issuedAt", "signerKeySha256"
    } or checkpoint["format"] != CHECKPOINT:
        raise ValueError("unsupported checkpoint")
    if json.dumps(checkpoint, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode() != payload:
        raise ValueError("noncanonical checkpoint bytes")
    records = journal_bytes[:-1].split(b"\n")
    genesis = json.loads(records[0].decode("utf-8"), object_pairs_hook=pairs_unique)
    last = json.loads(records[-1].decode("utf-8"), object_pairs_hook=pairs_unique)
    if checkpoint["publisher"] != genesis["record"]["value"]["source"] or (
        checkpoint["journalHead"] != chain["head"] or
        type(checkpoint["entryCount"]) is not int or checkpoint["entryCount"] != chain["entries"] or
        type(checkpoint["sequence"]) is not int or checkpoint["sequence"] != chain["entries"] - 1 or
        checkpoint["signerKeySha256"] != fingerprint or
        parse_time(checkpoint["issuedAt"]) < parse_time(last["recordedAt"])
    ):
        raise ValueError("checkpoint does not bind replayed journal")
    preimage = (b"DSSEv1 " + str(len(TYPE.encode())).encode() + b" " + TYPE.encode() +
                b" " + str(len(payload)).encode() + b" " + payload)
    with tempfile.TemporaryDirectory(prefix="vealth-signed-crosscheck-") as folder:
        d = Path(folder)
        (d / "key.der").write_bytes(public)
        (d / "signature").write_bytes(signature)
        (d / "preimage").write_bytes(preimage)
        try:
            result = subprocess.run(
                ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(d / "key.der"),
                 "-keyform", "DER", "-rawin", "-in", str(d / "preimage"),
                 "-sigfile", str(d / "signature")],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                timeout=8, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError("OpenSSL verification unavailable") from exc
        if result.returncode != 0:
            raise ValueError("Ed25519 DSSE signature verification failed")
    return {
        "valid": True, "head": chain["head"], "entries": chain["entries"],
        "signerKeySha256": fingerprint,
        "scope": "independent journal hash-chain and Ed25519 checkpoint bytes only"
    }


def main():
    try:
        if len(sys.argv) > 2 or (len(sys.argv) == 2 and not HEX.fullmatch(sys.argv[1])):
            raise ValueError("usage: signed_exchange_check.py [pinned-key-sha256]")
        result = inspect(sys.stdin.buffer.read(MAX + 1),
                         sys.argv[1] if len(sys.argv) == 2 else None)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, TypeError, KeyError, UnicodeError, OverflowError) as error:
        print(json.dumps({"valid": False, "error": str(error)}, sort_keys=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
