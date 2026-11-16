import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { hasFailures, verifyBundle } from '../research/offline-v0/verify.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url),
  'utf8'
));
const fresh = () => structuredClone(fixture);
const at = (b, localId) => b.attestations.find(a => a.localId === localId);
const newScopes = b => {
  b.referents.push({ id: 'a', boundary: 'synthetic namespace a' });
  b.referents.push({ id: 'a::b', boundary: 'synthetic namespace a::b' });
};

test('a disposition cannot close a different namespace with a delimiter collision', () => {
  const b = fresh();
  newScopes(b);
  const admission = at(b, 'obligation');
  admission.scopeReferent = 'a::b';
  admission.localId = 'c';
  const disposition = at(b, 'disposition');
  disposition.relations[0].to = { scopeReferent: 'a', localId: 'b::c' };

  const report = verifyBundle(b);
  assert.equal(
    report.dimensions.structural.some(x => x.ruleId === 'S013' && x.status === 'FAIL'),
    true, 'unresolved reference must be rejected instead of aliasing a different obligation'
  );
  assert.equal(report.recordedState.closureAssertions.length, 0);
  assert.equal(report.recordedState.openObligationAssertions.length, 1);
  assert.equal(hasFailures(report), true);
});

test('distinct (scope, localId) identity pairs must not be called duplicates', () => {
  const b = fresh();
  newScopes(b);
  const admission = at(b, 'obligation');
  admission.scopeReferent = 'a::b';
  admission.localId = 'c';
  at(b, 'disposition').relations[0].to = { scopeReferent: 'a::b', localId: 'c' };
  const other = structuredClone(at(b, 'observation'));
  other.scopeReferent = 'a';
  other.localId = 'b::c';
  b.attestations.push(other);

  const report = verifyBundle(b);
  assert.equal(
    report.dimensions.structural.some(x => x.ruleId === 'S011' && x.status === 'FAIL'),
    false, 'both identity pairs are valid and distinct'
  );
  assert.equal(hasFailures(report), false);
});
