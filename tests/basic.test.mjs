import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('repo includes core files', () => {
  assert.equal(existsSync('README.md'), true);
  assert.equal(existsSync('schemas/intent.schema.json'), true);
  assert.equal(existsSync('packages/sdk/src/index.ts'), true);
});

test('truth boundary docs mention no certification', () => {
  const text = execFileSync('node', ['-e', "console.log(require('fs').readFileSync('docs/truth-boundaries.md','utf8').includes('certification'))"], { encoding: 'utf8' }).trim();
  assert.equal(text, 'true');
});
