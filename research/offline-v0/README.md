# Offline ecological record inspector (research v0)

This is a **publicly runnable, non-normative research prototype**, adapted from the 2026-11-14 Vealth kernel engineering review. It is **not** the Vealth Standard, a constitutional conformance certificate, a field verifier, or a replacement for independent governance.

Two root identity types are modeled: **Referent** and **Attestation**. Observation, work proposal, obligation, disposition, payment and settlement are derived Attestation roles, not new permanent primitives.

The inspector checks local identity uniqueness, graph references, record-time disposition assertions, declared Constitution digest, inline SHA-256 evidence integrity and accidental exposure of restricted content.

The graph inspector rejects self-referential causal links and circular dependencies, and prevents malformed or forward-pointing dispositions from being counted as closure assertions. Reciprocal `contradicts` relations are contestation, not causal cycles. Historical `asOf` views only include contradiction assertions recorded on or before the requested time. These checks establish internal consistency of declarations, not the truth of an observation or the authority to act. Research-v0 recognizes the disposition effect labels `close`, `confirm_open`, and `transform`; unknown labels fail validation. Only `close` currently produces a closure assertion. Other effects are retained as records, not interpreted as completed obligations.

Attestation identities are represented as JSON-encoded ordered pairs, for example `["synthetic-place","obligation"]`, including in report snapshots. The two fields remain separate and are never joined by a delimiter: a scope containing `::` must not alias another `(scope, localId)` pair. This is an experimental report encoding, not a constitutional serialization standard. Unknown authority, cryptographic signatures, real-world work, funding, settlement and ecological outcomes remain **UNKNOWN**. A digest match proves only that supplied bytes match; it does not establish that the evidence is true.

## Evidence lineage and projection safety

The inspector compares verified inline SHA-256 digests, warning when identical bytes appear under multiple evidence IDs (E009) or the same ID is repeated by an Attestation (E010). A cryptographic byte match is not independent corroboration, authenticity, or scientific proof. Restricted or missing evidence remains UNKNOWN even if a syntactically valid digest was supplied. Malformed digest commitments fail E011.

Malformed attestation referents, ambiguous duplicate identities, and absent evidence references are excluded from the research obligation projection. A closing disposition citing corrupted evidence also cannot clear an obligation in the displayed projection. These conservative filters do not decide whether an obligation is legally or constitutionally open: authority, admission and disposition remain unverified. Inspect all FAIL and UNKNOWN findings before interpreting a projection.

## Bounded resource use

Research-v0 deliberately fails closed before graph construction if a bundle exceeds 25,000 Referents, 25,000 Attestations, 25,000 evidence identities, or 100,000 relation entries. Individual inline evidence text is capped at 16 MiB of UTF-8. These are implementation guardrails for this prototype, not a constitutional limit on ecological work or a protocol-wide maximum. A limit failure does **not** mean the underlying claims are false; split records into independently attributable bundles and retain cross-bundle lineage.

## Independent cross-implementation experiment

Run `python3 tests/offline-differential.py` from repository root. This compares a separately written, dependency-free Python oracle with the Node CLI on a fixed set of synthetic adversarial bundles. CI runs it after the JavaScript tests. The Python checker deliberately covers only a narrow intersection: identity/referent consistency, local SHA-256 integrity, causal graph relationships, and asserted closure. Agreement on these fixtures does not establish full semantic equivalence, production security, or constitutional conformance. No network, key, wallet or field action is needed.

Usage from repository root:

    node research/offline-v0/cli.mjs research/offline-v0/fixtures/synthetic.json
    node research/offline-v0/cli.mjs research/offline-v0/fixtures/synthetic.json 2026-01-02T12:00:00Z
    node --test tests/*.test.mjs

CLI status: 0 means no structural/hash failures under these limited research rules; 1 means at least one failure; 2 means usage or parsing error. A status of 0 **never means verified, approved, funded, settled or safe**.

The fixture is fictional. No network, live wallet, field inspection, external API, blockchain or key is accessed. All source files in this folder are public-local and are **not** copied from the private export manifest. Exported client and Constitution files remain owned by the controlled private-origin publication path.

Research constraints and source: 2026-11-14 v4 review bundle, especially INCREMENT_V4, the verifier parity tests and the two-primitive identity model. The public inspector intentionally narrows the research surface and must not be presented as full parity with that bundle's 227 tests.
