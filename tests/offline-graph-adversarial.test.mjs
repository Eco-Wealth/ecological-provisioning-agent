import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { hasFailures, verifyBundle } from '../research/offline-v0/verify.mjs';

const synthetic = JSON.parse(readFileSync(
  new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url), 'utf8'
));
const fresh = () => structuredClone(synthetic);
const at = (bundle, name) => bundle.attestations.find(x => x.localId === name);
const link = (name, kind = 'based_on') => ({
  kind, to: { scopeReferent: 'synthetic-place', localId: name }
});
const fail = (report, ruleId) =>
  report.dimensions.structural.some(x => x.ruleId === ruleId && x.status === 'FAIL');

test('a same-record-time self-dependency fails rather than certifying an acyclic graph', () => {
  const bundle = fresh();
  at(bundle, 'observation').relations = [link('observation')];
  const report = verifyBundle(bundle);
  assert.equal(fail(report, 'S015'), true);
  assert.equal(hasFailures(report), true);
});

test('two equal-time causal dependencies form a detectable cycle', () => {
  const bundle = fresh();
  at(bundle, 'observation').assertedAt = '2026-01-02T00:00:00Z';
  at(bundle, 'observation').relations = [link('obligation')];
  at(bundle, 'obligation').relations = [link('observation')];
  const report = verifyBundle(bundle);
  assert.equal(fail(report, 'S016'), true);
  assert.equal(hasFailures(report), true);
});

test('reciprocal contradictions are not mistaken for causal dependency cycles', () => {
  const bundle = fresh();
  at(bundle, 'observation').assertedAt = '2026-01-02T00:00:00Z';
  at(bundle, 'observation').relations = [link('obligation', 'contradicts')];
  at(bundle, 'obligation').relations = [link('observation', 'contradicts')];
  const report = verifyBundle(bundle);
  assert.equal(fail(report, 'S015'), false);
  assert.equal(fail(report, 'S016'), false);
  assert.equal(hasFailures(report), false);
  assert.equal(report.recordedState.conflictingAttestations.length, 2);
});

test('malformed relation in a disposition produces FAIL, never an exception or false closure', () => {
  const bundle = fresh();
  at(bundle, 'disposition').relations = [null];
  const report = verifyBundle(bundle);
  assert.equal(fail(report, 'S013'), true);
  assert.equal(report.recordedState.closureAssertions.length, 0);
  assert.equal(report.recordedState.openObligationAssertions.length, 1);
  assert.equal(hasFailures(report), true);
});

test('historical snapshot does not expose contradictions asserted after the snapshot', () => {
  const bundle = fresh();
  at(bundle, 'payment').relations = [link('observation', 'contradicts')];
  const early = verifyBundle(bundle, { asOf: '2026-01-02T12:00:00Z' });
  const late = verifyBundle(bundle, { asOf: '2026-01-05T00:00:00Z' });
  assert.deepEqual(early.recordedState.conflictingAttestations, []);
  assert.equal(late.recordedState.conflictingAttestations.length, 1);
});

test('a closing disposition cannot retroactively close an admission not yet asserted', () => {
  const bundle = fresh();
  at(bundle, 'disposition').assertedAt = '2026-01-01T00:00:00Z';
  at(bundle, 'disposition').effectiveAt = '2026-01-01T00:00:00Z';
  const report = verifyBundle(bundle, { asOf: '2026-01-03T00:00:00Z' });
  assert.equal(fail(report, 'S014'), true);
  assert.equal(report.recordedState.closureAssertions.length, 0);
  assert.equal(report.recordedState.openObligationAssertions.length, 1);
  assert.equal(hasFailures(report), true);
});
