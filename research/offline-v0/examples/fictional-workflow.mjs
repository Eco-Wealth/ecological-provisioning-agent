#!/usr/bin/env node
/**
 * Entirely fictional demonstration: condition -> proposal -> obligation ->
 * intervention claim -> follow-up observation -> judgement -> disposition.
 * The records do not prove authority or an ecological outcome.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { appendRecord, createJournal, serializeJournal, snapshot, validateJournal }
  from '../journal.mjs';
import { hasFailures } from '../verify.mjs';

const output = process.argv[2];
if (!output || process.argv.length !== 3) {
  console.error('Usage: node research/offline-v0/examples/fictional-workflow.mjs <new-journal.jsonl>');
  process.exit(2);
}
const at = n => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 60000).toISOString();
let tick = 0;
let entries = createJournal({ source: 'FICTIONAL-ecological-lifecycle-not-field-evidence', recordedAt: at(tick++) });
const add = (kind, value) => {
  entries = appendRecord(entries, { kind, value }, at(tick++));
};
const target = localId => ({ scopeReferent: 'fictional-drain', localId });
const link = (localId, kind = 'based_on') => ({ kind, to: target(localId) });
const evidence = (id, text) => add('evidence', {
  id, access: 'inline', text, sha256: createHash('sha256').update(text).digest('hex')
});
const attestation = (localId, role, attributes = {}) => {
  const time = at(tick);
  add('attestation', {
    scopeReferent: 'fictional-drain', localId, role,
    actor: 'FICTIONAL_ACTOR_NO_REAL_AUTHORITY',
    concerns: ['fictional-drain'], assertedAt: time, effectiveAt: time,
    authority: null, method: 'fictional teaching fixture',
    evidenceRefs: [], relations: [], ...attributes
  });
};

add('referent', { id: 'fictional-drain', boundary: 'fictional storm drain; location withheld because nonexistent' });
add('referent', { id: 'fictional-condition', boundary: 'fictional sediment accumulation condition' });
evidence('baseline-note', 'FICTIONAL baseline: sediment reported; no independent measurement');
attestation('baseline', 'observation', {
  concerns: ['fictional-drain', 'fictional-condition'], evidenceRefs: ['baseline-note'],
  claim: 'sediment condition alleged; uncertainty unresolved'
});
attestation('specification', 'transition_specification', {
  relations: [link('baseline')],
  claim: 'proposed inspection and authorized remediation only if appropriate approvals are obtained'
});
attestation('proposal', 'work_proposal', {
  relations: [link('specification')], claim: 'fictional bounded work proposal'
});
attestation('obligation', 'obligation_admission', {
  relations: [link('proposal')], claim: 'synthetic obligation admission asserted, authority unverified'
});
evidence('action-note', 'FICTIONAL intervention account, not evidence that a drain was cleaned');
attestation('intervention', 'intervention', {
  relations: [link('obligation')], evidenceRefs: ['action-note'],
  claim: 'fictional actor claims an attempted intervention'
});
evidence('follow-up-note', 'FICTIONAL follow-up account, not an independently measured outcome');
attestation('follow-up', 'follow_up_observation', {
  relations: [link('intervention')], evidenceRefs: ['follow-up-note'],
  claim: 'follow-up description, durability and condition unknown'
});
attestation('review', 'judgement', {
  relations: [link('follow-up'), link('baseline')],
  claim: 'unresolved: no independent determination of ecological improvement'
});
attestation('disposition', 'disposition', {
  relations: [link('obligation', 'disposes'), link('review')], effect: 'close',
  claim: 'fictional closure assertion only; authority and admission unverified'
});
attestation('payment', 'payment', {
  relations: [link('intervention')], claim: 'fictional payment claim, no settlement proof'
});

const report = snapshot(entries);
if (hasFailures(report)) {
  console.error('Fixture construction failed offline validation');
  process.exit(1);
}
writeFileSync(output, serializeJournal(entries), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({
  fictional: true,
  head: validateJournal(entries).head,
  entries: entries.length,
  closureAssertions: report.recordedState.closureAssertions.length,
  authority: 'UNKNOWN',
  ecology: 'UNKNOWN',
  settlement: 'UNKNOWN'
}, null, 2));
