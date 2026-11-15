/**
 * Research-v0 local journal: portable append-only records without a server.
 *
 * Hash chains detect mutation against an independently retained head digest.
 * They do NOT attest actual event time, identity, authority, ecological truth,
 * or prevent wholesale replacement when no external checkpoint is retained.
 */
import { createHash } from 'node:crypto';
import { CONSTITUTION_SHA256, FORMAT, hasFailures, validTime, verifyBundle } from './verify.mjs';

export const JOURNAL_FORMAT = 'ecowealth-local-journal-v0';
export const GENESIS_HASH = '0'.repeat(64);
const HEX = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length > 0;

/** Deterministic UTF-8 JSON for this version; not a cross-protocol JCS claim. */
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('nonfinite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (!object(value)) throw new TypeError('unsupported JSON value');
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function digest(payload) {
  return createHash('sha256').update(canonical(payload), 'utf8').digest('hex');
}

function entry(seq, recordedAt, record, prevHash) {
  const fields = { seq, recordedAt, record, prevHash };
  return { ...fields, hash: digest(fields) };
}

function checkRecord(record) {
  if (!object(record) || !['genesis', 'referent', 'attestation', 'evidence'].includes(record.kind) ||
      !object(record.value)) throw new TypeError('unknown or malformed journal record');
  if (record.kind === 'genesis') {
    const value = record.value;
    if (value.journalFormat !== JOURNAL_FORMAT || !string(value.source) ||
        !object(value.constitution) ||
        value.constitution.identifier !== 'ECOWEALTH-CONSTITUTION-v1' ||
        value.constitution.sha256 !== CONSTITUTION_SHA256)
      throw new TypeError('invalid pinned genesis constitution or source');
  } else if (record.kind === 'referent') {
    if (!string(record.value.id) || !string(record.value.boundary))
      throw new TypeError('invalid Referent');
  } else if (record.kind === 'attestation') {
    const a = record.value;
    if (!string(a.scopeReferent) || !string(a.localId) ||
        !validTime(a.assertedAt) || !validTime(a.effectiveAt) ||
        Object.hasOwn(a, 'recordedAt'))
      throw new TypeError('invalid Attestation identity, time, or reserved recordedAt field');
  } else if (!string(record.value.id) ||
             !['inline', 'restricted', 'missing'].includes(record.value.access)) {
    throw new TypeError('invalid evidence identity or access');
  }
}

export function createJournal({ source, recordedAt }) {
  if (!string(source) || !validTime(recordedAt)) throw new TypeError('invalid journal provenance or time');
  return [entry(0, recordedAt, {
    kind: 'genesis', value: {
      journalFormat: JOURNAL_FORMAT, source, constitution: {
        identifier: 'ECOWEALTH-CONSTITUTION-v1', sha256: CONSTITUTION_SHA256
      }
    }
  }, GENESIS_HASH)];
}

export function readJournal(text) {
  if (typeof text !== 'string' || text.length > 64 * 1024 * 1024)
    throw new TypeError('journal text exceeds 64 MiB limit');
  if (!text.endsWith('\n')) throw new TypeError('incomplete journal: trailing newline required');
  const lines = text.trimEnd().split('\n');
  if (lines.length > 25001) throw new TypeError('journal entry limit exceeded');
  const entries = lines.map((line, i) => {
    if (line.length > 17 * 1024 * 1024) throw new TypeError('journal line exceeds limit');
    let record;
    try { record = JSON.parse(line); }
    catch { throw new TypeError('invalid JSON at journal entry ' + i); }
    // Strict canonical bytes reject duplicate JSON keys, whitespace variants,
    // ambiguous numeric spellings, and mixed serialization conventions.
    // Never verify a hash over parsed data while accepting different raw bytes.
    if (canonical(record) !== line)
      throw new TypeError('noncanonical journal JSON at entry ' + i);
    return record;
  });
  validateJournal(entries);
  return entries;
}

export function validateJournal(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 25001)
    throw new TypeError('journal must contain 1..25001 entries');
  let previous = GENESIS_HASH;
  let lastTime = -Infinity;
  for (const [index, e] of entries.entries()) {
    if (!object(e) || Object.keys(e).sort().join(',') !== 'hash,prevHash,record,recordedAt,seq' ||
        e.seq !== index || !HEX.test(e.hash) || e.prevHash !== previous ||
        !validTime(e.recordedAt))
      throw new TypeError('malformed or reordered journal entry ' + index);
    checkRecord(e.record);
    if ((index === 0) !== (e.record.kind === 'genesis'))
      throw new TypeError('genesis must occur exactly once at entry zero');
    const currentTime = Date.parse(e.recordedAt);
    if (currentTime < lastTime) throw new TypeError('journal recorded time regressed at ' + index);
    if (e.record.kind === 'attestation' && Date.parse(e.record.value.assertedAt) > currentTime)
      throw new TypeError('assertion timestamp follows journal receipt at ' + index);
    const expected = digest({ seq: e.seq, recordedAt: e.recordedAt, record: e.record, prevHash: e.prevHash });
    if (expected !== e.hash) throw new TypeError('journal hash mismatch at entry ' + index);
    previous = e.hash;
    lastTime = currentTime;
  }
  return { entries: entries.length, head: previous };
}

export function exportBundle(entries) {
  validateJournal(entries);
  const first = entries[0], last = entries[entries.length - 1];
  const bundle = {
    format: FORMAT,
    constitution: structuredClone(first.record.value.constitution),
    provenance: {
      source: first.record.value.source,
      exportedAt: last.recordedAt,
      localJournalHead: last.hash
    },
    referents: [], attestations: [], evidence: []
  };
  for (const e of entries.slice(1)) {
    if (e.record.kind === 'referent') bundle.referents.push(structuredClone(e.record.value));
    else if (e.record.kind === 'evidence') bundle.evidence.push(structuredClone(e.record.value));
    else if (e.record.kind === 'attestation')
      bundle.attestations.push({ ...structuredClone(e.record.value), recordedAt: e.recordedAt });
  }
  return bundle;
}

export function appendRecord(entries, record, recordedAt) {
  validateJournal(entries);
  checkRecord(record);
  if (record.kind === 'genesis') throw new TypeError('cannot append second genesis');
  if (!validTime(recordedAt) ||
      Date.parse(recordedAt) < Date.parse(entries[entries.length - 1].recordedAt))
    throw new TypeError('recordedAt invalid or regressed');
  if (entries.length >= 25001) throw new TypeError('journal entry limit exceeded');
  const next = entry(entries.length, recordedAt, structuredClone(record),
    entries[entries.length - 1].hash);
  const candidate = [...entries, next];
  const report = verifyBundle(exportBundle(candidate));
  if (hasFailures(report)) {
    const findings = Object.values(report.dimensions).flat()
      .filter(f => f.status === 'FAIL').map(f => f.ruleId);
    throw new TypeError('journal append fails offline verification: ' + [...new Set(findings)].join(','));
  }
  return candidate;
}

export function snapshot(entries, asOf) {
  const bundle = exportBundle(entries);
  return verifyBundle(bundle, asOf === undefined ? {} : { asOf });
}

export function serializeJournal(entries) {
  validateJournal(entries);
  return entries.map(e => canonical(e)).join('\n') + '\n';
}

/** Compare with a separately retained digest to detect wholesale replacement. */
export function checkHead(entries, expectedHead) {
  const { head } = validateJournal(entries);
  if (typeof expectedHead !== 'string' || !HEX.test(expectedHead))
    throw new TypeError('expected head must be a lowercase SHA-256 hex digest');
  if (head !== expectedHead) throw new TypeError('journal head does not match trusted checkpoint');
  return { head, matches: true };
}
