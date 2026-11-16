/**
 * Experimental quantitative-observation extension to Referent/Attestation bundles.
 * Bounded mechanical checks only. No ecological or scientific truth verdict.
 * OGC OMS/SOSA-inspired field names; NOT an OMS, SOSA, or full UCUM implementation.
 */
import { createHash } from 'node:crypto';
import { validTime } from './verify.mjs';

export const MEASUREMENT_FORMAT = 'ecowealth-quantitative-observation-v0';
export const UCUM_LENGTH_TO_METERS = Object.freeze({ mm: 0.001, cm: 0.01, m: 1 });
const HEX = /^[0-9a-f]{64}$/;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const word = (x, n = 256) => typeof x === 'string' && x.length > 0 && x.length <= n;
const sha = x => createHash('sha256').update(x, 'utf8').digest('hex');
const identity = a => JSON.stringify([a.scopeReferent, a.localId]);
const numeric = x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e12;
const names = new Set([
  'format', 'observedProperty', 'featureOfInterest', 'phenomenonTime', 'resultTime',
  'result', 'procedure', 'sampling', 'source', 'evidenceRefs', 'limitations', 'contests'
]);

export function inspectMeasurements(bundle) {
  const findings = [];
  const add = (at, ruleId, status, reason) => findings.push({ at, ruleId, status, reason });
  if (!object(bundle) || !Array.isArray(bundle.referents) ||
      !Array.isArray(bundle.attestations) || !Array.isArray(bundle.evidence) ||
      bundle.referents.length > 25000 || bundle.attestations.length > 25000 ||
      bundle.evidence.length > 25000) {
    add('bundle', 'MV000', 'FAIL', 'bounded portable bundle arrays required');
    return { experimental: true, format: MEASUREMENT_FORMAT, count: 0, findings };
  }
  const referents = new Map();
  for (const r of bundle.referents) {
    if (!object(r) || !word(r.id) || !word(r.boundary, 10000)) continue;
    if (referents.has(r.id)) referents.set(r.id, null); // duplicate identity tainted
    else referents.set(r.id, r.boundary);
  }
  const evidence = new Map();
  for (const e of bundle.evidence) {
    if (!object(e) || !word(e.id)) continue;
    if (evidence.has(e.id)) evidence.set(e.id, null);
    else evidence.set(e.id, e);
  }
  let count = 0;
  for (const [index, a] of bundle.attestations.entries()) {
    if (!object(a) || !Object.hasOwn(a, 'measurement')) continue;
    count++;
    const at = word(a.scopeReferent) && word(a.localId) ? identity(a) : 'attestations[' + index + ']';
    if (count > 2000) {
      add(at, 'MV000', 'FAIL', 'measurement count exceeds bounded experiment limit');
      break;
    }
    const m = a.measurement;
    if (!object(m) || m.format !== MEASUREMENT_FORMAT ||
        !['observation', 'follow_up_observation'].includes(a.role)) {
      add(at, 'MV001', 'FAIL', 'measurement requires versioned format and observation role');
      continue;
    }
    add(at, 'MV001', 'PASS', 'experimental observation role and format recognized');
    const feature = m.featureOfInterest;
    const boundary = object(feature) ? referents.get(feature.referentId) : undefined;
    if (!object(feature) || !word(feature.referentId) ||
        feature.referentId !== a.scopeReferent || !Array.isArray(a.concerns) ||
        !a.concerns.includes(feature.referentId) ||
        typeof boundary !== 'string' || !HEX.test(feature.boundarySha256) ||
        sha(boundary) !== feature.boundarySha256) {
      add(at, 'MV002', 'FAIL', 'missing, ambiguous, drifted, or unbound feature-of-interest boundary');
    } else add(at, 'MV002', 'PASS', 'declared boundary bytes match local Referent and attestation scope');
    const result = m.result;
    if (!object(result) || !numeric(result.value) ||
        !Object.hasOwn(UCUM_LENGTH_TO_METERS, result.unit) ||
        !numeric(result.uncertaintyAbsolute) || result.uncertaintyAbsolute < 0) {
      add(at, 'MV003', 'FAIL', 'finite value, nonnegative absolute uncertainty and supported UCUM length unit required');
    } else add(at, 'MV003', 'PASS', 'numeric fields and limited UCUM length unit mechanically valid');
    const period = m.phenomenonTime;
    if (!object(period) || !validTime(period.start) || !validTime(period.end) ||
        Date.parse(period.start) > Date.parse(period.end) ||
        !validTime(m.resultTime) || Date.parse(m.resultTime) < Date.parse(period.end) ||
        !validTime(a.assertedAt) || Date.parse(a.assertedAt) < Date.parse(m.resultTime)) {
      add(at, 'MV004', 'FAIL', 'invalid interval or impossible declared result/assertion order');
    } else add(at, 'MV004', 'PASS', 'declared sampling, result and assertion times are consistently ordered');
    if (!word(m.observedProperty, 500) || !object(m.procedure) ||
        !word(m.procedure.id, 500) || !word(m.procedure.version, 100) ||
        !object(m.sampling) || !word(m.sampling.description, 1000) ||
        !Number.isSafeInteger(m.sampling.sampleCount) ||
        m.sampling.sampleCount < 1 || m.sampling.sampleCount > 1000000 ||
        !word(m.source, 500) || !Array.isArray(m.limitations) ||
        m.limitations.length < 1 || m.limitations.length > 20 ||
        m.limitations.some(x => !word(x, 1000))) {
      add(at, 'MV005', 'FAIL', 'property, procedure version, sampling, source and explicit limitations required');
    } else add(at, 'MV005', 'PASS', 'measurement-context descriptors present; method suitability not assessed');
    let evidenceState = 'PASS';
    if (!Array.isArray(m.evidenceRefs) || m.evidenceRefs.length === 0 ||
        m.evidenceRefs.length > 100 || !Array.isArray(a.evidenceRefs)) evidenceState = 'FAIL';
    else {
      const seen = new Set();
      for (const ref of m.evidenceRefs) {
        if (!word(ref) || seen.has(ref) || !a.evidenceRefs.includes(ref) || !evidence.has(ref)) {
          evidenceState = 'FAIL'; break;
        }
        seen.add(ref);
        const e = evidence.get(ref);
        if (!e || !object(e)) { evidenceState = 'FAIL'; break; }
        if (e.access === 'inline') {
          if (typeof e.text !== 'string' || !HEX.test(e.sha256) || sha(e.text) !== e.sha256) {
            evidenceState = 'FAIL'; break;
          }
        } else if (e.access === 'restricted' || e.access === 'missing') {
          if (evidenceState !== 'FAIL') evidenceState = 'UNKNOWN';
        } else { evidenceState = 'FAIL'; break; }
      }
    }
    add(at, 'MV006', evidenceState, evidenceState === 'PASS'
      ? 'declared inline supporting bytes match hashes, not real-world authenticity'
      : evidenceState === 'UNKNOWN' ? 'some supporting evidence is unavailable offline'
      : 'invalid, missing, duplicated or unbound measurement evidence');
    if (Object.hasOwn(m, 'contests')) {
      const c = m.contests;
      if (!object(c) || !word(c.publisher) || !HEX.test(c.journalHead) ||
          !word(c.scopeReferent) || !word(c.localId))
        add(at, 'MV009', 'FAIL', 'malformed cross-publisher contest locator');
      else add(at, 'MV009', 'PASS', 'contest locator structurally complete; publisher identity not authenticated');
    }
    if (Object.keys(m).some(k => !names.has(k)))
      add(at, 'MV010', 'WARN', 'unrecognized measurement extension fields ignored');
    add(at, 'MV007', 'UNKNOWN', 'actor identity, clock, instrument calibration and method fitness not authenticated');
    add(at, 'MV008', 'UNKNOWN', 'measurement does not establish ecological benefit or causal intervention success');
  }
  return { experimental: true, format: MEASUREMENT_FORMAT, count, findings };
}

/**
 * Evaluate only explicitly linked competing measurements from a different bundle.
 * Sources remain separate; no implicit merging of Attestation namespaces.
 */
export function inspectExchange(publisher, challenger) {
  const left = inspectMeasurements(publisher), right = inspectMeasurements(challenger);
  const comparisons = [];
  const candidates = new Map();
  if (!object(publisher) || !object(challenger) ||
      !Array.isArray(publisher.attestations) || !Array.isArray(challenger.attestations))
    return { experimental: true, publisher: left, challenger: right, comparisons };
  for (const a of publisher.attestations) {
    if (!object(a) || !object(a.measurement)) continue;
    const key = identity(a);
    if (candidates.has(key)) candidates.set(key, null);
    else candidates.set(key, a);
  }
  const leftSource = publisher.provenance?.source, leftHead = publisher.provenance?.localJournalHead;
  const valid = (report, at) => !report.findings.some(x => x.at === at && x.status === 'FAIL');
  for (const a of challenger.attestations) {
    const contest = a?.measurement?.contests;
    if (!object(contest)) continue;
    const challengerId = identity(a), key = JSON.stringify([contest.scopeReferent, contest.localId]);
    const comparison = { challenger: challengerId, publisher: key, findings: [] };
    const add = (ruleId, status, reason) => comparison.findings.push({ ruleId, status, reason });
    const original = candidates.get(key);
    if (contest.publisher !== leftSource || contest.journalHead !== leftHead ||
        !HEX.test(leftHead) || !original) {
      add('XC001', 'FAIL', 'contest locator does not resolve uniquely to the supplied publisher bundle and claimed head');
      comparisons.push(comparison); continue;
    }
    add('XC001', 'PASS', 'locator matches supplied source and self-declared head; no external authenticity');
    if (!valid(left, key) || !valid(right, challengerId)) {
      add('XC002', 'UNKNOWN', 'structurally invalid measurement; numeric comparison withheld');
      comparisons.push(comparison); continue;
    }
    const p = original.measurement, c = a.measurement;
    if (p.observedProperty !== c.observedProperty ||
        p.featureOfInterest?.referentId !== c.featureOfInterest?.referentId ||
        p.featureOfInterest?.boundarySha256 !== c.featureOfInterest?.boundarySha256 ||
        p.phenomenonTime?.start !== c.phenomenonTime?.start ||
        p.phenomenonTime?.end !== c.phenomenonTime?.end ||
        p.procedure?.id !== c.procedure?.id ||
        p.procedure?.version !== c.procedure?.version) {
      add('XC002', 'UNKNOWN', 'different property, boundary, sampling window or method; values not comparable');
      comparisons.push(comparison); continue;
    }
    const f1 = UCUM_LENGTH_TO_METERS[p.result.unit], f2 = UCUM_LENGTH_TO_METERS[c.result.unit];
    if (!f1 || !f2) {
      add('XC002', 'UNKNOWN', 'unsupported conversion; values not compared');
      comparisons.push(comparison); continue;
    }
    const aLow = (p.result.value - p.result.uncertaintyAbsolute) * f1;
    const aHigh = (p.result.value + p.result.uncertaintyAbsolute) * f1;
    const bLow = (c.result.value - c.result.uncertaintyAbsolute) * f2;
    const bHigh = (c.result.value + c.result.uncertaintyAbsolute) * f2;
    const slack = 1e-12 * Math.max(1, Math.abs(aHigh), Math.abs(bHigh));
    add('XC002', 'PASS', 'identity conditions matched; length converted to meters and declared intervals computed');
    if (aHigh + slack < bLow || bHigh + slack < aLow)
      add('XC003', 'WARN', 'declared uncertainty intervals are disjoint; disagreement needs investigation');
    else add('XC003', 'UNKNOWN', 'intervals overlap; independence, calibration and corroboration not established');
    comparisons.push(comparison);
  }
  return { experimental: true, publisher: left, challenger: right, comparisons };
}
