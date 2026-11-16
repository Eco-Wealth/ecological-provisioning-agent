import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hasFailures, verifyBundle } from '../research/offline-v0/verify.mjs';

const seed = JSON.parse(readFileSync(
  new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url), 'utf8'
));
const fresh = () => structuredClone(seed);
const att = (bundle, localId) => bundle.attestations.find(a => a.localId === localId);
const link = (localId, kind = 'based_on') =>
  ({ kind, to: { scopeReferent: 'synthetic-place', localId } });
const rule = (r, group, id) => r.dimensions[group].some(x => x.ruleId === id && x.status === 'FAIL');

test('self-cyclic closing disposition cannot appear as an obligation closure', () => {
  const b = fresh();
  att(b, 'disposition').relations.push(link('disposition'));
  const r = verifyBundle(b);
  assert.equal(rule(r, 'structural', 'S015'), true);
  assert.equal(rule(r, 'structural', 'S016'), true);
  assert.deepEqual(r.recordedState.closureAssertions, []);
  assert.equal(r.recordedState.openObligationAssertions.length, 1);
  assert.equal(hasFailures(r), true);
});

test('cyclic obligation admission cannot appear as an admitted open or closed obligation', () => {
  const b = fresh();
  att(b, 'obligation').relations.push(link('obligation'));
  const r = verifyBundle(b);
  assert.equal(rule(r, 'structural', 'S016'), true);
  assert.deepEqual(r.recordedState.openObligationAssertions, []);
  assert.deepEqual(r.recordedState.closureAssertions, []);
});

test('closing disposition is quarantined when it depends on a compromised ancestor', () => {
  const b = fresh();
  const ancestor = structuredClone(att(b, 'observation'));
  ancestor.localId = 'compromised-ancestor';
  ancestor.evidenceRefs = ['absent-evidence'];
  ancestor.relations = [];
  b.attestations.push(ancestor);
  att(b, 'disposition').relations.push(link('compromised-ancestor'));
  const r = verifyBundle(b);
  assert.equal(rule(r, 'evidence', 'E007'), true);
  assert.deepEqual(r.recordedState.closureAssertions, []);
  assert.equal(r.recordedState.openObligationAssertions.length, 1);
});

test('compromised evidence on admission prevents projection of admitted obligation', () => {
  const b = fresh();
  att(b, 'obligation').evidenceRefs = ['note'];
  b.evidence[0].text = 'tampered content';
  const r = verifyBundle(b);
  assert.equal(rule(r, 'evidence', 'E004'), true);
  assert.deepEqual(r.recordedState.closureAssertions, []);
  assert.deepEqual(r.recordedState.openObligationAssertions, []);
});

test('independent valid obligation remains visible despite unrelated self-cycle', () => {
  const b = fresh();
  att(b, 'disposition').relations = []; // no closure is asserted
  const other = structuredClone(att(b, 'observation'));
  other.localId = 'unrelated-cycle';
  other.relations = [link('unrelated-cycle')];
  b.attestations.push(other);
  const r = verifyBundle(b);
  assert.equal(rule(r, 'structural', 'S016'), true);
  assert.equal(r.recordedState.openObligationAssertions.length, 1);
  assert.deepEqual(r.recordedState.closureAssertions, []);
});
