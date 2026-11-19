// Local, locked, crash-recoverable archival of old and fully settled journal prefixes.
// Never send network requests, sign, interpret profit, or erase a journal without a verified archived copy.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const ARCHIVE_MIN_AGE_MS = 48 * 3600_000;
export const ARCHIVE_TRIGGER_BYTES = 8 * 1024 * 1024;
export const ARCHIVE_MAX_ACTIVE_BYTES = 64 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const HEX = /^[0-9a-f]{64}$/;
const refuse = (reason) => { throw new Error("journal archive refused: " + reason); };
const archiveName = (sha) => "ledger-" + sha + ".jsonl";

function writeDurable(file, bytes) {
  if (process.platform === "win32") refuse("POSIX directory fsync is required");
  const tmp = file + "." + randomBytes(12).toString("hex") + ".tmp";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}
function syncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readState(home) {
  const file = path.join(home, "state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!state || typeof state !== "object" || Array.isArray(state) ||
      (state.schemaVersion !== undefined && state.schemaVersion !== 1)) refuse("unknown state schema");
  return state;
}
function privateDirectory(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) ||
      (typeof process.getuid === "function" && st.uid !== process.getuid()))
    refuse("archive directory must be private, real, and owned by the bot user");
}
function safeArchiveFile(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
      (typeof process.getuid === "function" && st.uid !== process.getuid()))
    refuse("archive file is not an owner-held regular file");
}
function safelyRead(file) {
  if (!fs.existsSync(file)) refuse("expected ledger or archive file is missing");
  safeArchiveFile(file);
  if (fs.statSync(file).size > ARCHIVE_MAX_ACTIVE_BYTES) refuse("file exceeds bounded archive reader");
  return fs.readFileSync(file);
}

/** Return only a COMPLETE, finalized, >=48-hour-old prefix. Unknown or interleaved rows stay active. */
export function planArchivePrefix(bytes, now, ageMs = ARCHIVE_MIN_AGE_MS) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(now) || ageMs < ARCHIVE_MIN_AGE_MS)
    refuse("invalid archive plan inputs");
  if (!bytes.length || bytes[bytes.length - 1] !== 10) return { archiveBytes: 0, tailBytes: bytes.length };
  const events = []; let from = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 10) continue;
    const raw = bytes.subarray(from, i);
    if (!raw.length) return { archiveBytes: 0, tailBytes: bytes.length };
    const line = raw.toString("utf8");
    if (!Buffer.from(line, "utf8").equals(raw)) refuse("invalid UTF-8 bytes in journal archive candidate");
    let row;
    try { row = JSON.parse(line); } catch { refuse("corrupt JSON in archive planner"); }
    events.push({ row, end: i + 1 });
    from = i + 1;
  }
  const last = new Map();
  events.forEach((e, i) => { if (typeof e.row.id === "string") last.set(e.row.id, i); });
  let at = 0, cut = 0;
  while (at < events.length) {
    const id = events[at].row.id;
    if (events[at].row.phase !== "reserved" || typeof id !== "string") break;
    let next = at + 1;
    while (next < events.length && events[next].row.id === id) next++;
    if (last.get(id) !== next - 1) break;
    const group = events.slice(at, next);
    const stages = group.map((e) => e.row.phase).join(",");
    if (!["reserved,broadcast,receipt", "reserved,broadcast,reconciled", "reserved,reconciled"].includes(stages)) break;
    const terminal = group[group.length - 1].row;
    if (terminal.status !== "success" && terminal.status !== "reverted") break;
    if (group.some((e) => e.row.leg !== group[0].row.leg ||
        e.row.chain !== group[0].row.chain || e.row.name !== group[0].row.name)) break;
    const allOld = events.slice(at, next).every((e) => {
      const t = Date.parse(e.row.at);
      return Number.isFinite(t) && t <= now - ageMs;
    });
    if (!allOld) break;
    cut = events[next - 1].end;
    at = next;
  }
  return { archiveBytes: cut, tailBytes: bytes.length - cut };
}
function ensureArchiveFolder(home) {
  const dir = path.join(home, "archives");
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { mode: 0o700 }); syncDir(home); }
  privateDirectory(dir);
  return dir;
}
function checkMarker(marker) {
  if (!marker || typeof marker !== "object" ||
      !HEX.test(marker.sourceSha ?? "") || !HEX.test(marker.prefixSha ?? "") ||
      !HEX.test(marker.tailSha ?? "") || !Number.isSafeInteger(marker.archiveBytes) ||
      marker.archiveBytes <= 0 || !Number.isSafeInteger(marker.tailBytes) || marker.tailBytes < 0 ||
      typeof marker.createdAt !== "string" || !Number.isFinite(Date.parse(marker.createdAt)) ||
      marker.file !== archiveName(marker.prefixSha)) refuse("invalid interrupted archive marker");
}
function finishArchive(home, state) {
  const marker = state.compaction;
  checkMarker(marker);
  if (state.pending) refuse("pending transaction during archival");
  const active = path.join(home, "ledger.jsonl");
  const folder = ensureArchiveFolder(home);
  const archive = path.join(folder, marker.file);
  const bytes = safelyRead(active), sha = digest(bytes);
  const original = sha === marker.sourceSha && bytes.length === marker.archiveBytes + marker.tailBytes;
  const trimmed = sha === marker.tailSha && bytes.length === marker.tailBytes;
  if (!original && !trimmed) refuse("journal changed during interrupted compaction; no bytes were discarded");
  if (!fs.existsSync(archive)) {
    if (!original) refuse("archived segment missing after journal rotation; restoring requires verified backup");
    const fd = fs.openSync(archive, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes.subarray(0, marker.archiveBytes)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    syncDir(folder);
  }
  const archived = safelyRead(archive);
  if (archived.length !== marker.archiveBytes || digest(archived) !== marker.prefixSha)
    refuse("archived prefix is incomplete or corrupt");
  if (original) {
    const suffix = bytes.subarray(marker.archiveBytes);
    if (digest(suffix) !== marker.tailSha || suffix.length !== marker.tailBytes)
      refuse("the remaining journal does not match the checkpoint");
    writeDurable(active, suffix);
  }
  const current = readState(home);
  if (JSON.stringify(current.compaction) !== JSON.stringify(marker))
    refuse("interrupted compaction marker changed while restoring");
  const previous = current.archiveHead ?? "GENESIS";
  const root = digest(Buffer.from(previous + "\n" + marker.prefixSha + "\n" + marker.archiveBytes + "\n" + marker.createdAt));
  const entry = { file: marker.file, sha256: marker.prefixSha, bytes: marker.archiveBytes, at: marker.createdAt, head: root };
  const next = { ...current, archiveHead: root, archives: [...(current.archives ?? []), entry] };
  delete next.compaction;
  writeDurable(path.join(home, "state.json"), Buffer.from(JSON.stringify(next, null, 2)));
  return { archived: true, bytes: marker.archiveBytes, activeBytes: marker.tailBytes, archiveHead: root };
}
/**
 * Only call with the exclusive bot-home lock acquired.
 * An interrupted operation is replayable by exact source/tail hashes; anything else refuses.
 */
export function archiveJournal(home, { now = Date.now(), validateActive = null, locked = false, recoveryOnly = false, force = false } = {}) {
  if (!locked) refuse("an exclusive bot-home lock is required");
  privateDirectory(home);
  if (!fs.existsSync(path.join(home, "state.json"))) {
    if (recoveryOnly) return { archived: false, reason: "no journal state to recover" };
    refuse("journal state is missing; archival requires an existing verified bot");
  }
  const state = readState(home);
  if (state.compaction) {
    const recovered = finishArchive(home, state);
    if (recoveryOnly) verifyArchiveInventory(home);
    return recovered;
  }
  // Validate the full archive byte hashes ONCE at process startup, rather
  // than assuming matching filenames and sizes mean the bytes are intact.
  if (recoveryOnly) {
    verifyArchiveInventory(home);
    return { archived: false, reason: "verified archive inventory, no interrupted rotation" };
  }
  verifyArchiveManifest(home);
  if (state.pending) refuse("cannot archive with any pending transaction");
  if (typeof validateActive !== "function") refuse("full live-journal validation is required before archiving");
  validateActive();
  const file = path.join(home, "ledger.jsonl");
  if (!fs.existsSync(file)) return { archived: false, reason: "no active ledger" };
  const buffer = safelyRead(file);
  if (!force && buffer.length < ARCHIVE_TRIGGER_BYTES)
    return { archived: false, reason: "journal is below rotation threshold" };
  const { archiveBytes, tailBytes } = planArchivePrefix(buffer, now);
  if (!archiveBytes) return { archived: false, reason: "no complete old prefix is safe to archive" };
  const prefix = buffer.subarray(0, archiveBytes);
  const marker = {
    sourceSha: digest(buffer), prefixSha: digest(prefix), tailSha: digest(buffer.subarray(archiveBytes)),
    archiveBytes, tailBytes, file: archiveName(digest(prefix)), createdAt: new Date(now).toISOString(),
  };
  const marked = { ...state, compaction: marker };
  writeDurable(path.join(home, "state.json"), Buffer.from(JSON.stringify(marked, null, 2)));
  return finishArchive(home, marked);
}
/** Cheap startup validation: validate archived segment names, sizes and the ordered hash commitments. */
export function verifyArchiveManifest(home) {
  const state = readState(home);
  if (state.compaction) refuse("archive rotation must be recovered first");
  if (!Array.isArray(state.archives ?? [])) refuse("invalid archive manifest");
  let root = "GENESIS", checked = 0, bytes = 0;
  for (const entry of state.archives ?? []) {
    if (!entry || !HEX.test(entry.sha256 ?? "") || entry.file !== archiveName(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0 || typeof entry.at !== "string")
      refuse("invalid archive manifest entry");
    const file = path.join(home, "archives", entry.file);
    if (!fs.existsSync(file)) refuse("an archived journal segment is missing");
    safeArchiveFile(file);
    if (fs.statSync(file).size !== entry.bytes) refuse("archived journal segment size changed");
    root = digest(Buffer.from(root + "\n" + entry.sha256 + "\n" + entry.bytes + "\n" + entry.at));
    if (root !== entry.head) refuse("archive commitment chain mismatch");
    bytes += entry.bytes; checked++;
  }
  if (root !== (state.archiveHead ?? "GENESIS")) refuse("state archive head differs from manifest");
  return { segments: checked, archivedBytes: bytes, root };
}

/** Expensive independent evidence pass; never used on each transaction. */
export function verifyArchiveInventory(home) {
  const state = readState(home);
  if (state.compaction) refuse("archive rotation must be recovered first");
  let root = "GENESIS", checked = 0, bytes = 0;
  for (const entry of state.archives ?? []) {
    if (!entry || !HEX.test(entry.sha256 ?? "") || entry.file !== archiveName(entry.sha256) ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) refuse("invalid archive manifest entry");
    const file = path.join(home, "archives", entry.file);
    const data = safelyRead(file);
    if (data.length !== entry.bytes || digest(data) !== entry.sha256) refuse("archive inventory hash mismatch");
    root = digest(Buffer.from(root + "\n" + entry.sha256 + "\n" + entry.bytes + "\n" + entry.at));
    if (root !== entry.head) refuse("archive commitment chain mismatch");
    bytes += data.length; checked++;
  }
  if (root !== (state.archiveHead ?? "GENESIS")) refuse("state archive head differs from verified archive chain");
  return { segments: checked, archivedBytes: bytes, root };
}
