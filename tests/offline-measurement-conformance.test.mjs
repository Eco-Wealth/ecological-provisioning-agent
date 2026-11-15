import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MEASUREMENT_FORMAT, inspectMeasurements, inspectExchange } from '../research/offline-v0/measurement.mjs';
import { CONSTITUTION_SHA256, FORMAT, verifyBundle, hasFailures } from '../research/offline-v0/verify.mjs';

const vectors = JSON.parse(readFileSync(
  new URL('../research/offline-v0/fixtures/measurement-conformance-v0.json', import.meta.url), 'utf8'));
const hash = s => createHash('sha256').update(s, 'utf8').digest('hex');
const at = '2026-01-03T00:00:00Z';
function bundle(source = 'fictional-publisher', head = '1'.repeat(64), localId = 'baseline',
  value = 12, unit = 'mm') {
  const boundary = 'FICTIONAL drain cell A: fixed bounded feature; no real site';
  const text = 'FICTIONAL notebook: synthetic depth measurement, not a field observation';
  const measurement = {
    format: MEASUREMENT_FORMAT,
    observedProperty: 'fictional-sediment-depth',
    featureOfInterest: { referentId: 'synthetic-drain', boundarySha256: hash(boundary) },
    phenomenonTime: { start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:10:00Z' },
    resultTime: '2026-01-02T00:00:00Z',
    result: { value, unit, uncertaintyAbsolute: 0.5 },
    procedure: { id: 'fictional-ruler', version: 'v1' },
    sampling: { description: 'one fictional point sample; no spatial representativeness claimed', sampleCount: 1 },
    source: 'fictional-operator',
    evidenceRefs: ['notebook'],
    limitations: ['Synthetic only; no calibration, authority or field evidence']
  };
  const a = {
    scopeReferent: 'synthetic-drain', localId, role: 'observation',
    actor: 'SYNTHETIC_ACTOR', concerns: ['synthetic-drain'], assertedAt: at,
    effectiveAt: at, authority: null, method: 'synthetic method',
    evidenceRefs: ['notebook'], relations: [], measurement
  };
  return {
    format: FORMAT,
    constitution: { identifier: 'ECOWEALTH-CONSTITUTION-v1', sha256: CONSTITUTION_SHA256 },
    provenance: { source, exportedAt: at, localJournalHead: head },
    referents: [{ id: 'synthetic-drain', boundary }],
    attestations: [a],
    evidence: [{ id: 'notebook', access: 'inline', text, sha256: hash(text) }]
  };
}
const row = (report, ruleId) => report.findings.find(f => f.ruleId === ruleId);
function challenge() {
  const b = bundle('fictional-challenger', '2'.repeat(64), 'contest', 20, 'mm');
  const m = b.attestations[0].measurement;
  m.contests = { publisher: 'fictional-publisher', journalHead: '1'.repeat(64),
    scopeReferent: 'synthetic-drain', localId: 'baseline' };
  return b;
}
const mutations = {
  'none': () => {},
  'wrong-format': b => { b.attestations[0].measurement.format = 'other'; },
  'unit-kilograms': b => { b.attestations[0].measurement.result.unit = 'kg'; },
  'negative-uncertainty': b => { b.attestations[0].measurement.result.uncertaintyAbsolute = -1; },
  'missing-result-value': b => { delete b.attestations[0].measurement.result.value; },
  'alter-boundary-digest': b => { b.attestations[0].measurement.featureOfInterest.boundarySha256 = '0'.repeat(64); },
  'reverse-times': b => { b.attestations[0].measurement.phenomenonTime.start = '2026-01-02T10:00:00Z'; },
  'missing-method-version': b => { delete b.attestations[0].measurement.procedure.version; },
  'alter-evidence-bytes': b => { b.evidence[0].text = 'fabricated'; },
  'restricted-evidence': b => { b.evidence[0] = { id: 'notebook', access: 'restricted', sha256: 'a'.repeat(64) }; },
  'unrecognized-field': b => { b.attestations[0].measurement.extra = true; },
  'malformed-contest': b => { b.attestations[0].measurement.contests = { journalHead: 'not-a-digest' }; }
};
test('versioned conformance fixture has unique vector IDs and supported mutations', () => {
  assert.equal(vectors.format, 'ecowealth-measurement-conformance-v0');
  assert.equal(new Set(vectors.vectors.map(v => v.id)).size, vectors.vectors.length);
  for (const v of vectors.vectors) assert.equal(typeof mutations[v.mutation], 'function', v.id);
});
for (const v of vectors.vectors) {
  test('measurement conformance: ' + v.id, () => {
    const b = bundle();
    mutations[v.mutation](b);
    const report = inspectMeasurements(b);
    assert.equal(report.experimental, true);
    assert.equal(report.count, 1);
    assert.equal(row(report, v.ruleId)?.status, v.status, JSON.stringify(report.findings));
  });
}
test('a valid quantitative claim can be structurally consistent yet scientifically unresolved', () => {
  const b = bundle();
  assert.equal(hasFailures(verifyBundle(b)), false);
  const report = inspectMeasurements(b);
  assert.equal(report.findings.some(x => x.status === 'FAIL'), false);
  assert.equal(row(report, 'MV007').status, 'UNKNOWN');
  assert.equal(row(report, 'MV008').status, 'UNKNOWN');
});
const exchangeMutations = {
  'none': () => {},
  'overlapping-result': b => { b.attestations[0].measurement.result.value = 12.3; },
  'different-feature-boundary': b => {
    const boundary = 'FICTIONAL drain cell A: another independent boundary';
    b.referents[0].boundary = boundary;
    b.attestations[0].measurement.featureOfInterest.boundarySha256 = hash(boundary);
  },
  'different-journal-head': b => { b.attestations[0].measurement.contests.journalHead = '3'.repeat(64); }
};
for (const v of vectors.exchangeVectors) {
  test('cross-publisher exchange: ' + v.id, () => {
    const pub = bundle(), other = challenge();
    exchangeMutations[v.mutation](other);
    const output = inspectExchange(pub, other);
    assert.equal(output.comparisons.length, 1);
    const finding = output.comparisons[0].findings.find(x => x.ruleId === v.ruleId);
    assert.equal(finding?.status, v.status, JSON.stringify(output.comparisons));
  });
}
test('unit conversion is dimensionally consistent and conservative about close intervals', () => {
  const pub = bundle();
  const other = challenge();
  other.attestations[0].measurement.result.value = 1.2;
  other.attestations[0].measurement.result.unit = 'cm';
  other.attestations[0].measurement.result.uncertaintyAbsolute = 0.05;
  assert.equal(inspectExchange(pub, other).comparisons[0].findings.at(-1).status, 'UNKNOWN');
});
test('same publisher evidence is not automatically credited as independent corroboration', () => {
  const pub = bundle(), other = challenge();
  other.attestations[0].measurement.result.value = 12;
  other.evidence[0] = structuredClone(pub.evidence[0]);
  assert.equal(inspectExchange(pub, other).comparisons[0].findings.at(-1).status, 'UNKNOWN');
});
test('duplicate publisher identities fail closed for external contest matching', () => {
  const pub = bundle(); pub.attestations.push(structuredClone(pub.attestations[0]));
  assert.equal(inspectExchange(pub, challenge()).comparisons[0].findings[0].ruleId, 'XC001');
  assert.equal(inspectExchange(pub, challenge()).comparisons[0].findings[0].status, 'FAIL');
});

test('independent Python oracle agrees on bounded mechanical rule subset', async () => {
  const { spawnSync } = await import('node:child_process');
  const python = new URL('../research/offline-v0/measurement_check.py', import.meta.url).pathname;
  for (const v of vectors.vectors) {
    const b = bundle(); mutations[v.mutation](b);
    const run = spawnSync('python3', [python], { input: JSON.stringify(b), encoding: 'utf8' });
    assert.equal(run.status, 0, v.id + ': ' + run.stderr);
    const independent = JSON.parse(run.stdout)[0];
    const primary = inspectMeasurements(b);
    for (const [rule, status] of Object.entries(independent))
      assert.equal(row(primary, rule)?.status, status, v.id + ': ' + rule);
  }
});
