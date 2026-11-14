import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyBundle, hasFailures } from '../research/offline-v0/verify.mjs';

const original = JSON.parse(readFileSync(
  new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(original);
const at = (b, id) => b.attestations.find(a => a.localId === id);
const failed = (r, group, rule) => r.dimensions[group].some(x => x.ruleId === rule && x.status === 'FAIL');

test('non-string evidence reference is rejected, not silently unresolved', () => {
  const b = fresh();
  at(b, 'observation').evidenceRefs = [null];
  const report = verifyBundle(b);
  assert.equal(failed(report, 'evidence', 'E007'), true);
  assert.equal(hasFailures(report), true);
});

test('unknown disposition effects cannot silently preserve a clean verdict', () => {
  const b = fresh();
  at(b, 'disposition').effect = 'teleport';
  const report = verifyBundle(b);
  assert.equal(failed(report, 'obligations', 'O004'), true);
  assert.equal(hasFailures(report), true);
});

test('closing disposition cannot reference itself or a nonexistent admission', () => {
  const b = fresh();
  at(b, 'disposition').relations[0].to.localId = 'disposition';
  const report = verifyBundle(b);
  assert.equal(failed(report, 'obligations', 'O003'), true);
  assert.equal(report.recordedState.closureAssertions.length, 0);
});

test('a missing referenced evidence item does not become verified through an empty reference', () => {
  const b = fresh();
  at(b, 'observation').evidenceRefs = [''];
  const report = verifyBundle(b);
  assert.equal(failed(report, 'evidence', 'E007'), true);
  assert.equal(hasFailures(report), true);
});
