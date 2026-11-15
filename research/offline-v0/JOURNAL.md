# Local-first ecological record journal (research v0)

**Status:** executable public-local research code. Not an authority registry, ecological certification service, constitutional conformance decision, or independent timestamping authority.

This journal extends the [offline record inspector](./README.md) with a workflow that does **not** require vealth.net, a wallet, network connectivity, API credentials, an operator account, or any proprietary server.

## Commands

From the repository root, using Node.js 22 or later:

```sh
node research/offline-v0/journal-cli.mjs init work.jsonl fictional-research
node research/offline-v0/journal-cli.mjs add work.jsonl referent.json
node research/offline-v0/journal-cli.mjs add work.jsonl evidence.json
node research/offline-v0/journal-cli.mjs add work.jsonl observation.json
node research/offline-v0/journal-cli.mjs inspect work.jsonl
node research/offline-v0/journal-cli.mjs inspect work.jsonl 2026-01-01T00:00:00Z
node research/offline-v0/journal-cli.mjs export work.jsonl bundle.json
node research/offline-v0/cli.mjs bundle.json
```

The CLI uses the actual local system clock on each append. Samples should be fictional and clearly labeled. Do not use the journal to authorize physical work.

Each added JSON file contains one record:

```json
{
  "kind": "referent",
  "value": {
    "id": "fictional-site",
    "boundary": "synthetic example; no claim of access or permission"
  }
}
```

Allowed `kind` values after genesis are `referent`, `evidence`, and `attestation`. Examples for each appear in `fixtures/synthetic.json` as root arrays. Wrap the chosen array element as `{"kind":"attestation","value":{...}}` (or its corresponding kind) before appending. Reference records that have already been appended, not unresolved future records.

## Invariants and limitations

- Each journal entry carries a consecutive sequence, local receipt time, previous hash, and SHA-256 hash over deterministic JSON. No record can be edited or deleted undetectably **relative to a trusted copy of the last head digest**.
- Preserve the latest head digest independently. Without an outside checkpoint, someone with file access can rewrite the *entire* history and create another valid hash chain. The journal is not a trusted clock, identity system, authorization service, or blockchain anchor.
- Receipt times are nondecreasing and cannot precede an attestation's claimed assertion time. Historical views use the optional `recordedAt` receipt time rather than accepting a backdated `assertedAt` as evidence that a claim was known earlier.
- Appends fail when the projected bundle fails existing research structural/evidence checks. Missing links must be resolved before append. Unknown authority and ecological conclusions remain explicit, not silently upgraded to PASS.
- The writer uses a cooperative exclusive `.lock` file for edits. It does not protect against malicious writers, direct file edits, a hostile filesystem, crash during a single append, power loss, or a privileged replacement of the journal. Keep backups. The file's complete trailing newline detects basic truncated writes.
- The serialization order is deterministic for a given record set; it uses lexicographically sorted JavaScript JSON keys. This is **not** an IETF JSON Canonicalization Scheme conformance claim.
- An export is a research bundle, not an admitted obligation or verified ecological improvement. It includes an independently checkable local journal head and the declared source.

Run tests:

```sh
node --test tests/offline-local-journal.test.mjs
node --test tests/*.test.mjs
python3 tests/offline-differential.py
```

## Honest model of a completed intervention

An independently operated journal can represent an observation, proposed transition, declared authority, evidence requirements, intervention claim, review and a closing disposition **as separate Attestations** with different derived `role` values. This does not by itself establish that the intervention was performed, reviewed by a qualified independent party, or ecologically effective. Funding, verification and settlement remain distinct from those claims.

The authoritative private-to-public export manifest does not own this folder. The public-local implementation must not silently modify `KERNEL_EXPORT.md`, the adopted constitution, or the private-origin agent client.
