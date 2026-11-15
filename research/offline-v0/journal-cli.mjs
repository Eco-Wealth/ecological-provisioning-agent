#!/usr/bin/env node
/**
 * Local research journal CLI. Never sends network requests or signs transactions.
 * Every write takes a cooperative exclusive lock; keep an external head digest
 * to make wholesale journal replacement detectable.
 */
import { readFileSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { hasFailures } from './verify.mjs';
import { appendRecord, canonical, checkHead, createJournal, exportBundle, readJournal,
  serializeJournal, snapshot, validateJournal } from './journal.mjs';

const usage = () => {
  console.error('Usage: node research/offline-v0/journal-cli.mjs init <journal.jsonl> <source>');
  console.error('       node research/offline-v0/journal-cli.mjs add <journal.jsonl> <record.json>');
  console.error('       node research/offline-v0/journal-cli.mjs inspect <journal.jsonl> [asOf-RFC3339]');
  console.error('       node research/offline-v0/journal-cli.mjs export <journal.jsonl> <bundle.json>');
  console.error('       node research/offline-v0/journal-cli.mjs check-head <journal.jsonl> <trusted-head-sha256>');
};

function withLock(path, operation) {
  const lock = path + '.lock';
  const handle = openSync(lock, 'wx', 0o600);
  try { return operation(); }
  finally { closeSync(handle); unlinkSync(lock); }
}

function exclusiveWrite(path, content) {
  const handle = openSync(path, 'wx', 0o600);
  try { writeSync(handle, content); }
  finally { closeSync(handle); }
}

function main(args) {
  const [command, file, arg] = args;
  if (!['init','add','inspect','export','check-head'].includes(command) || !file ||
      (command === 'init' && (!arg || args.length !== 3)) ||
      (command === 'add' && (!arg || args.length !== 3)) ||
      (command === 'inspect' && args.length > 3) ||
      (command === 'export' && (!arg || args.length !== 3)) ||
      (command === 'check-head' && (!arg || args.length !== 3))) {
    usage(); return 2;
  }
  const now = new Date().toISOString();
  if (command === 'init') {
    return withLock(file, () => {
      const entries = createJournal({ source: arg, recordedAt: now });
      exclusiveWrite(file, serializeJournal(entries));
      console.log(JSON.stringify(validateJournal(entries)));
      return 0;
    });
  }
  if (command === 'add') {
    return withLock(file, () => {
      const previous = readJournal(readFileSync(file, 'utf8'));
      const record = JSON.parse(readFileSync(arg, 'utf8'));
      const next = appendRecord(previous, record, now);
      const handle = openSync(file, 'a');
      try { writeSync(handle, canonical(next[next.length - 1]) + '\n'); }
      finally { closeSync(handle); }
      console.log(JSON.stringify(validateJournal(next)));
      return 0;
    });
  }
  const entries = readJournal(readFileSync(file, 'utf8'));
  if (command === 'check-head') {
    console.log(JSON.stringify(checkHead(entries, arg)));
    return 0;
  }
  if (command === 'export') {
    const bundle = exportBundle(entries);
    const report = snapshot(entries);
    if (hasFailures(report)) {
      console.error('Refusing to export an invalid research bundle'); return 1;
    }
    exclusiveWrite(arg, JSON.stringify(bundle, null, 2) + '\n');
    console.log(JSON.stringify(validateJournal(entries)));
    return 0;
  }
  const report = snapshot(entries, arg);
  console.log(JSON.stringify({ journal: validateJournal(entries), report }, null, 2));
  return hasFailures(report) ? 1 : 0;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch (error) {
  console.error('Local journal error: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 2;
}
