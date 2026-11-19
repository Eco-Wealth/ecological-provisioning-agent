import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { archiveJournal, planArchivePrefix, verifyArchiveInventory } from "./journal-archive.mjs";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const OLD = "2026-11-15T12:00:00.000Z";
const NEW = "2026-11-20T11:00:00.000Z";
const tx = (id, at) => [
  { schemaVersion: 1, id, at, phase: "reserved", leg: "eco", chain: "base", name: "buy",
    hash: null, valueWei: "100", feeBoundWei: "10", kvcmUnits: "0", usdcUnits: "0" },
  { schemaVersion: 1, id, at, phase: "broadcast", leg: "eco", chain: "base", name: "buy",
    hash: "0x" + "ab".repeat(32), valueWei: "0", feeBoundWei: "0", kvcmUnits: "0", usdcUnits: "0" },
  { schemaVersion: 1, id, at, phase: "receipt", leg: "eco", chain: "base", name: "buy",
    hash: "0x" + "ab".repeat(32), status: "success", valueWei: "0", feeBoundWei: "0", kvcmUnits: "0", usdcUnits: "0" },
];
const stringify = (events) => Buffer.from(events.map((row) => JSON.stringify(row)).join("\n") + "\n");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function home(t, history) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "protocol-archive-"));
  fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ walletAddress: "0xOwner", ledgerExpected: true, schemaVersion: 1 }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "ledger.jsonl"), stringify(history), { mode: 0o600 });
  return dir;
}
const run = (dir, options = {}) => archiveJournal(dir, { locked: true, force: true, now: NOW, validateActive: () => {}, ...options });

test("plans only a complete old contiguous transaction prefix and preserves recent spending", () => {
  const older = tx("aa".repeat(16), OLD);
  const recent = tx("bb".repeat(16), NEW);
  const bytes = stringify([...older, ...recent]);
  const planned = planArchivePrefix(bytes, NOW);
  assert.equal(planned.archiveBytes, stringify(older).length);
  assert.equal(planned.tailBytes, stringify(recent).length);
  assert.equal(planArchivePrefix(stringify(recent), NOW).archiveBytes, 0);
  assert.equal(planArchivePrefix(bytes.subarray(0, bytes.length - 1), NOW).archiveBytes, 0,
    "no destructive plan if the append-only journal ends in a partial record");
  assert.throws(() => planArchivePrefix(bytes, NOW, 0), /invalid archive plan inputs/);
});

test("archive persists exact bytes, creates chained manifest and leaves recent journal untouched", (t) => {
  const older = tx("aa".repeat(16), OLD), recent = tx("bb".repeat(16), NEW);
  const dir = home(t, [...older, ...recent]);
  const result = run(dir);
  assert.equal(result.archived, true);
  assert.equal(result.bytes, stringify(older).length);
  assert.deepEqual(fs.readFileSync(path.join(dir, "ledger.jsonl")), stringify(recent));
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.compaction, undefined);
  assert.equal(state.archives.length, 1);
  const entry = state.archives[0];
  assert.equal(entry.sha256, sha(stringify(older)));
  assert.deepEqual(fs.readFileSync(path.join(dir, "archives", entry.file)), stringify(older));
  assert.deepEqual(verifyArchiveInventory(dir), { segments: 1, archivedBytes: result.bytes, root: result.archiveHead });
  assert.equal(run(dir).archived, false, "a recent journal is not compacted again");
});

test("a transaction with no receipt yet, or a missing exclusive lock, is not archived", (t) => {
  const id = "cc".repeat(16), dir = home(t, tx(id, OLD).slice(0, 2));
  assert.throws(() => archiveJournal(dir, { locked: false, force: true }), /exclusive bot-home lock/);
  const result = run(dir);
  assert.equal(result.archived, false);
  assert.equal(fs.existsSync(path.join(dir, "archives")), false);
});

test("after a crash following archive creation but before ledger rename, recovery finishes safely", (t) => {
  const old = tx("aa".repeat(16), OLD), recent = tx("bb".repeat(16), NEW);
  const dir = home(t, [...old, ...recent]);
  const original = fs.renameSync;
  fs.renameSync = (src, dst) => {
    if (dst === path.join(dir, "ledger.jsonl")) throw new Error("simulated power outage");
    return original(src, dst);
  };
  try { assert.throws(() => run(dir), /simulated power outage/); }
  finally { fs.renameSync = original; }
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).compaction);
  assert.throws(() => verifyArchiveInventory(dir), /rotation must be recovered/);
  assert.equal(run(dir, { recoveryOnly: true }).archived, true);
  assert.deepEqual(fs.readFileSync(path.join(dir, "ledger.jsonl")), stringify(recent));
  assert.equal(verifyArchiveInventory(dir).segments, 1);
  assert.equal(run(dir, { recoveryOnly: true }).archived, false);
});

test("after power loss following ledger rename but before final state, recovery completes the archive record and clears the marker", (t) => {
  const old = tx("aa".repeat(16), OLD), recent = tx("bb".repeat(16), NEW);
  const dir = home(t, [...old, ...recent]);
  const original = fs.renameSync; let stateSaves = 0;
  fs.renameSync = (src, dst) => {
    if (dst === path.join(dir, "state.json") && ++stateSaves === 2)
      throw new Error("state finalization lost");
    return original(src, dst);
  };
  try { assert.throws(() => run(dir), /state finalization lost/); }
  finally { fs.renameSync = original; }
  assert.deepEqual(fs.readFileSync(path.join(dir, "ledger.jsonl")), stringify(recent));
  assert.equal(run(dir, { recoveryOnly: true }).archived, true);
  assert.equal(verifyArchiveInventory(dir).segments, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).compaction, undefined);
});

test("a corrupt or deleted archive never silently resets a rotated ledger", (t) => {
  const dir = home(t, [...tx("aa".repeat(16), OLD), ...tx("bb".repeat(16), NEW)]);
  run(dir);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const archive = path.join(dir, "archives", state.archives[0].file);
  fs.appendFileSync(archive, "CORRUPTED");
  assert.throws(() => verifyArchiveInventory(dir), /archive inventory hash mismatch/);
  fs.rmSync(archive);
  assert.throws(() => verifyArchiveInventory(dir), /expected ledger or archive file is missing/);
});

test("two rotations build a verifiable ordered hash chain without double-archiving", (t) => {
  const first = tx("aa".repeat(16), OLD), second = tx("bb".repeat(16), NEW);
  const dir = home(t, [...first, ...second]);
  const a = run(dir);
  const b = run(dir, { now: NOW + 10 * 86_400_000 });
  assert.equal(a.archived, true);
  assert.equal(b.archived, true);
  assert.notEqual(a.archiveHead, b.archiveHead);
  assert.equal(fs.readFileSync(path.join(dir, "ledger.jsonl")).length, 0);
  assert.deepEqual(verifyArchiveInventory(dir), {
    segments: 2,
    archivedBytes: stringify(first).length + stringify(second).length,
    root: b.archiveHead,
  });
  assert.equal(run(dir, { recoveryOnly: true }).archived, false);
});

test("startup detects same-size archive tampering, not just removed or truncated files", (t) => {
  const dir = home(t, [...tx("aa".repeat(16), OLD), ...tx("bb".repeat(16), NEW)]);
  run(dir);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const file = path.join(dir, "archives", state.archives[0].file);
  const bytes = fs.readFileSync(file);
  bytes[10] = bytes[10] === 65 ? 66 : 65;
  fs.writeFileSync(file, bytes);
  assert.throws(() => run(dir, { recoveryOnly: true }), /archive inventory hash mismatch/);
});

test("old data whose identifier is referenced later cannot be cut away", () => {
  const id = "aa".repeat(16);
  const original = tx(id, OLD);
  const late = { ...original[2], phase: "reconciled", at: NEW };
  const data = stringify([...original, ...tx("bb".repeat(16), NEW), late]);
  assert.equal(planArchivePrefix(data, NOW).archiveBytes, 0);
});

test("invalid UTF-8 does not create inaccurate byte offsets and cannot be archived", () => {
  const raw = stringify(tx("aa".repeat(16), OLD));
  const corrupted = Buffer.concat([raw.subarray(0, 15), Buffer.from([0xff]), raw.subarray(15)]);
  assert.throws(() => planArchivePrefix(corrupted, NOW), /invalid UTF-8/);
});

test("unverified completion or changed transaction leg is never treated as safely archived", () => {
  const noProof = tx("aa".repeat(16), OLD);
  delete noProof[2].status;
  assert.equal(planArchivePrefix(stringify(noProof), NOW).archiveBytes, 0);
  const changed = tx("bb".repeat(16), OLD);
  changed[1].leg = "gmx";
  assert.equal(planArchivePrefix(stringify(changed), NOW).archiveBytes, 0);
});

test("a row is archived only once it is at least 48 hours old, to the millisecond", () => {
  const id = "aa".repeat(16), hour = 3_600_000;
  const edge = tx(id, new Date(NOW - 48 * hour).toISOString());
  const justUnder = tx(id, new Date(NOW - 48 * hour + 1).toISOString());
  const nearly = tx(id, new Date(NOW - (47 * 60 + 59) * 60_000).toISOString());
  assert.equal(planArchivePrefix(stringify(edge), NOW).archiveBytes, stringify(edge).length);
  assert.equal(planArchivePrefix(stringify(justUnder), NOW).archiveBytes, 0);
  assert.equal(planArchivePrefix(stringify(nearly), NOW).archiveBytes, 0);
});

test("a pending send refuses archival, on a fresh pass and on a recovery, and the ledger is untouched", (t) => {
  const withPending = (dir) => {
    const file = path.join(dir, "state.json");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...state, pending: { hash: "0x" + "ab".repeat(32) } }), { mode: 0o600 });
  };
  const fresh = home(t, [...tx("aa".repeat(16), OLD), ...tx("bb".repeat(16), NEW)]);
  const freshBefore = fs.readFileSync(path.join(fresh, "ledger.jsonl"));
  withPending(fresh);
  assert.throws(() => run(fresh), /cannot archive with any pending transaction/);
  assert.deepEqual(fs.readFileSync(path.join(fresh, "ledger.jsonl")), freshBefore);
  assert.equal(fs.existsSync(path.join(fresh, "archives")), false);

  const interrupted = home(t, [...tx("aa".repeat(16), OLD), ...tx("bb".repeat(16), NEW)]);
  const interruptedBefore = fs.readFileSync(path.join(interrupted, "ledger.jsonl"));
  const original = fs.renameSync;
  fs.renameSync = (src, dst) => {
    if (dst === path.join(interrupted, "ledger.jsonl")) throw new Error("simulated power outage");
    return original(src, dst);
  };
  try { assert.throws(() => run(interrupted), /simulated power outage/); }
  finally { fs.renameSync = original; }
  withPending(interrupted);
  assert.throws(() => run(interrupted), /pending transaction during archival/);
  assert.deepEqual(fs.readFileSync(path.join(interrupted, "ledger.jsonl")), interruptedBefore);
});

test("the live journal must pass its full check before anything is archived, and a failed check archives nothing", (t) => {
  const dir = home(t, [...tx("aa".repeat(16), OLD), ...tx("bb".repeat(16), NEW)]);
  const before = fs.readFileSync(path.join(dir, "ledger.jsonl"));
  assert.throws(() => run(dir, { validateActive: () => { throw new Error("journal check failed"); } }), /journal check failed/);
  assert.throws(() => run(dir, { validateActive: null }), /full live-journal validation is required/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "ledger.jsonl")), before);
  assert.equal(fs.existsSync(path.join(dir, "archives")), false);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(state.compaction, undefined);
  assert.equal(state.archives, undefined);
});

test("a same-length corrupt archive found during recovery refuses, and the full ledger is not trimmed", (t) => {
  const old = tx("aa".repeat(16), OLD), recent = tx("bb".repeat(16), NEW);
  const dir = home(t, [...old, ...recent]);
  const original = fs.renameSync;
  fs.renameSync = (src, dst) => {
    if (dst === path.join(dir, "ledger.jsonl")) throw new Error("simulated power outage");
    return original(src, dst);
  };
  try { assert.throws(() => run(dir), /simulated power outage/); }
  finally { fs.renameSync = original; }
  const marker = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")).compaction;
  const archive = path.join(dir, "archives", marker.file);
  const bytes = fs.readFileSync(archive);
  bytes[10] = bytes[10] === 65 ? 66 : 65;
  fs.writeFileSync(archive, bytes);
  assert.throws(() => run(dir), /archived prefix is incomplete or corrupt/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "ledger.jsonl")), stringify([...old, ...recent]), "the full ledger was not trimmed");
});
