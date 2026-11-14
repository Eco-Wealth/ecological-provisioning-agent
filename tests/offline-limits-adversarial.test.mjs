import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { hasFailures, verifyBundle } from '../research/offline-v0/verify.mjs';

const seed = JSON.parse(readFileSync(new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(seed);
const fail = (r, rule) => r.dimensions.structural.some(x => x.ruleId === rule && x.status === 'FAIL');

test('untrusted bundles beyond bounded Attestation count fail without full graph inspection', () => {
  const b = fresh();
  const base = b.attestations[0];
  b.attestations = Array.from({ length: 25001 }, (_, i) => ({ ...base, localId: 'bulk-' + i }));
  const report = verifyBundle(b);
  assert.equal(fail(report, 'S020'), true);
  assert.equal(hasFailures(report), true);
});

test('untrusted relation fanout beyond bounded edge count fails deterministically', () => {
  const b = fresh();
  const at = b.attestations[0];
  at.relations = Array.from({ length: 100001 }, () => ({
    kind: 'contradicts', to: { scopeReferent: 'synthetic-place', localId: 'obligation' }
  }));
  const report = verifyBundle(b);
  assert.equal(fail(report, 'S021'), true);
  assert.equal(hasFailures(report), true);
});

test('single oversized inline evidence is refused before hashing', () => {
  const b = fresh();
  b.evidence[0].text = 'x'.repeat(16 * 1024 * 1024 + 1);
  const report = verifyBundle(b);
  assert.equal(report.dimensions.evidence.some(x => x.ruleId === 'E012' && x.status === 'FAIL'), true);
  assert.equal(hasFailures(report), true);
});
