import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyBundle, hasFailures } from '../research/offline-v0/verify.mjs';

const original = JSON.parse(readFileSync(
  new URL('../research/offline-v0/fixtures/synthetic.json', import.meta.url), 'utf8'
));

test('deep acyclic attestation lineage does not overflow the JavaScript call stack', () => {
  const b = structuredClone(original);
  const base = b.attestations[0];
  const length = 12000;
  for (let i = 0; i < length; i++) {
    b.attestations.push({
      ...base, localId: 'chain-' + i, evidenceRefs: [],
      relations: i === 0 ? [] : [{
        kind: 'based_on',
        to: { scopeReferent: base.scopeReferent, localId: 'chain-' + (i - 1) }
      }]
    });
  }
  const r = verifyBundle(b);
  assert.equal(hasFailures(r), false);
  assert.equal(r.dimensions.structural.some(x => x.ruleId === 'S016'), false);
});
