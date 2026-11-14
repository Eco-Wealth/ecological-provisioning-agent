import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CONSTITUTION_SHA256, hasFailures, validTime, verifyBundle } from '../research/offline-v0/verify.mjs';

const fixture = JSON.parse(readFileSync(new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(fixture);
const row = (report, group, rule) => report.dimensions[group].find(x => x.ruleId === rule);
const actor = (bundle, id) => bundle.attestations.find(a => a.localId === id);
const target = id => ({ scopeReferent: 'synthetic-place', localId: id });

test('synthetic fixture checks its own bytes without creating real-world claims', () => {
  const report = verifyBundle(fresh());
  assert.equal(report.researchOnly, true);
  assert.equal(hasFailures(report), false);
  assert.equal(row(report, 'structural', 'S999').status, 'PASS');
  assert.equal(row(report, 'evidence', 'E004').status, 'PASS');
  assert.equal(row(report, 'authority', 'A001').status, 'UNKNOWN');
  assert.equal(row(report, 'signatures', 'G001').status, 'UNKNOWN');
  assert.equal(row(report, 'economy', 'M001').status, 'WARN');
  assert.equal(row(report, 'ecology', 'L001').status, 'UNKNOWN');
  assert.equal('verified' in report, false);
});

for (const [label, change, group, rule] of [
  ['tampered evidence', b => { b.evidence[0].text = 'fabricated'; }, 'evidence', 'E004'],
  ['wrong constitution', b => { b.constitution.sha256 = '0'.repeat(64); }, 'provenance', 'P001'],
  ['wrong format', b => { b.format = 'unrecognized'; }, 'structural', 'S002'],
  ['duplicate Referent', b => { b.referents.push({ ...b.referents[0] }); }, 'structural', 'S006'],
  ['duplicate Attestation', b => { b.attestations.push({ ...b.attestations[0] }); }, 'structural', 'S011'],
  ['duplicate evidence identity', b => { b.evidence.push({ ...b.evidence[0] }); }, 'evidence', 'E002'],
  ['missing concern', b => { actor(b, 'observation').concerns = ['unknown']; }, 'structural', 'S009'],
  ['missing scope', b => { actor(b, 'observation').scopeReferent = 'unknown'; }, 'structural', 'S008'],
  ['numeric actor', b => { actor(b, 'observation').actor = 12; }, 'structural', 'S007'],
  ['array role', b => { actor(b, 'observation').role = ['observation']; }, 'structural', 'S007'],
  ['empty localId', b => { actor(b, 'observation').localId = ''; }, 'structural', 'S007'],
  ['invalid timestamp', b => { actor(b, 'observation').assertedAt = '2026-02-30T00:00:00Z'; }, 'structural', 'S007'],
  ['missing method', b => { delete actor(b, 'observation').method; }, 'structural', 'S007'],
  ['missing evidence', b => { actor(b, 'observation').evidenceRefs = ['not-here']; }, 'evidence', 'E007'],
  ['broken relation', b => { actor(b, 'disposition').relations[0].to = target('not-here'); }, 'structural', 'S013'],
  ['forward reference', b => { actor(b, 'observation').relations = [{ kind: 'based_on', to: target('payment') }]; }, 'structural', 'S014'],
  ['unrelated disposition', b => { actor(b, 'disposition').relations = []; }, 'obligations', 'O003'],
  ['restricted text exposure', b => { b.evidence.push({ id: 'restricted', access: 'restricted', text: 'private text' }); }, 'evidence', 'E008'],
  ['missing evidence hiding text', b => { b.evidence.push({ id: 'gone', access: 'missing', text: 'not missing' }); }, 'evidence', 'E008'],
  ['missing required arrays', b => { delete b.referents; }, 'structural', 'S004']
]) {
  test('fail closed: ' + label, () => {
    const bundle = fresh(); change(bundle);
    const report = verifyBundle(bundle);
    assert.equal(row(report, group, rule)?.status, 'FAIL', label);
    assert.equal(hasFailures(report), true);
  });
}

for (const bad of ['2026-02-30T00:00:00Z', '2026-11-14T24:00:00Z',
  '2026-11-14T12:60:00Z', '2026-11-14T12:00:60Z', '2026-01-01T00:00:00+24:00']) {
  test('reject invalid calendar time: ' + bad, () => assert.equal(validTime(bad), false));
}
for (const good of ['2024-02-29T00:00:00Z','2026-01-01T00:00:00-08:00']) {
  test('accept real calendar time: ' + good, () => assert.equal(validTime(good), true));
}
test('record-time open obligation is visible before later disposition', () => {
  const report = verifyBundle(fresh(), { asOf: '2026-01-02T12:00:00Z' });
  assert.deepEqual(report.recordedState.openObligationAssertions, ['synthetic-place::obligation']);
  assert.equal(report.recordedState.closureAssertions.length, 0);
});
test('later disposition is only an UNKNOWN closure assertion', () => {
  const report = verifyBundle(fresh(), { asOf: '2026-01-03T12:00:00Z' });
  assert.deepEqual(report.recordedState.openObligationAssertions, []);
  assert.equal(report.recordedState.closureAssertions.length, 1);
  assert.equal(row(report, 'obligations', 'O001').status, 'UNKNOWN');
});
test('digest integrity cannot be turned into independent evidence truth', () => {
  const bundle = fresh();
  bundle.evidence[0].text = 'SYNTHETIC fabricated report';
  bundle.evidence[0].sha256 = createHash('sha256').update(bundle.evidence[0].text).digest('hex');
  assert.equal(row(verifyBundle(bundle), 'evidence', 'E004').status, 'PASS');
  assert.equal(row(verifyBundle(bundle), 'ecology', 'L001').status, 'UNKNOWN');
});
test('CLI returns 0 for structurally consistent fictional fixture and 1 for tampering', () => {
  const cli = new URL('../research/offline-v0/cli.mjs', import.meta.url).pathname;
  const good = execFileSync(process.execPath, [cli, new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url).pathname], { encoding: 'utf8' });
  assert.equal(JSON.parse(good).researchOnly, true);
  const dir = mkdtempSync(join(tmpdir(), 'vealth-public-offline-'));
  try {
    const b = fresh(); b.evidence[0].text = 'TAMPERED';
    const path = join(dir, 'bad.json'); writeFileSync(path, JSON.stringify(b));
    const run = spawnSync(process.execPath, [cli, path], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    assert.equal(JSON.parse(run.stdout).dimensions.evidence.some(r => r.status === 'FAIL'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('adopted Constitution bytes are pinned by the public source checksum', () => {
  const bytes = readFileSync(new URL('../docs/ecowealth-constitution.md', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), CONSTITUTION_SHA256);
});
