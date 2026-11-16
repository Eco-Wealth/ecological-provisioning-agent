import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { verifyBundle } from '../research/offline-v0/verify.mjs';

const seed = JSON.parse(readFileSync(new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(seed);
const att = (b, id) => b.attestations.find(a => a.localId === id);
const failed = (r, group, rule) => r.dimensions[group].some(x => x.ruleId === rule && x.status === 'FAIL');

test('duplicate admission identity cannot produce an uncontested closure projection', () => {
  const b = fresh();
  const duplicate = structuredClone(att(b, 'obligation'));
  duplicate.actor = 'CONFLICTING_SYNTHETIC_ACTOR';
  b.attestations.push(duplicate);
  const r = verifyBundle(b);
  assert.equal(failed(r, 'structural', 'S011'), true);
  assert.equal(r.recordedState.closureAssertions.length, 0);
});

test('a disposition with missing scope cannot close an admitted obligation', () => {
  const b = fresh();
  att(b, 'disposition').scopeReferent = 'does-not-exist';
  // Reference the still-existent admission explicitly.
  const r = verifyBundle(b);
  assert.equal(failed(r, 'structural', 'S008'), true);
  assert.equal(r.recordedState.closureAssertions.length, 0);
});

test('a disposition with an invalid concern cannot close an admitted obligation', () => {
  const b = fresh();
  att(b, 'disposition').concerns = ['does-not-exist'];
  const r = verifyBundle(b);
  assert.equal(failed(r, 'structural', 'S009'), true);
  assert.equal(r.recordedState.closureAssertions.length, 0);
});

test('closing disposition that cites an absent evidence ID cannot clear obligation projection', () => {
  const b = fresh();
  att(b, 'disposition').evidenceRefs = ['absent'];
  const r = verifyBundle(b);
  assert.equal(failed(r, 'evidence', 'E007'), true);
  assert.equal(r.recordedState.closureAssertions.length, 0);
});

test('an invalid admission must not be reported as an admitted obligation', () => {
  const b = fresh();
  att(b, 'obligation').concerns = ['does-not-exist'];
  const r = verifyBundle(b);
  assert.equal(failed(r, 'structural', 'S009'), true);
  assert.equal(r.recordedState.closureAssertions.length, 0);
  assert.deepEqual(r.recordedState.openObligationAssertions, []);
});

test('duplicate Referent identity with conflicting boundaries quarantines dependent obligation projections', () => {
  const b = fresh();
  b.referents.push({ id: 'synthetic-place', boundary: 'different disputed physical boundary' });
  const r = verifyBundle(b);
  assert.equal(failed(r, 'structural', 'S006'), true);
  assert.deepEqual(r.recordedState.closureAssertions, []);
  assert.deepEqual(r.recordedState.openObligationAssertions, []);
});
