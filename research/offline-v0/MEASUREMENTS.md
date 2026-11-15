# Experimental quantitative ecological measurements and contests (v0)

This extension is **non-normative and synthetic**. It models quantitative observations as data **inside existing Attestations**, scoped to existing Referents. It does not introduce constitutional primitives or revise the existing inspector, journal, private export manifest, signatures, wallet, work authorization, or settlement behavior.

## Protocol boundary

The \`measurement\` member is optional on existing \`observation\` and \`follow_up_observation\` Attestations. Its \`format\` is \`ecowealth-quantitative-observation-v0\`. Field naming is informed by OGC Observations, Measurements and Samples and W3C SOSA/SSN concepts (observed property, feature of interest, phenomenon time, result time, procedure, result). This is **not** a claim of conformance to those specifications. Unit support is deliberately restricted to the UCUM-compatible codes \`mm\`, \`cm\`, and \`m\` (length only); no full UCUM parser is included.

Required experimental fields: \`observedProperty\` (string), \`featureOfInterest\` (\`referentId\` and \`boundarySha256\`), \`phenomenonTime\` (RFC3339 start/end), \`resultTime\`, \`result\` (numeric \`value\`, \`unit\`, absolute nonnegative \`uncertaintyAbsolute\`), \`procedure\` (id and version), \`sampling\` (description and sampleCount), \`source\`, \`evidenceRefs\`, \`limitations\` (nonempty array). An optional \`contests\` locator references another publisher's self-declared source, local journal head, and ordered Attestation identity pair.

The boundary digest covers the Referent's boundary **UTF-8 bytes**, not a scientific geospatial boundary standard or a trusted physical map. A claim scoped to a different Referent, another boundary digest, another property, sampling window, or method is not automatically comparable. Numeric uncertainty intervals are declared; there is no validation that they represent statistically justified confidence intervals.

## Checks

- MV001: experimental format and observation role.
- MV002: Referent identity and declared boundary digest.
- MV003: finite bounded value, unit and nonnegative absolute uncertainty.
- MV004: declared chronological order.
- MV005: minimal measurement, sampling and procedure metadata.
- MV006: supporting evidence references and inline digest integrity, or UNKNOWN for withheld evidence.
- MV007: UNKNOWN for actor, instrument calibration, clock and method fitness.
- MV008: UNKNOWN for ecological causality and benefit.
- MV009: syntactic contest locator only; NOT external head authenticity.
- MV010: WARN for unrecognized extension fields.
- XC001: source/head/identity match to the supplied competing bundle; a self-declared head is not a checkpoint.
- XC002: strict matching of claim identity conditions plus bounded dimensional conversion.
- XC003: WARN for disjoint declared intervals; UNKNOWN for overlapping intervals. Neither is automatic scientific adjudication.

Run from repository root (Node.js 22+, Python 3):

\`\`\`sh
node research/offline-v0/examples/fictional-measurement-exchange.mjs
node --test tests/offline-measurement-conformance.test.mjs
node --test tests/*.test.mjs
python3 tests/offline-differential.py
\`\`\`

Machine-readable conformance mutations live in \`fixtures/measurement-conformance-v0.json\`; independent Python rule evaluation is in \`measurement_check.py\`. The test suite compares selected JavaScript and Python outcomes on the same adversarial mutations.

## Important limitations

The comparison assumes submitted bundles are accurately attributable to their publisher, but cannot prove it; the source and head are **self-declared**, not cryptographic identities or externally witnessed checkpoints. It also does not detect selectively omitted observations, independent calibration failures, copied readings, false timestamps, field fraud, or the scientific representativeness of a sample. A correctly hashed fabrication remains a fabrication. Never interpret a PASS as evidence that the observed condition is true, that ecological improvement occurred, or that somebody has authority to intervene.

Work without wallets, network, or payments. No live ecology, private data or production control is accessed.
