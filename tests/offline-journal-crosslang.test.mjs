import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { appendRecord, createJournal, serializeJournal, validateJournal } from '../research/offline-v0/journal.mjs';

const verifier = new URL('../research/offline-v0/journal_check.py', import.meta.url).pathname;
const python = (input, head) => {
  const args = [verifier, ...(head ? [head] : [])];
  const child = spawnSync('python3', args, { encoding: 'utf8', input });
  assert.ok([0, 1].includes(child.status), child.stderr);
  return { status: child.status, report: JSON.parse(child.stdout) };
};

function buildJournal() {
  let entries = createJournal({ source: 'fictional-cross-language', recordedAt: '2026-01-01T00:00:00Z' });
  entries = appendRecord(entries, {
    kind: 'referent', value: { id: 'soil-site', boundary: 'synthetic site' }
  }, '2026-01-02T00:00:00Z');
  const sample = 'fictional UTF-8 text: caf\u00e9 / \u6c34';
  entries = appendRecord(entries, {
    kind: 'evidence', value: {
      id: 'synthetic-sample', access: 'inline', text: sample,
      sha256: createHash('sha256').update(sample).digest('hex')
    }
  }, '2026-01-03T00:00:00Z');
  entries = appendRecord(entries, {
    kind: 'attestation', value: {
      scopeReferent: 'soil-site', localId: 'soil-observation',
      actor: 'FICTIONAL_ACTOR', concerns: ['soil-site'],
      role: 'observation', assertedAt: '2026-01-02T12:00:00Z',
      effectiveAt: '2026-01-02T12:00:00Z',
      method: 'synthetic numbers not ecological evidence',
      authority: null, evidenceRefs: ['synthetic-sample'],
      relations: [], measurements: { acidity: 1.25, integer: 2 }
    }
  }, '2026-01-04T00:00:00Z');
  return entries;
}

test('independent Python verifies JavaScript-produced UTF-8 journal and external head', () => {
  const entries = buildJournal();
  const bytes = serializeJournal(entries);
  const head = validateJournal(entries).head;
  const py = python(bytes, head);
  assert.equal(py.status, 0, JSON.stringify(py.report));
  assert.equal(py.report.head, head);
  assert.equal(py.report.entries, entries.length);
});

test('independent Python rejects a changed byte, missing entry, and false trusted head', () => {
  const entries = buildJournal();
  const bytes = serializeJournal(entries);
  const head = validateJournal(entries).head;
  const altered = bytes.replace('synthetic site', 'synthetic area');
  assert.notEqual(altered, bytes);
  assert.equal(python(altered).status, 1);
  const lines = bytes.trimEnd().split('\n');
  lines.splice(1, 1);
  assert.equal(python(lines.join('\n') + '\n').status, 1);
  assert.equal(python(bytes, '0'.repeat(64)).status, 1);
});

test('independent Python rejects duplicate parsed keys even when hash prefix is intact', () => {
  const bytes = serializeJournal(buildJournal());
  const lines = bytes.trimEnd().split('\n');
  lines[1] = lines[1].replace('"seq":1', '"seq":1,"seq":1');
  const result = python(lines.join('\n') + '\n');
  assert.equal(result.status, 1);
  assert.equal(result.report.valid, false);
});
