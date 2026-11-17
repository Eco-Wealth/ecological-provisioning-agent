# Offline signed journal exchange (experimental v0)

This module adds **optional** signed checkpoint envelopes to the existing local JSONL journal. It modifies no constitutional bytes, Referent/Attestation identity model, payments, wallets, or deployed services.

## What is actually checked

The experimental `signed-exchange.mjs` uses **Ed25519** (RFC 8032) and the **DSSE v1 pre-authenticated encoding (PAE)** over a canonical JSON checkpoint payload, signed as bytes. There is exactly one signature in this version; it must match a canonical Ed25519 SPKI public key included in the exchange. The key ID is SHA-256 over the exact SPKI DER bytes. This is not a decentralized identity or credential standard. It does not reuse `journal.mjs` canonicalization as an IETF RFC 8785/JCS conformance claim; the existing local journal uses its own deterministic sorting and serialization.

The signed checkpoint includes the declared publisher, complete journal head, entry count, last sequence, asserted issuance time, and key fingerprint. The inspector:

1. Replays every journal hash, canonical line, reference, existing research bundle rule, and experimental measurement structural rule.
2. Recomputes the journal head, sequence and source before checking the signed checkpoint.
3. Checks DSSE payload type, Ed25519 signature, exact signer key fingerprint, and checkpoint-to-journal binding.
4. Optionally matches the source name and signer public-key fingerprint to a value supplied **independently** by the receiver.
5. Optionally checks a previously saved sequence/head pair against the complete imported history, detecting a self-consistent rewrite that diverged from that independent prior checkpoint.
6. When two signed journals are submitted, preserves their separate history, flags reused inline measurement evidence SHA-256 digests and warns if both publisher labels share the same signing public key.
7. For two signed histories claiming the **same** source and signing key, compares their full replayed hash chains and warns at the first conflicting sequence rather than classifying a valid extension as a fork.
8. Keeps ecological quality, authority, calibration, truthful time, and independent sampling UNKNOWN. Different signing keys and different hashes are not proof of separate operators or observations.

**Important:** the public key embedded in an envelope is **self-asserted**, not a verified real-world identity. A valid signature proves only that the owner of that key signed those checkpoint bytes. Publisher identity becomes *conditionally* bound only when the receiver independently stores and checks the publisher name and key fingerprint. A declared signing timestamp is still an unverified statement. A local checkpoint and an Ed25519 signature do not constitute an independent timestamping service, durable global transparency log, or constitutional ratification.

## Data shape and algorithms

- `format`: `ecowealth-offline-signed-exchange-v0`
- `journal`: the entire canonical `ecowealth-local-journal-v0` JSONL, including trailing newline.
- `publicKeySpki`: canonical Base64 of DER-encoded Ed25519 SPKI.
- `envelope.payloadType`: `application/vnd.ecowealth.offline-checkpoint-v0+json`.
- `envelope.payload`: canonical Base64 of the UTF-8 checkpoint bytes.
- `envelope.signatures`: exactly one `{ keyid, sig }` Ed25519 signature over DSSE PAE.

All imported package bytes are bounded, canonical Base64 is enforced, and `readSignedExchange` requires exact canonical JSON with trailing newline. No arbitrary external URI is fetched.

This v0 deliberately does **not** persist or generate private keys. `signJournal` only accepts an existing in-memory Ed25519 private key. The demo/test makes disposable fictional key pairs in memory; they are never hardcoded or committed. For real use, secret key custody, identity governance, rotation, revocation, recovery and independent signing-time receipts require a separately reviewed design.

## Run without a VEALTH server

From the repository root:

```sh
node --test tests/offline-signed-exchange.test.mjs
node --test tests/*.test.mjs
python3 tests/offline-differential.py
```

The independent `signed_exchange_check.py` replays the journal using the separately written Python byte-chain checker and uses the system OpenSSL 3 utility to verify the Ed25519 DSSE signature; this is cross-implementation validation, not an independent trust authority. The Python checker needs the `openssl` command-line tool and runs the one it finds on the PATH. The tests create two synthetic journals, generate ephemeral keys in memory, independently checkpoint each history, exchange the resulting signed records, verify saved historical anchors, and contest an inconsistent fictional measurement. They assert FAIL on tampering and bad trust anchors; WARN on reused evidence and aliased signing keys; UNKNOWN where identity or ecological proof is missing.

## Hard review boundaries

1. No production signer/key manager, no external identity authentication, no secure publishing clock, and no network access.
2. The entire journal is included: **do not distribute private/restricted material**. Restricted evidence records omit inline text but the journal may contain other sensitive metadata. A privacy and consent review is required before any real exchange.
3. The older `inspectExchange` only matches self-asserted publisher heads. Use `inspectSignedPair` for signed-exchange tests; a direct unsigned comparison must not be treated as cryptographically authenticated.
4. A pinned key does not establish an authorized delegate or legally valid disposition. Copying identical measurement evidence may indicate common source material, but not fraud without additional evidence. Different evidence bytes may still be copied, derived, or invented.
5. Support for key rotation and revocation, anti-equivocation across witnesses, reproducible external method evidence, and observational independence remains **future engineering**, not a v0 capability.

Relevant upstream specifications: [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032), [DSSE protocol](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md). The journal's local canonicalizer is **not** claimed to implement [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).


## Conflicting signed histories

`inspectSignedHistoryConflict(first, second, trust)` verifies each full journal and checkpoint, then compares the consecutive entry digests for one declared publisher and signing key. **HF002=WARN** reports the first divergent sequence if the signer has endorsed two incompatible complete histories; **HF002=PASS** means identical history or an exact prefix extension. The warning is proof of cryptographically inconsistent statements **by one signing key**, not necessarily proof of a dishonest person: key compromise, duplication, or legitimate recovery protocols can also explain conflicts. Publisher attribution remains UNKNOWN without independently pinned keys and institutional governance.

## What the signing code does, and where it stops

Every status is PASS, FAIL, WARN or UNKNOWN, and every report that `inspectSignedExchange`, `inspectSignedPair` and `inspectSignedHistoryConflict` return carries `experimental: true`. None is a score, a rank or a judgement about a publisher, a person or a place.

**What is signed.**

- The signature is Ed25519 over the DSSE v1 pre-authenticated encoding of two things: the payload type `application/vnd.ecowealth.offline-checkpoint-v0+json` and the exact checkpoint bytes. A signature made over the checkpoint bytes alone, or over the same bytes under another payload type, fails SP003. The encoding gives the DSSE protocol's own example, `DSSEv1 29 http://example.com/HelloWorld 11 hello world`.
- The checkpoint must be the canonical JSON of exactly seven members: `format`, `publisher`, `journalHead`, `entryCount`, `sequence`, `issuedAt` and `signerKeySha256`. In the cases tried (the same JSON with line breaks and spaces added, an extra member, a digest in capital letters), SP003 fails even when the right key signed it. These are examples, not a complete list.
- The journal itself is not signed. The checkpoint names its head, and the inspector replays the whole journal and checks that the head, the entry count, the last sequence and the publisher (the source in the journal's first record) are the values that were signed. A journal cut short fails SP003, and a journal with one byte changed fails SP002.
- `issuedAt` is whatever the signer wrote. The code checks only that it is a valid time no earlier than the last record, so a time in the year 9999 passes.
- The public key travels inside the exchange. Its fingerprint, the sha256 of its exact SPKI DER bytes, must equal both `signerKeySha256` and the signature's `keyid`. A valid signature by another key fails SP003.

**Malformed input.** The rule: when the envelope, the journal, the public key, the checkpoint or the signature does not check out, `inspectSignedExchange` returns a FAIL and no bundle, and throws no error. Cases tried that gave a FAIL: a missing or extra member, another format, no signature or two, a signature of 63 or 65 bytes, a signature in base64url or with a line break, a signature with L added to its S half, an X25519 or Ed448 key, a key with one extra byte, and a payload that is not JSON. These are examples, not a complete list. **Both checkers refuse invalid UTF-8.** The checkpoint bytes become text only through a strict decoder, so invalid UTF-8 anywhere in them fails SP003 with the reason "checkpoint payload is not valid UTF-8", even when the right key signed those bytes, and the Python check exits 1 with the same words. Cases tried: one invalid byte (ff, 80, c0, fe or a0) in place of a U+FFFD in the publisher name, the two bytes c0 af in its place, an encoded surrogate (ed a0 80) in its place, an invalid byte after the publisher name, and one appended after the JSON. A byte order mark before the JSON also fails in both: the decoder keeps it, and the JSON parser refuses it. **A lone surrogate** (half of a pair, written in JSON as an escape such as `\ud800`) in any string of the checkpoint fails SP003 in the main code with the reason "checkpoint text holds a lone surrogate", as it does in the Python check; a whole pair, an emoji for example, passes. The lone-surrogate check uses `String.prototype.isWellFormed`, so it needs Node 20 or newer; on an older Node the checker refuses rather than passes. A signature in base64url is refused because the data shape above asks for canonical Base64; the DSSE protocol (version 1.0.2) asks a verifier to accept either, so here this code is stricter than DSSE. `inspectSignedPair` given a third argument that is not an object (`null`, for example) returns one PX001 FAIL and no comparison, and throws no error. When SP003 fails, its reason carries the error message, which for a payload that is not JSON quotes the payload's first characters.

**Small-order public keys.** Under a small-order public key anyone can make a signature that Ed25519 verification accepts, with no private key: S is zero and R is a small-order point, and the signer chooses `issuedAt`, so a few tries find a checkpoint that passes. Both checkers refuse such a key before the signature is checked. SP003 fails with the reason "public key is a small-order point" when the 32 key bytes, with the top bit of the last byte cleared, are one of the seven entries of libsodium's small-order list (version 1.0.20, `ge25519_has_small_order` in `crypto_core/ed25519/ref10/ed25519_ref10.c`). That is 14 encodings: the identity point, the point of order 2, the two points of order 4 and the four of order 8, and the encodings that spell some of them with a y value of p or p + 1, or with the sign bit set where x is zero. The Python check exits 1 with the same words for the same 14. Under each of the 14, a signature of that form was found that Node's own Ed25519 verify accepts (tried with Node 20.20.0). A key that is not on the list is not checked for its order.

**Pins and anchors.**

- SP004 is PASS only when the receiver pins both the publisher name and the key fingerprint and both match. Pinning only one of the two gives UNKNOWN. A mismatch, or a trust value that is not an object holding only `publisher`, `publicKeySha256` and `anchor`, gives FAIL. The code cannot tell where a pinned value came from.
- An anchor is a sequence number and an entry hash that the receiver saved earlier and passes in. SP005 checks only that the entry at that sequence has that hash. That shows the history up to that entry is unchanged: a history rewritten after the anchored entry still passes, and one rewritten at or before it fails. An anchor past the end of the journal fails, so a journal cut shorter than the anchor is caught.
- With no anchor, an older journal signed by the same key gets no FAIL, so nothing here tells an old exchange from the newest one.
- A reader who needs freshness pins a recent anchor: an exchange whose journal ends before the anchored entry fails SP005.
- Nothing in these files reads a blockchain, a server or any outside log. An anchor here is only a value the caller passes in.

**Evidence reuse.**

- PX003 looks only at inline evidence whose text matches its declared sha256 and that a measurement names in its own `evidenceRefs`. It gives WARN when the same digest is in both bundles.
- It does not look at restricted or missing evidence, or at evidence named only by an attestation that has no measurement, and text that differs by one byte is not matched (one added space was enough).
- A WARN shows that the same bytes are in both bundles. It does not show where they came from or that either copy is genuine. UNKNOWN shows only that no such digest matched.

**Two histories under one key.** HF002 compares the two journals entry by entry by hash. It gives WARN at the first sequence where they differ, and PASS when they are the same or one is the other with entries added at the end. It runs only when neither exchange has a FAIL under the same trust value and both name the same publisher and key. Otherwise HF001 is FAIL or UNKNOWN and nothing is compared.

**Keys.**

- `signJournal` takes a private key as a key object or as PEM text. It makes no key and saves no key, and its result holds only the journal, the public key, the payload and the signature: none of the private key's PKCS8, seed or JWK forms appear in it.
- Nothing in these files prints or logs a key. The Python check writes the public key, the signature and the signed bytes to a temporary folder that it removes, and runs the `openssl` it finds on the PATH.
- The tests make their keys in memory with `generateKeyPairSync`, and no file holds a key.

**The Python check.** It refuses the same small-order keys and the same invalid UTF-8 as the main code, with the same reasons. It refuses a package whose bytes are not the canonical form (pretty-printed, members out of order, or a letter written as an escape, for example), as `readSignedExchange` does; its reason is "noncanonical package bytes". Both checkers refuse a checkpoint whose publisher name holds a lone surrogate (written in the JSON as an escape such as `\ud800`). The main code also refuses an evidence text that holds one (SP002), even when the declared digest is of the text with U+FFFD in its place; the Python check does not run the bundle rules and still accepts such a package. A very deeply nested input gets its one-line JSON answer and exit 1; the main reader throws an error on it and returns no package. It does not run the bundle or measurement rules.
