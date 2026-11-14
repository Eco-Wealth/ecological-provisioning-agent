import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hasFailures, verifyBundle } from '../research/offline-v0/verify.mjs';

const base = JSON.parse(readFileSync(
  new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url), 'utf8'));

test('thousands of obligations and dispositions preserve complete one-to-one lineage', () => {
  const b = structuredClone(base);
  const admission = b.attestations.find(a => a.localId === 'obligation');
  const disposition = b.attestations.find(a => a.localId === 'disposition');
  const count = 2500;
  for (let i = 0; i < count; i++) {
    const id = 'ob-' + i;
    b.attestations.push({ ...admission, localId: id });
    b.attestations.push({
      ...disposition, localId: 'dispose-' + i,
      relations: [{ kind: 'disposes', to: { scopeReferent: 'synthetic-place', localId: id } }]
    });
  }
  const r = verifyBundle(b);
  assert.equal(hasFailures(r), false);
  assert.equal(r.recordedState.closureAssertions.length, count + 1);
  assert.equal(r.recordedState.openObligationAssertions.length, 0);
});

test('multiple dispositions remain separately visible without duplicating one obligation', () => {
  const b = structuredClone(base);
  const d = b.attestations.find(a => a.localId === 'disposition');
  b.attestations.push({ ...d, localId: 'another-disposition' });
  const r = verifyBundle(b);
  assert.equal(hasFailures(r), false);
  assert.equal(r.recordedState.closureAssertions.length, 1);
  assert.equal(r.recordedState.closureAssertions[0].dispositions.length, 2);
});
