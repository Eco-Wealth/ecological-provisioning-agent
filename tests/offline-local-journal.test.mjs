import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, truncateSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendRecord, canonical, checkHead, createJournal, exportBundle, readJournal,
  serializeJournal, snapshot, validateJournal } from '../research/offline-v0/journal.mjs';
import { hasFailures } from '../research/offline-v0/verify.mjs';

const source = 'fictional-offline-journal';
const genesisAt = '2026-01-01T00:00:00Z';
const A = (kind, value) => ({ kind, value });
const identity = localId => ({ scopeReferent: 'site', localId });
function att(localId, role, assertedAt, options = {}) {
  return {
    scopeReferent: 'site', localId, actor: 'FICTIONAL_ACTOR',
    concerns: ['site'], role, assertedAt, effectiveAt: assertedAt,
    method: 'synthetic method', authority: null,
    evidenceRefs: [], relations: [], ...options
  };
}
function sample() {
  let entries = createJournal({ source, recordedAt: genesisAt });
  entries = appendRecord(entries, A('referent', { id: 'site', boundary: 'fictional area' }), '2026-01-02T00:00:00Z');
  const note = 'SYNTHETIC observation only';
  entries = appendRecord(entries, A('evidence', {
    id: 'note', access: 'inline', text: note, sha256: createHash('sha256').update(note).digest('hex')
  }), '2026-01-03T00:00:00Z');
  entries = appendRecord(entries, A('attestation',
    att('observation', 'observation', '2026-01-02T12:00:00Z', { evidenceRefs: ['note'] })),
    '2026-01-04T00:00:00Z');
  entries = appendRecord(entries, A('attestation',
    att('obligation', 'obligation_admission', '2026-01-03T00:00:00Z')),
    '2026-01-05T00:00:00Z');
  entries = appendRecord(entries, A('attestation',
    att('closure', 'disposition', '2026-01-05T12:00:00Z', {
      effect: 'close', relations: [{ kind: 'disposes', to: identity('obligation') }]
    })), '2026-01-06T00:00:00Z');
  return entries;
}

test('deterministic journal byte serialization, identity and hash chain survive round-trip', () => {
  const original = sample();
  const bytes = serializeJournal(original);
  const roundtrip = readJournal(bytes);
  assert.deepEqual(roundtrip, original);
  assert.equal(serializeJournal(roundtrip), bytes);
  assert.equal(validateJournal(original).entries, 6);
  const bundle = exportBundle(roundtrip);
  assert.equal(bundle.format, 'ecowealth-offline-research-v0');
  assert.equal(bundle.attestations[0].recordedAt, '2026-01-04T00:00:00Z');
  assert.equal(bundle.provenance.localJournalHead, original[original.length - 1].hash);
  assert.equal(hasFailures(snapshot(roundtrip)), false);
});

test('backdated assertion cannot enter a historical snapshot before its journal receipt', () => {
  const entries = sample();
  const beforeReceipt = snapshot(entries, '2026-01-04T12:00:00Z');
  assert.deepEqual(beforeReceipt.recordedState.openObligationAssertions, []);
  assert.deepEqual(beforeReceipt.recordedState.closureAssertions, []);
  const afterAdmission = snapshot(entries, '2026-01-05T12:00:00Z');
  assert.equal(afterAdmission.recordedState.openObligationAssertions.length, 1);
  assert.deepEqual(afterAdmission.recordedState.closureAssertions, []);
  const afterClosure = snapshot(entries, '2026-01-06T12:00:00Z');
  assert.equal(afterClosure.recordedState.closureAssertions.length, 1);
  assert.equal(afterClosure.dimensions.obligations.some(x => x.status === 'UNKNOWN'), true);
});

test('journal tampering, deletion, reordering and truncation fail verification', () => {
  const entries = sample();
  const changed = structuredClone(entries);
  changed[2].record.value.text = 'rewritten';
  assert.throws(() => validateJournal(changed), /hash mismatch/);
  assert.throws(() => validateJournal([...entries.slice(0, 2), ...entries.slice(3)]), /journal entry/);
  assert.throws(() => validateJournal([entries[1], entries[0], ...entries.slice(2)]), /journal entry/);
  assert.throws(() => readJournal(serializeJournal(entries).slice(0, -1)), /trailing newline/);
});

test('hashes alone are not a third-party timestamp or external authenticity proof', () => {
  const entries = sample();
  const bundle = exportBundle(entries);
  assert.equal(bundle.provenance.source, source);
  assert.equal(snapshot(entries).dimensions.authority.every(x => x.status === 'UNKNOWN'), true);
  assert.equal(snapshot(entries).dimensions.ecology[0].status, 'UNKNOWN');
});

test('append rejects duplicate scope, evidence tampering and claims dated after receipt', () => {
  const entries = sample();
  assert.throws(() => appendRecord(entries,
    A('referent', { id: 'site', boundary: 'not the same location' }),
    '2026-01-07T00:00:00Z'), /S006/);
  assert.throws(() => appendRecord(entries,
    A('attestation', att('future', 'observation', '2027-01-01T00:00:00Z')),
    '2026-01-07T00:00:00Z'), /assertion timestamp/);
  assert.throws(() => appendRecord(entries,
    A('evidence', { id: 'fake', access: 'inline', text: 'tampered', sha256: '0'.repeat(64) }),
    '2026-01-07T00:00:00Z'), /E004/);
});

test('ambiguous JSON bytes with duplicate keys are rejected despite an intact parsed hash chain', () => {
  const entries = sample();
  const lines = serializeJournal(entries).trimEnd().split('\n');
  const modified = lines[1].replace('"seq":1', '"seq":1,"seq":1');
  assert.notEqual(modified, lines[1]);
  lines[1] = modified;
  assert.throws(() => readJournal(lines.join('\n') + '\n'), /noncanonical journal JSON/);
});

test('extra trailing blank journal entries are not silently discarded', () => {
  const bytes = serializeJournal(sample());
  assert.throws(() => readJournal(bytes + '\n'), /noncanonical journal JSON|invalid JSON/);
});

test('noncanonical whitespace and altered numeric spellings are rejected', () => {
  const entries = sample();
  const lines = serializeJournal(entries).trimEnd().split('\n');
  lines[0] = ' ' + lines[0];
  assert.throws(() => readJournal(lines.join('\n') + '\n'), /noncanonical journal JSON/);
});

test('trusted external head catches replacement, including internally consistent later history', () => {
  const entries = sample();
  const checkpoint = validateJournal(entries).head;
  assert.deepEqual(checkHead(entries, checkpoint), { head: checkpoint, matches: true });
  assert.throws(() => checkHead(entries, '0'.repeat(64)), /trusted checkpoint/);
  const rewritten = createJournal({ source: 'replacement-history', recordedAt: genesisAt });
  assert.doesNotThrow(() => validateJournal(rewritten));
  assert.throws(() => checkHead(rewritten, checkpoint), /trusted checkpoint/);
});

test('canonical serialization ignores object-key insertion order', () => {
  assert.equal(canonical({ z: 2, a: { y: 1, b: true } }),
               canonical({ a: { b: true, y: 1 }, z: 2 }));
});

test('CLI initializes and exports locally, refusing overwrite or malformed input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vealth-local-journal-'));
  const cli = new URL('../research/offline-v0/journal-cli.mjs', import.meta.url).pathname;
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  try {
    const file = join(dir, 'journal.jsonl');
    const bundle = join(dir, 'bundle.json');
    const record = join(dir, 'referent.json');
    writeFileSync(record, JSON.stringify(A('referent', { id: 'site', boundary: 'fictional site' })));
    assert.equal(run(['init', file, 'fictional-cli']).status, 0);
    assert.equal(run(['add', file, record]).status, 0);
    assert.equal(run(['inspect', file]).status, 0);
    assert.equal(run(['export', file, bundle]).status, 0);
    const checkpoint = readJournal(readFileSync(file, 'utf8')).at(-1).hash;
    assert.equal(run(['check-head', file, checkpoint]).status, 0);
    assert.equal(run(['check-head', file, '0'.repeat(64)]).status, 2);
    assert.equal(existsSync(bundle), true);
    assert.equal(JSON.parse(readFileSync(bundle)).referents.length, 1);
    assert.equal(run(['export', file, bundle]).status, 2);
    assert.equal(run(['init', file, 'duplicate']).status, 2);
    const before = readFileSync(file, 'utf8');
    writeFileSync(file + '.lock', 'external writer');
    assert.equal(run(['add', file, record]).status, 2);
    assert.equal(readFileSync(file, 'utf8'), before, 'lock cannot mutate journal');
    unlinkSync(file + '.lock');
    const oversized = join(dir, 'oversized-record.json');
    writeFileSync(oversized, '');
    truncateSync(oversized, 17 * 1024 * 1024 + 1);
    assert.equal(run(['add', file, oversized]).status, 2);
    assert.equal(readFileSync(file, 'utf8'), before, 'oversized input cannot append');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
