#!/usr/bin/env node
/**
 * Two fictional independent publishers, exchanging and contesting records.
 * No field evidence, credentials, network, or authorization.
 */
import { createHash } from 'node:crypto';
import { inspectExchange, MEASUREMENT_FORMAT } from '../measurement.mjs';
import { FORMAT, CONSTITUTION_SHA256, verifyBundle, hasFailures } from '../verify.mjs';
const h = s => createHash('sha256').update(s, 'utf8').digest('hex');
const boundary = 'FICTIONAL bounded drain cell; not an actual location';
const note = 'FICTIONAL measurement note. This was not measured in the field.';
const at = '2026-01-03T00:00:00Z';
const make = (source, head, id, value, role) => ({
  format: FORMAT,
  constitution: { identifier: 'ECOWEALTH-CONSTITUTION-v1', sha256: CONSTITUTION_SHA256 },
  provenance: { source, exportedAt: at, localJournalHead: head },
  referents: [{ id: 'fictional-drain', boundary }],
  evidence: [{ id: 'note', access: 'inline', text: note, sha256: h(note) }],
  attestations: [{
    scopeReferent: 'fictional-drain', localId: id, role,
    actor: source, concerns: ['fictional-drain'], assertedAt: at, effectiveAt: at,
    method: 'fictional-ruler v1', authority: null,
    evidenceRefs: ['note'], relations: [],
    measurement: {
      format: MEASUREMENT_FORMAT,
      observedProperty: 'fictional-sediment-depth',
      featureOfInterest: { referentId: 'fictional-drain', boundarySha256: h(boundary) },
      phenomenonTime: { start: '2026-01-01T10:00:00Z', end: '2026-01-01T10:10:00Z' },
      resultTime: '2026-01-02T00:00:00Z',
      result: { value, unit: 'mm', uncertaintyAbsolute: 0.5 },
      procedure: { id: 'fictional-ruler', version: 'v1' },
      sampling: { description: 'synthetic sample; no field observation', sampleCount: 1 },
      source, evidenceRefs: ['note'],
      limitations: ['No real field observations, calibration, authority or signed timestamp']
    }
  }]
});
const primary = make('fictional-publisher-A', '1'.repeat(64), 'baseline', 12, 'observation');
const challenger = make('fictional-publisher-B', '2'.repeat(64), 'contest', 20, 'follow_up_observation');
challenger.attestations[0].measurement.contests = {
  publisher: primary.provenance.source, journalHead: primary.provenance.localJournalHead,
  scopeReferent: 'fictional-drain', localId: 'baseline'
};
const primaryGraph = verifyBundle(primary), challengerGraph = verifyBundle(challenger);
if (hasFailures(primaryGraph) || hasFailures(challengerGraph)) {
  console.error('Synthetic graph construction unexpectedly failed');
  process.exit(1);
}
const exchange = inspectExchange(primary, challenger);
console.log(JSON.stringify({
  fictional: true, primary, challenger, comparisons: exchange.comparisons,
  authority: 'UNKNOWN', ecology: 'UNKNOWN', causality: 'UNKNOWN',
  disclaimer: 'No independent timestamp, source identity, instrument, field measurement or ecological outcome verified'
}, null, 2));
