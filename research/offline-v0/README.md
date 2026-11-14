# Offline ecological record inspector (research v0)

This is a **publicly runnable, non-normative research prototype**, adapted from the 2026-11-14 Vealth kernel engineering review. It is **not** the Vealth Standard, a constitutional conformance certificate, a field verifier, or a replacement for independent governance.

Two root identity types are modeled: **Referent** and **Attestation**. Observation, work proposal, obligation, disposition, payment and settlement are derived Attestation roles, not new permanent primitives.

The inspector checks local identity uniqueness, graph references, record-time disposition assertions, declared Constitution digest, inline SHA-256 evidence integrity and accidental exposure of restricted content.

Attestation identities are represented as JSON-encoded ordered pairs, for example `["synthetic-place","obligation"]`, including in report snapshots. The two fields remain separate and are never joined by a delimiter: a scope containing `::` must not alias another `(scope, localId)` pair. This is an experimental report encoding, not a constitutional serialization standard. Unknown authority, cryptographic signatures, real-world work, funding, settlement and ecological outcomes remain **UNKNOWN**. A digest match proves only that supplied bytes match; it does not establish that the evidence is true.

Usage from repository root:

    node research/offline-v0/cli.mjs research/offline-v0/fixtures/synthetic.json
    node research/offline-v0/cli.mjs research/offline-v0/fixtures/synthetic.json 2026-01-02T12:00:00Z
    node --test tests/*.test.mjs

CLI status: 0 means no structural/hash failures under these limited research rules; 1 means at least one failure; 2 means usage or parsing error. A status of 0 **never means verified, approved, funded, settled or safe**.

The fixture is fictional. No network, live wallet, field inspection, external API, blockchain or key is accessed. All source files in this folder are public-local and are **not** copied from the private export manifest. Exported client and Constitution files remain owned by the controlled private-origin publication path.

Research constraints and source: 2026-11-14 v4 review bundle, especially INCREMENT_V4, the verifier parity tests and the two-primitive identity model. The public inspector intentionally narrows the research surface and must not be presented as full parity with that bundle's 227 tests.
