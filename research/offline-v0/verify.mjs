/**
 * Research-only offline inspector derived from the 2026-11-14 kernel review.
 * It checks record structure and inline evidence bytes, not constitutive authority.
 * No private keys, network calls, field action, funding or settlement validation.
 */
import { createHash } from 'node:crypto';

export const FORMAT = 'ecowealth-offline-research-v0';
export const CONSTITUTION_SHA256 = 'fa5d86dcaf9eb54ecfe68588752c2ddfb3387532c0adcba47e1c5c794e892cdd';
const SHA = /^[a-f0-9]{64}$/;
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;
const ROLES = new Set(['transition_specification','observation','authority_claim','work_proposal','commitment','intervention','judgement','obligation_admission','disposition','funding','payment','settlement','follow_up_observation']);
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.length > 0;
// Preserve the ordered identity pair without delimiter collisions. A scope or local ID
// may contain punctuation; a string join can alias unrelated attestations.
const attId = a => isObject(a) && nonempty(a.scopeReferent) && nonempty(a.localId)
  ? JSON.stringify([a.scopeReferent, a.localId]) : null;
const digest = s => createHash('sha256').update(s, 'utf8').digest('hex');

/** Reject rollover dates (e.g. February 30) and malformed RFC3339 offsets. */
export function validTime(value) {
  if (typeof value !== 'string') return false;
  const m = STAMP.exec(value);
  if (!m) return false;
  const [, ys, ms, ds, hs, mins, ss, , zone] = m;
  const y = +ys, mo = +ms, d = +ds, h = +hs, mi = +mins, s = +ss;
  if (!y || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return false;
  if (zone !== 'Z' && (+zone.slice(1,3) > 23 || +zone.slice(4,6) > 59)) return false;
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, s, 0);
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d && Number.isFinite(Date.parse(value));
}

export function hasFailures(report) {
  return Object.values(report.dimensions).some(items => items.some(item => item.status === 'FAIL'));
}

export function verifyBundle(bundle, { asOf } = {}) {
  const dimensions = {
    structural: [], evidence: [], provenance: [], authority: [], obligations: [],
    privacy: [], signatures: [], economy: [], ecology: []
  };
  const report = {
    researchOnly: true, format: FORMAT,
    dimensions,
    counts: { referents: 0, attestations: 0, evidence: 0 },
    recordedState: {
      asOf: asOf ?? null, openObligationAssertions: [],
      closureAssertions: [], conflictingAttestations: []
    },
    limitations: [
      'Not constitutional conformance or a professional approval',
      'No cryptographic signature or delegated-authority verification',
      'No proof of real-world work, ecological outcome, funding or canonical settlement'
    ]
  };
  const add = (group, ruleId, status, reason, at) =>
    dimensions[group].push({ ruleId, status, reason, ...(at === undefined ? {} : { at }) });
  if (!isObject(bundle)) {
    add('structural', 'S001', 'FAIL', 'bundle must be an object');
    return report;
  }
  if (bundle.format !== FORMAT) add('structural', 'S002', 'FAIL', 'unsupported format');
  if (!isObject(bundle.constitution) ||
      bundle.constitution.identifier !== 'ECOWEALTH-CONSTITUTION-v1' ||
      bundle.constitution.sha256 !== CONSTITUTION_SHA256) {
    add('provenance', 'P001', 'FAIL', 'constitution identifier or digest mismatch');
  } else {
    add('provenance', 'P001', 'PASS', 'digest matches; operator adoption authority not independently verified');
  }
  if (!isObject(bundle.provenance) || !nonempty(bundle.provenance.source) ||
      !validTime(bundle.provenance.exportedAt))
    add('provenance', 'P002', 'UNKNOWN', 'export origin or timestamp not established');
  if (asOf !== undefined && !validTime(asOf)) {
    add('structural', 'S003', 'FAIL', 'invalid record-time snapshot');
    return report;
  }
  if (!Array.isArray(bundle.referents) ||
      !Array.isArray(bundle.attestations) || !Array.isArray(bundle.evidence)) {
    add('structural', 'S004', 'FAIL', 'root arrays required');
    return report;
  }
  report.counts = {
    referents: bundle.referents.length,
    attestations: bundle.attestations.length,
    evidence: bundle.evidence.length
  };
  const referents = new Set();
  for (const [i, r] of bundle.referents.entries()) {
    if (!isObject(r) || !nonempty(r.id) || !nonempty(r.boundary)) {
      add('structural', 'S005', 'FAIL', 'invalid Referent', 'referents[' + i + ']');
      continue;
    }
    if (referents.has(r.id)) add('structural', 'S006', 'FAIL', 'duplicate Referent', r.id);
    referents.add(r.id);
  }
  const attestations = new Map();
  for (const [i, a] of bundle.attestations.entries()) {
    const id = attId(a);
    if (!id || !nonempty(a.actor) || !nonempty(a.role) || !nonempty(a.method) ||
        !validTime(a.assertedAt) || !validTime(a.effectiveAt) ||
        !Object.hasOwn(a, 'authority') || !Array.isArray(a.concerns) ||
        !Array.isArray(a.evidenceRefs) || !Array.isArray(a.relations)) {
      add('structural', 'S007', 'FAIL', 'incomplete Attestation', 'attestations[' + i + ']');
      continue;
    }
    if (!referents.has(a.scopeReferent)) add('structural', 'S008', 'FAIL', 'unknown scope Referent', id);
    if (!a.concerns.length || a.concerns.some(ref => !referents.has(ref)))
      add('structural', 'S009', 'FAIL', 'unknown concern Referent', id);
    if (!ROLES.has(a.role)) add('structural', 'S010', 'UNKNOWN', 'unrecognized derived role', id);
    if (attestations.has(id)) add('structural', 'S011', 'FAIL', 'duplicate Attestation identity', id);
    else attestations.set(id, a);
    add('authority', 'A001', 'UNKNOWN', 'authority is not independently checked', id);
    add('signatures', 'G001', 'UNKNOWN', 'cryptographic signature not checked', id);
  }
  const evidence = new Map();
  for (const [i, item] of bundle.evidence.entries()) {
    if (!isObject(item) || !nonempty(item.id) ||
        !['inline', 'restricted', 'missing'].includes(item.access)) {
      add('evidence', 'E001', 'FAIL', 'invalid evidence item', 'evidence[' + i + ']');
      continue;
    }
    if (evidence.has(item.id)) add('evidence', 'E002', 'FAIL', 'duplicate evidence identity', item.id);
    evidence.set(item.id, item);
    if (item.access === 'inline') {
      if (typeof item.text !== 'string' || !SHA.test(item.sha256))
        add('evidence', 'E003', 'FAIL', 'inline text and SHA-256 required', item.id);
      else if (digest(item.text) !== item.sha256)
        add('evidence', 'E004', 'FAIL', 'inline digest mismatch', item.id);
      else add('evidence', 'E004', 'PASS', 'bytes match claimed digest; truth unverified', item.id);
    } else {
      if (Object.hasOwn(item, 'text'))
        add('evidence', 'E008', 'FAIL', 'restricted/missing evidence includes inline content', item.id);
      add('evidence', 'E005', 'UNKNOWN', 'withheld or missing evidence cannot be checked', item.id);
      if (item.access === 'restricted' && !Object.hasOwn(item, 'text'))
        add('privacy', 'R001', 'PASS', 'restricted content not included', item.id);
    }
  }
  for (const [id, a] of attestations) {
    for (const ref of a.evidenceRefs) {
      if (!evidence.has(ref)) add('evidence', 'E007', 'FAIL', 'absent evidence reference', id);
    }
    for (const rel of a.relations) {
      const targetId = isObject(rel) ? attId(rel.to) : null;
      if (!isObject(rel) || !nonempty(rel.kind) || !targetId || !attestations.has(targetId)) {
        add('structural', 'S013', 'FAIL', 'unresolved Attestation relation', id);
        continue;
      }
      const target = attestations.get(targetId);
      if (Date.parse(target.assertedAt) > Date.parse(a.assertedAt))
        add('structural', 'S014', 'FAIL', 'relation points to later assertion', id);
      if (rel.kind === 'contradicts')
        report.recordedState.conflictingAttestations.push([id, targetId]);
    }
  }
  const before = a => asOf === undefined || Date.parse(a.assertedAt) <= Date.parse(asOf);
  const admissions = [...attestations].filter(([, a]) => a.role === 'obligation_admission' && before(a));
  const dispositions = [...attestations].filter(([, a]) => a.role === 'disposition' && before(a));
  for (const [id] of admissions) {
    const closers = dispositions.filter(([, d]) => d.effect === 'close' &&
      d.relations.some(rel => rel.kind === 'disposes' && attId(rel.to) === id));
    if (closers.length) {
      add('obligations', 'O001', 'UNKNOWN', 'closure asserted; authorization unverified', id);
      report.recordedState.closureAssertions.push({
        obligation: id, dispositions: closers.map(([closeId]) => closeId)
      });
    } else {
      add('obligations', 'O002', 'WARN', 'no closure assertion yet', id);
      report.recordedState.openObligationAssertions.push(id);
    }
  }
  for (const [id, d] of dispositions) {
    if (d.effect === 'close' && !d.relations.some(rel =>
      rel.kind === 'disposes' && attestations.get(attId(rel.to))?.role === 'obligation_admission'))
      add('obligations', 'O003', 'FAIL', 'closing disposition lacks obligation admission', id);
  }
  const present = role => [...attestations.values()].some(a => a.role === role && before(a));
  if (present('payment') && !present('settlement'))
    add('economy', 'M001', 'WARN', 'payment asserted, settlement not established');
  else add('economy', 'M001', 'UNKNOWN', 'funding and settlement not externally verified');
  add('ecology', 'L001', 'UNKNOWN', 'ecological condition and causality not independently validated');
  add('structural', 'S999', dimensions.structural.some(x => x.status === 'FAIL') ?
    'FAIL' : 'PASS', 'record graph assessed under non-normative research rules');
  return report;
}
