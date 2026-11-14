import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { hasFailures, verifyBundle } from '../research/offline-v0/verify.mjs';

const seed = JSON.parse(readFileSync(
  new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url), 'utf8'
));
const fresh = () => structuredClone(seed);
const finding = (report, dimension, rule, status) =>
  report.dimensions[dimension].some(x => x.ruleId === rule && x.status === status);
const at = (b, name) => b.attestations.find(a => a.localId === name);

test('same verified bytes with two evidence IDs are flagged as reused, not independent', () => {
  const b = fresh();
  b.evidence.push({ ...b.evidence[0], id: 'second-note' });
  at(b, 'observation').evidenceRefs.push('second-note');
  const report = verifyBundle(b);
  assert.equal(finding(report, 'evidence', 'E009', 'WARN'), true);
  assert.equal(finding(report, 'ecology', 'L001', 'UNKNOWN'), true);
  assert.equal(hasFailures(report), false);
});

test('repeating the same evidence reference cannot multiply its independent support', () => {
  const b = fresh();
  at(b, 'observation').evidenceRefs.push('note');
  const report = verifyBundle(b);
  assert.equal(finding(report, 'evidence', 'E010', 'WARN'), true);
  assert.equal(hasFailures(report), false);
});

test('malformed SHA commitment on restricted evidence is a format failure', () => {
  const b = fresh();
  b.evidence.push({ id: 'withheld', access: 'restricted', sha256: 'not-a-hash' });
  const report = verifyBundle(b);
  assert.equal(finding(report, 'evidence', 'E011', 'FAIL'), true);
  assert.equal(hasFailures(report), true);
});

test('well-formed restricted commitment still does not verify withheld bytes', () => {
  const b = fresh();
  b.evidence.push({ id: 'withheld', access: 'restricted', sha256: 'a'.repeat(64) });
  const report = verifyBundle(b);
  assert.equal(finding(report, 'evidence', 'E005', 'UNKNOWN'), true);
  assert.equal(finding(report, 'evidence', 'E011', 'FAIL'), false);
  assert.equal(finding(report, 'ecology', 'L001', 'UNKNOWN'), true);
});

test('a claimed duplicate digest with different bytes does not count as confirmed reuse', () => {
  const b = fresh();
  b.evidence.push({ ...b.evidence[0], id: 'forged', text: 'different' });
  const report = verifyBundle(b);
  assert.equal(finding(report, 'evidence', 'E004', 'FAIL'), true);
  assert.equal(finding(report, 'evidence', 'E009', 'WARN'), false);
});

test('a disposition supported by tampered evidence cannot clear an obligation projection', () => {
  const b = fresh();
  at(b, 'disposition').evidenceRefs = ['note'];
  b.evidence[0].text = 'changed after hash';
  const report = verifyBundle(b);
  assert.equal(finding(report, 'evidence', 'E004', 'FAIL'), true);
  assert.equal(finding(report, 'obligations', 'O005', 'FAIL'), true);
  assert.deepEqual(report.recordedState.closureAssertions, []);
  assert.equal(report.recordedState.openObligationAssertions.length, 1);
  assert.equal(hasFailures(report), true);
});

test('replacement hash over fabricated text does not prove the text is true', () => {
  const b = fresh();
  b.evidence[0].text = 'invented claim';
  b.evidence[0].sha256 = createHash('sha256').update(b.evidence[0].text).digest('hex');
  const report = verifyBundle(b);
  assert.equal(finding(report, 'evidence', 'E004', 'PASS'), true);
  assert.equal(finding(report, 'ecology', 'L001', 'UNKNOWN'), true);
});
