import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createJournal, appendRecord, validateJournal } from '../research/offline-v0/journal.mjs';
import { pae, signJournal, inspectSignedExchange, inspectSignedPair, serializeSignedExchange,
  readSignedExchange, inspectSignedHistoryConflict } from '../research/offline-v0/signed-exchange.mjs';

const hash = s => createHash('sha256').update(s).digest('hex');
const at = '2026-01-03T00:00:00Z';
const boundary = 'fictional bounded drain segment';
const sameEvidence = 'FICTIONAL notebook, duplicated by two people; no field observation';
function journal(source, id, measured = 12, reused = sameEvidence) {
  let entries = createJournal({ source, recordedAt: '2026-01-01T00:00:00Z' });
  entries = appendRecord(entries, { kind: 'referent', value: { id: 'drain', boundary } }, '2026-01-01T01:00:00Z');
  entries = appendRecord(entries, { kind: 'evidence', value: {
    id: 'note', access: 'inline', text: reused, sha256: hash(reused)
  } }, '2026-01-01T02:00:00Z');
  const measurement = {
    format: 'ecowealth-quantitative-observation-v0', observedProperty: 'fictional-depth',
    featureOfInterest: { referentId: 'drain', boundarySha256: hash(boundary) },
    phenomenonTime: { start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:10:00Z' },
    resultTime: '2026-01-02T00:00:00Z',
    result: { value: measured, unit: 'mm', uncertaintyAbsolute: 0.5 },
    procedure: { id: 'fictional-ruler', version: 'v1' },
    sampling: { description: 'fictional single point', sampleCount: 1 },
    source, evidenceRefs: ['note'],
    limitations: ['no real field sampling, calibration, or identity validation']
  };
  entries = appendRecord(entries, { kind: 'attestation', value: {
    scopeReferent: 'drain', localId: id, role: 'observation',
    actor: source, concerns: ['drain'], assertedAt: at, effectiveAt: at,
    method: 'fictional-ruler', authority: null, evidenceRefs: ['note'],
    relations: [], measurement
  } }, at);
  return entries;
}
function pair({ sameKey = false, sameText = true } = {}) {
  const a = journal('fictional-A', 'baseline');
  const firstKey = generateKeyPairSync('ed25519');
  const secondKey = sameKey ? firstKey : generateKeyPairSync('ed25519');
  const first = signJournal(a, firstKey.privateKey, '2026-01-04T00:00:00Z');
  const checkpoint = inspectSignedExchange(first).checkpoint;
  let b = journal('fictional-B', 'contest', 20,
    sameText ? sameEvidence : 'DIFFERENT synthetic fictional notebook, not field proof');
  // Rebuild the separate journal with a contest locator inside the signed attestation.
  const edit = structuredClone(b[3].record.value);
  edit.measurement.contests = {
    publisher: checkpoint.publisher, journalHead: checkpoint.journalHead,
    scopeReferent: 'drain', localId: 'baseline'
  };
  b = b.slice(0, 3);
  b = appendRecord(b, { kind: 'attestation', value: edit }, at);
  const second = signJournal(b, secondKey.privateKey, '2026-01-04T00:00:00Z');
  return {
    a, b, first, second,
    firstPolicy: {
      publisher: 'fictional-A', publicKeySha256: checkpoint.signerKeySha256,
      anchor: { sequence: 1, head: a[1].hash }
    },
    secondPolicy: {
      publisher: 'fictional-B', publicKeySha256: inspectSignedExchange(second).checkpoint.signerKeySha256,
      anchor: { sequence: 1, head: b[1].hash }
    }
  };
}
const status = (r, id) => r.findings.find(x => x.ruleId === id)?.status;
const copy = x => structuredClone(x);
test('DSSE PAE is length-prefixed and binds both payload and type', () => {
  assert.equal(pae('x', Buffer.from('abc')).toString(), 'DSSEv1 1 x 3 abc');
  assert.notDeepEqual(pae('xx', Buffer.from('abc')), pae('x', Buffer.from('xabc')));
});
test('signed checkpoint replays full journal and binds signer to journal head', () => {
  const p = pair();
  const report = inspectSignedExchange(p.first, p.firstPolicy);
  assert.equal(status(report, 'SP002'), 'PASS');
  assert.equal(status(report, 'SP003'), 'PASS');
  assert.equal(status(report, 'SP004'), 'PASS');
  assert.equal(status(report, 'SP005'), 'PASS');
  assert.equal(status(report, 'SP006'), 'UNKNOWN');
  assert.equal(report.checkpoint.journalHead, validateJournal(p.a).head);
  assert.equal(report.bundle.attestations[0].measurement.result.value, 12);
});
test('without out-of-band pin, signatures and self-issued heads do not prove real publisher identity', () => {
  const p = pair();
  assert.equal(status(inspectSignedExchange(p.first), 'SP004'), 'UNKNOWN');
  assert.equal(status(inspectSignedExchange(p.first), 'SP005'), 'UNKNOWN');
});
test('strict complete canonical package bytes reject duplicated keys and whitespace rewrites', () => {
  const p = pair();
  const bytes = serializeSignedExchange(p.first);
  assert.deepEqual(readSignedExchange(bytes), p.first);
  assert.throws(() => readSignedExchange(bytes.replace('"format":', '"format":"x","format":')), /not canonical/);
  assert.throws(() => readSignedExchange(' ' + bytes), /not canonical/);
  assert.throws(() => readSignedExchange(bytes.slice(0, -1)), /not canonical/);
});
test('journal tampering cannot be hidden by the original valid Ed25519 signature', () => {
  const p = pair();
  const corrupted = copy(p.first);
  corrupted.journal = corrupted.journal.replace('fictional bounded drain segment', 'fictional OTHER drain segment');
  assert.equal(status(inspectSignedExchange(corrupted, p.firstPolicy), 'SP002'), 'FAIL');
});
test('signed checkpoint tampering fails even when payload remains syntactically canonical', () => {
  const p = pair();
  const corrupted = copy(p.first);
  const c = JSON.parse(Buffer.from(corrupted.envelope.payload, 'base64').toString());
  c.journalHead = '0'.repeat(64);
  // The signature remains old; a detached data mutation must fail.
  corrupted.envelope.payload = Buffer.from(JSON.stringify(c)).toString('base64');
  assert.equal(status(inspectSignedExchange(corrupted, p.firstPolicy), 'SP003'), 'FAIL');
});
test('signature corruption, swapped signer, unsupported algorithm and extra signatures fail', () => {
  const p = pair();
  const corrupted = copy(p.first);
  corrupted.envelope.signatures[0].sig = Buffer.alloc(64).toString('base64');
  assert.equal(status(inspectSignedExchange(corrupted), 'SP003'), 'FAIL');
  const swapped = copy(p.first);
  swapped.publicKeySpki = p.second.publicKeySpki;
  assert.equal(status(inspectSignedExchange(swapped), 'SP003'), 'FAIL');
  const extra = copy(p.first);
  extra.envelope.signatures.push(copy(extra.envelope.signatures[0]));
  assert.equal(status(inspectSignedExchange(extra), 'SP001'), 'FAIL');
  const unknown = copy(p.first);
  unknown.envelope.payloadType = 'another/type';
  assert.equal(status(inspectSignedExchange(unknown), 'SP001'), 'FAIL');
});
test('wrong independently pinned key, name, or historical anchor fails closed', () => {
  const p = pair();
  assert.equal(status(inspectSignedExchange(p.first, { ...p.firstPolicy, publicKeySha256: '1'.repeat(64) }), 'SP004'), 'FAIL');
  assert.equal(status(inspectSignedExchange(p.first, { ...p.firstPolicy, publisher: 'other' }), 'SP004'), 'FAIL');
  assert.equal(status(inspectSignedExchange(p.first, { ...p.firstPolicy, anchor: { sequence: 1, head: '1'.repeat(64) } }), 'SP005'), 'FAIL');
});
test('two independently signed histories preserve contest and flag copied evidence bytes', () => {
  const p = pair();
  const report = inspectSignedPair(p.first, p.second, { publisher: p.firstPolicy, challenger: p.secondPolicy });
  assert.equal(status(report, 'PX001'), 'PASS');
  assert.equal(status(report, 'PX002'), 'PASS');
  assert.equal(status(report, 'PX003'), 'WARN');
  assert.equal(report.reusedEvidence.length, 1);
  assert.equal(report.comparisons.length, 1);
  assert.equal(report.comparisons[0].findings.find(x => x.ruleId === 'XC003')?.status, 'WARN');
});
test('different evidence bytes do not establish sample independence', () => {
  const p = pair({ sameText: false });
  assert.equal(status(inspectSignedPair(p.first, p.second), 'PX003'), 'UNKNOWN');
});
test('two signed aliases sharing one signing key are not independent publishers', () => {
  const p = pair({ sameKey: true });
  assert.equal(status(inspectSignedPair(p.first, p.second), 'PX002'), 'WARN');
});
test('one failed trust anchor suppresses all downstream numerical comparisons', () => {
  const p = pair();
  const report = inspectSignedPair(p.first, p.second,
    { publisher: { ...p.firstPolicy, anchor: { sequence: 1, head: '0'.repeat(64) } },
      challenger: p.secondPolicy });
  assert.equal(status(report, 'PX001'), 'FAIL');
  assert.equal(report.comparisons.length, 0);
});
test('Python independently checks the same local journal byte-chain and trusted head', () => {
  const p = pair();
  const checker = new URL('../research/offline-v0/journal_check.py', import.meta.url).pathname;
  const run = spawnSync('python3', [checker, validateJournal(p.a).head], {
    input: p.first.journal, encoding: 'utf8'
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
});

test('one signing key cannot conceal two incompatible signed histories past a shared anchor', () => {
  const p = pair();
  const secondHistory = journal('fictional-A', 'baseline', 31,
    'FICTIONAL contrary notes, second complete journal fork');
  const privateKey = generateKeyPairSync('ed25519');
  // Keep a single exact signer for both histories.
  const signedOriginal = signJournal(p.a, privateKey.privateKey, '2026-01-04T00:00:00Z');
  const signedFork = signJournal(secondHistory, privateKey.privateKey, '2026-01-04T00:00:00Z');
  const pinned = {
    publisher: 'fictional-A',
    publicKeySha256: inspectSignedExchange(signedOriginal).checkpoint.signerKeySha256,
    anchor: { sequence: 1, head: p.a[1].hash }
  };
  const report = inspectSignedHistoryConflict(signedOriginal, signedFork, pinned);
  assert.equal(status(report, 'HF001'), 'PASS');
  assert.equal(status(report, 'HF002'), 'WARN');
  assert.equal(report.firstDivergentSequence, 2);
  assert.equal(status(report, 'HF003'), 'PASS');
});
test('signed append-only journal extension is not falsely marked a fork', () => {
  const p = pair();
  const keyPair = generateKeyPairSync('ed25519');
  const first = signJournal(p.a, keyPair.privateKey, '2026-01-04T00:00:00Z');
  const longer = appendRecord(p.a, { kind: 'evidence', value: {
    id: 'new-note', access: 'inline', text: 'FICTIONAL future note',
    sha256: hash('FICTIONAL future note')
  } }, '2026-01-04T01:00:00Z');
  const second = signJournal(longer, keyPair.privateKey, '2026-01-05T00:00:00Z');
  assert.equal(status(inspectSignedHistoryConflict(first, second), 'HF002'), 'PASS');
  assert.equal(status(inspectSignedHistoryConflict(first, first), 'HF002'), 'PASS');
});
test('history conflict detection is withheld when signatures identify different keys', () => {
  const p = pair();
  const alternative = signJournal(p.a, generateKeyPairSync('ed25519').privateKey,
    '2026-01-04T00:00:00Z');
  const result = inspectSignedHistoryConflict(p.first, alternative);
  assert.equal(status(result, 'HF001'), 'UNKNOWN');
  assert.equal(result.firstDivergentSequence, undefined);
});
