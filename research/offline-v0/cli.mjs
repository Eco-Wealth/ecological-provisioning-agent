#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { hasFailures, verifyBundle } from './verify.mjs';

if (process.argv.length < 3 || process.argv.length > 4) {
  console.error('Usage: node research/offline-v0/cli.mjs <synthetic-bundle.json> [asOf-RFC3339]');
  process.exit(2);
}
try {
  const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const report = verifyBundle(data, { asOf: process.argv[3] });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = hasFailures(report) ? 1 : 0;
} catch (error) {
  console.error('Input error: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
}
