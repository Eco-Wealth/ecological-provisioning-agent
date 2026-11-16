# Experimental quantitative ecological measurements and contests (v0)

This extension is **non-normative and synthetic**. It models quantitative observations as data **inside existing Attestations**, scoped to existing Referents. It does not introduce constitutional primitives or revise the existing inspector, journal, signatures, wallet, work authorization, or settlement behavior.

## Protocol boundary

The `measurement` member is optional on existing `observation` and `follow_up_observation` Attestations. Its `format` is `ecowealth-quantitative-observation-v0`. Field naming is informed by OGC Observations, Measurements and Samples and W3C SOSA/SSN concepts (observed property, feature of interest, phenomenon time, result time, procedure, result). This is **not** a claim of conformance to those specifications. Unit support is deliberately restricted to the UCUM-compatible codes `mm`, `cm`, and `m` (length only); no full UCUM parser is included.

Required experimental fields: `observedProperty` (string), `featureOfInterest` (`referentId` and `boundarySha256`), `phenomenonTime` (RFC3339 start/end), `resultTime`, `result` (numeric `value`, `unit`, absolute nonnegative `uncertaintyAbsolute`), `procedure` (id and version), `sampling` (description and sampleCount), `source`, `evidenceRefs`, `limitations` (nonempty array). An optional `contests` locator references another publisher's self-declared source, local journal head, and ordered Attestation identity pair.

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

```sh
node research/offline-v0/examples/fictional-measurement-exchange.mjs
node --test tests/offline-measurement-conformance.test.mjs
node --test tests/*.test.mjs
python3 tests/offline-differential.py
```

Machine-readable conformance mutations live in `fixtures/measurement-conformance-v0.json`; independent Python rule evaluation is in `measurement_check.py`. The test suite compares selected JavaScript and Python outcomes on the same adversarial mutations.

## Important limitations

The comparison assumes submitted bundles are accurately attributable to their publisher, but cannot prove it; the source and head are **self-declared**, not cryptographic identities or externally witnessed checkpoints. It also does not detect selectively omitted observations, independent calibration failures, copied readings, false timestamps, field fraud, or the scientific representativeness of a sample. A correctly hashed fabrication remains a fabrication. Never interpret a PASS as evidence that the observed condition is true, that ecological improvement occurred, or that somebody has authority to intervene.

Work without wallets, network, or payments. No live ecology, private data or production control is accessed.

## What the numbers and statuses mean

Every status is PASS, FAIL, WARN or UNKNOWN. None is a score, a rank, a grade or a judgement about a publisher, a person or a place, and no rule scores, averages or ranks anything. Every measurement report and every exchange result carries `experimental: true`. In an exchange, "publisher" and "challenger" only name the two bundles in the order they are passed in.

- `count` is the number of attestations that carry a `measurement` member, including any that fail MV001, up to 2001. At most 2000 are read: the 2001st gets an MV000 FAIL, and nothing after it is read or counted. A bundle with more than 25000 entries in `referents`, `attestations` or `evidence` gives an MV000 FAIL and a `count` of 0.
- `value` is the number the publisher declared, in the declared `unit`. A negative value passes. A value larger than 1e12 in size fails MV003. Nothing checks that the observed property is something a length unit can measure.
- `uncertaintyAbsolute` is read as the half-width of a symmetric interval around `value`, in the same unit: the declared interval runs from `value - uncertaintyAbsolute` to `value + uncertaintyAbsolute`. It is not read as a standard deviation or a confidence level, and nothing checks how it was found.
- `sampleCount` is a whole number from 1 to 1,000,000 that the publisher declared. Nothing checks it against the evidence.
- XC003 converts both intervals to meters with fixed factors (`mm` 0.001, `cm` 0.01, `m` 1). It gives WARN only when the two intervals are apart by more than a tolerance of 1e-12 times the larger of 1 and the absolute values of the two upper bounds (in meters). Intervals that overlap, touch or are closer than that give UNKNOWN. WARN means the two declared intervals do not overlap. It does not say which publisher is right, whether either is right, or that either is wrong.
- XC002 compares only the observed property, the referent id, the boundary digest, the sampling window (the two `phenomenonTime` strings must be the same text) and the procedure id and version. It does not compare the sampling description, the sample count, the source, the evidence, the result time or the actor. Any difference in a compared field gives UNKNOWN.
- A failing measurement is withheld from the numeric comparison only when the failure is a FAIL filed under that measurement's own identity pair: its `scopeReferent` and `localId`, written as JSON text. The comparison looks nowhere else. A failure filed anywhere else does not stop the comparison, and the measurement is compared as if it had passed. These are examples of a failure filed somewhere else, not a complete list:
  - A measurement after the 2001st in its bundle is never read, so it has no finding at all.
  - An attestation whose own `scopeReferent` or `localId` is not a text of 1 to 256 characters has its findings filed under its position in the list, for example `attestations[0]`.
  - A bundle with more than 25000 entries in `referents`, `attestations` or `evidence`, or with `referents` or `evidence` not a list, gets one MV000 FAIL filed at `bundle` and no finding for any measurement in it, so every measurement in that bundle is compared unread.
- A contest locator that names an identity that is not a text of 1 to 256 characters fails MV009. That failure is filed under the challenger's own identity pair like any other, so it stops the comparison only while the challenger's own `scopeReferent` and `localId` are both texts of 1 to 256 characters. When they are not, it is filed under the challenger's position in the list and does not stop the comparison.
- What `inspectExchange` prints for a measurement that gets through this way is not defined by the rules. Two examples: a `result` that is missing or null stops it with an error instead of a status, and a `unit` that is the name of a member every object has, such as `constructor`, is read as NaN and printed as UNKNOWN "intervals overlap", even when the two declared intervals are far apart.
- A comparison goes ahead when evidence is withheld (MV006 UNKNOWN). It never looks at the evidence, so copied evidence is not detected.
- The measurement rules do not run the record inspector (`verify.mjs`). A bundle can pass every measurement rule and still fail the inspector, so run both. The exchange does not check that the two bundles carry different `provenance.source` labels, and a label is only text.
- `measurement_check.py` re-evaluates MV002 to MV006 only, and the tests compare it with the JavaScript on the 13 single-measurement vectors only. MV007 to MV010 and the exchange rules have no second implementation, and MV001 appears there only as a gate that skips the measurement. It was written from the same description of the rules, so it can catch a coding slip but not a misreading both share, and the two do not agree on every spelling of the input.
- The two bundles built by `fictional-measurement-exchange.mjs` come from one script in one process with fixed times. They are two files, not two independent parties.
