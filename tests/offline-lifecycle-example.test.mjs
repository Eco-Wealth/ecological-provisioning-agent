import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exportBundle, readJournal, snapshot } from '../research/offline-v0/journal.mjs';
import { hasFailures } from '../research/offline-v0/verify.mjs';

const example = new URL('../research/offline-v0/examples/fictional-workflow.mjs', import.meta.url).pathname;
const cli = new URL('../research/offline-v0/journal-cli.mjs', import.meta.url).pathname;
const checker = new URL('../research/offline-v0/journal_check.py', import.meta.url).pathname;

test('a third party can build, inspect, export and independently check a complete fictional lifecycle offline', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vealth-example-'));
  const journal = join(directory, 'fictional.jsonl');
  const exported = join(directory, 'bundle.json');
  try {
    const generated = spawnSync(process.execPath, [example, journal], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const result = JSON.parse(generated.stdout);
    assert.equal(result.fictional, true);
    assert.equal(result.authority, 'UNKNOWN');
    assert.equal(result.ecology, 'UNKNOWN');
    const bytes = readFileSync(journal, 'utf8');
    const entries = readJournal(bytes);
    const report = snapshot(entries);
    assert.equal(hasFailures(report), false);
    assert.equal(report.recordedState.closureAssertions.length, 1);
    assert.equal(report.dimensions.ecology.some(x => x.status === 'UNKNOWN'), true);
    assert.equal(report.dimensions.authority.every(x => x.status === 'UNKNOWN'), true);
    const bundle = exportBundle(entries);
    assert.deepEqual(new Set(bundle.attestations.map(x => x.role)),
      new Set(['observation','transition_specification','work_proposal','obligation_admission',
        'intervention','follow_up_observation','judgement','disposition','payment']));
    const checked = spawnSync('python3', [checker, result.head], { encoding: 'utf8', input: bytes });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const exportRun = spawnSync(process.execPath, [cli, 'export', journal, exported], { encoding: 'utf8' });
    assert.equal(exportRun.status, 0, exportRun.stderr);
    assert.equal(JSON.parse(readFileSync(exported)).attestations.length, 9);
    assert.equal(spawnSync(process.execPath, [example, journal]).status, 1,
      'examples must not overwrite existing journals');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
