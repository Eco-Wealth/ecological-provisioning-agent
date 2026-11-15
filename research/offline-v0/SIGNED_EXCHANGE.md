# Offline signed journal exchange — experimental v0

This module adds **optional** signed checkpoint envelopes to the existing public-local JSONL journal. It modifies no constitutional bytes, Referent/Attestation identity model, private-origin exports, existing PRs, payments, wallets, or deployed services.

## What is actually verified

The experimental \`signed-exchange.mjs\` uses **Ed25519** (RFC 8032) and the **DSSE v1 pre-authenticated encoding (PAE)** over a canonical JSON checkpoint payload, signed as bytes. There is exactly one signature in this version; it must match a canonical Ed25519 SPKI public key included in the exchange. The key ID is SHA-256 over the exact SPKI DER bytes. This is not a decentralized identity or credential standard. It does not reuse \`journal.mjs\` canonicalization as an IETF RFC 8785/JCS conformance claim; the existing local journal uses its own deterministic sorting and serialization.

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

- \`format\`: \`ecowealth-offline-signed-exchange-v0\`
- \`journal\`: the entire canonical \`ecowealth-local-journal-v0\` JSONL, including trailing newline.
- \`publicKeySpki\`: canonical Base64 of DER-encoded Ed25519 SPKI.
- \`envelope.payloadType\`: \`application/vnd.ecowealth.offline-checkpoint-v0+json\`.
- \`envelope.payload\`: canonical Base64 of the UTF-8 checkpoint bytes.
- \`envelope.signatures\`: exactly one \`{ keyid, sig }\` Ed25519 signature over DSSE PAE.

All imported package bytes are bounded, canonical Base64 is enforced, and \`readSignedExchange\` requires exact canonical JSON with trailing newline. No arbitrary external URI is fetched.

This v0 deliberately does **not** persist or generate private keys. \`signJournal\` only accepts an existing in-memory Ed25519 private key. The demo/test makes disposable fictional key pairs in memory; they are never hardcoded or committed. For real use, secret key custody, identity governance, rotation, revocation, recovery and independent signing-time receipts require a separately reviewed design.

## Run without a VEALTH server

From the repository root:

\`\`\`sh
node --test tests/offline-signed-exchange.test.mjs
node --test tests/*.test.mjs
python3 tests/offline-differential.py
\`\`\`

The tests create two synthetic journals, generate ephemeral keys in memory, independently checkpoint each history, exchange the resulting signed records, verify saved historical anchors, and contest an inconsistent fictional measurement. They assert FAIL on tampering and bad trust anchors; WARN on reused evidence and aliased signing keys; UNKNOWN where identity or ecological proof is missing.

## Hard review boundaries

1. No production signer/key manager, no external identity authentication, no secure publishing clock, and no network access.
2. The entire journal is included: **do not distribute private/restricted material**. Restricted evidence records omit inline text but the journal may contain other sensitive metadata. A privacy and consent review is required before any real exchange.
3. The older \`inspectExchange\` only matches self-asserted publisher heads. Use \`inspectSignedPair\` for signed-exchange tests; a direct unsiged comparison must not be treated as cryptographically authenticated.
4. A pinned key does not establish an authorized delegate or legally valid disposition. Copying identical measurement evidence may indicate common source material, but not fraud without additional evidence. Different evidence bytes may still be copied, derived, or invented.
5. Support for key rotation and revocation, anti-equivocation across witnesses, reproducible external method evidence, and observational independence remains **future engineering**, not a v0 capability.

Relevant upstream specifications: [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032), [DSSE protocol](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md). The journal's local canonicalizer is **not** claimed to implement [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).


## Conflicting signed histories

\`inspectSignedHistoryConflict(first, second, trust)\` verifies each full journal and checkpoint, then compares the consecutive entry digests for one declared publisher and signing key. **HF002=WARN** reports the first divergent sequence if the signer has endorsed two incompatible complete histories; **HF002=PASS** means identical history or an exact prefix extension. The warning is proof of cryptographically inconsistent statements **by one signing key**, not necessarily proof of a dishonest person: key compromise, duplication, or legitimate recovery protocols can also explain conflicts. Publisher attribution remains UNKNOWN without independently pinned keys and institutional governance.
