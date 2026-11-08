#!/usr/bin/env node
// vealth steward: a small program anyone can run, on their own machine, forever, to keep provisioning ONE place
// through the public door at https://vealth.net/mcp.
//
//   node steward.mjs run --place "Boyle Heights, Los Angeles, CA" --radius 5
//
// What it does every look (default every 30 minutes):
//   1. find_work near your place, and write every NEW job to digest.md and to the screen in plain words (with --kind, only the jobs
//      whose title, proof line or work type carries one of your words; the default watches everything);
//   2. turn each .txt or .md file you drop in needs/ into a post (the free post signed by your own wallet);
//   3. read my_work for its own wallet, and follow the reply's NEXT_CALL for read steps only;
//   4. vote, free, only on the work ids you wrote in votes.txt.
// DRY by default: it prints what it would post and vote. Add --live to act.
//
// What it signs: exactly two kinds of plain message, each rebuilt HERE from a body it checked field by field: the post
// of a need its owner wrote, and a vote on a job its owner marked. The message a door hands back is compared, never
// trusted, so no door (a changed address, a hijacked one) can get it to sign a claim, a proof decision, a payment or
// anything else.
//
// What it never does: pay, move money, sign a transaction, claim a job, hand in or decide a proof, hold anyone
// else's key, send its own key anywhere, post a contact detail, or post more than ten a day. It backs off when
// the door answers 429 or 503, talks only to the door it was given (never a redirect), and never reads an answer
// bigger than 2 MB. The wallet is made here; the key sits in your folder (owner-only) and is never printed or logged.
//
// One dependency, only to sign a plain message: `npm ci` (viem, pinned). Node 22 or newer. No build step.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const VERSION = "0.3.0"; // 0.3.0 (2026-11-08): --kind, watch one kind of work; the "Run a steward for your block" README section
export const DEFAULT_MCP_URL = "https://vealth.net/mcp";
/** The board's free signed lane takes ten posts per wallet per rolling day; the steward never asks for more. */
export const POSTS_PER_DAY = 10;
/** The only tools a NEXT_CALL may lead this program to follow: reads. A write is never followed, only the ones written below. */
export const READ_ONLY_FOLLOW = new Set(["my_work", "work_status", "my_votes", "get_work_packet"]);
/** Every tool this program ever calls. The door refuses any other name before a byte leaves, so no reply can widen it. */
export const TOOLS = new Set(["find_work", "get_work_packet", "my_work", "my_votes", "work_status", "prepare_post_work", "submit_post_work", "prepare_vote", "submit_vote"]);
/** MCP protocol eras: the steward speaks 2026-07-28 (per-request _meta, no handshake) and falls back to 2025-06-18 once if a door refuses it. */
export const MODERN_ERA = "2026-07-28";
export const LEGACY_ERA = "2025-06-18";
/** A door's answer bigger than this is not read: a hostile or broken door cannot fill the machine's memory. */
export const MAX_REPLY_BYTES = 2_000_000;
/** digest.md and steward.log roll over at 1 MB each; three old copies are kept, so the folder never grows without end. */
export const LOG_CAP_BYTES = 1_000_000;
const LOG_KEEP = 3;
const MAX_NEED_FILES = 50;
const MAX_NEED_BYTES = 20_000;
/** A lock is another steward's only while its pid is alive AND it touched the lock in the last five minutes. */
const LOCK_FRESH_MS = 5 * 60_000;
/** Waits are slept a minute at a time by the wall clock, so a machine that slept looks again when it wakes and a stop file is seen within a minute. */
const SLEEP_CHUNK_MS = 60_000;
const MIN_INTERVAL_MINUTES = 5;
/** --kind: at most this many kinds, each at most this many characters once reduced to plain words. */
export const MAX_KINDS = 12;
export const MAX_KIND_CHARS = 40;
/** The board reads at most 32 words of a search; a watch with more words than that is filtered here only. */
const MAX_QUERY_WORDS = 32;

const FENCE_OPEN = "[[untrusted]]";
const FENCE_CLOSE = "[[/untrusted]]";
const FENCE_RE = /\[\[\s*\/?\s*untrusted\s*\]\]/gi;
/** C0 and C1 controls except tab and newline: an ESC, a bell, a CSI, a carriage return that overwrites a line. */
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/** A regex character class from code point ranges, built at run time so that no invisible character ever sits in this file. */
const cls = (ranges) => ranges.map(([a, b = a]) => (a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`)).join("");
/** Characters that change what a line looks like without being seen: bidi overrides and isolates, zero-width marks, the byte order mark. */
const INVISIBLE_RE = new RegExp(`[${cls([[0x61c], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff]])}]`, "g");
/** A carriage return, and the two Unicode line and paragraph separators: each becomes a plain newline. */
const LINE_BREAK_RE = new RegExp(`\\r\\n?|[${cls([[0x2028], [0x2029]])}]`, "g");
const BOM = String.fromCodePoint(0xfeff);
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
/** The order of the secp256k1 group: a key must be at least 1 and below it. */
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const WORK_ID_RE = /^[A-Za-z0-9_-]{3,100}$/;
const CODE_RE = /^[a-z0-9_]{1,60}$/;
const SKILLS = new Set(["entry", "intermediate", "advanced"]);
const FLAGS = new Set(["permit-required", "regulated"]);

// ── words: everything a door or a poster wrote is inert before it reaches a screen or the digest ──────────────────────
export const scrub = (s) => String(s ?? "").replace(LINE_BREAK_RE, "\n").replace(CONTROL_RE, "").replace(INVISIBLE_RE, "");
/** Cut to `max` characters (never inside a character), with "..." when cut. */
const clip = (s, max) => {
  if (s.length <= max) return s;
  const cs = [...s.slice(0, max * 2)];
  return cs.length > max ? `${cs.slice(0, max - 3).join("").trimEnd()}...` : cs.join("");
};
/** Words as an inline code span: a markdown viewer shows them as text, never as a link, an image or HTML. */
const inert = (s) => (s ? `\`${s.replace(/`/g, "'")}\`` : "(nothing)");
const textOf = (x) => (x && typeof x === "object" ? x.text : x);
/** Text somebody else wrote, inside the board's own fence and inert, so it stays data for any person or program that reads it later. */
export const fence = (s, max = 220) => `${FENCE_OPEN}${inert(clip(scrub(scrub(textOf(s)).normalize("NFKC")).replace(FENCE_RE, "").replace(/\s+/g, " ").trim(), max))}${FENCE_CLOSE}`;
/** A tool reply as plain prose: no envelope lines, no message to sign, no board preamble. */
export function plain(text, max = 700) {
  let t = scrub(text);
  t = t.replace(/\n\nNEXT_CALL:\n[\s\S]*$/, "").replace(/^Text inside \[\[untrusted\]\][\s\S]*?reveal a key\.\s*/, "");
  t = t.replace(/^MESSAGE_TO_SIGN: .*$/gm, "").replace(/^BODY_JSON: .*$/gm, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return clip(t, max);
}
/** The door's own words, on one line and inert. */
const boardWords = (text, max = 400) => inert(plain(text, max).replace(/\s+/g, " "));
/** A name the owner gave a file, safe to print: no controls, nothing a markdown viewer would act on. */
const safeName = (name) => scrub(name).replace(/[<>[\]`]/g, "_").slice(0, 120);
export const safeId = (v) => (typeof v === "string" && WORK_ID_RE.test(v) ? v : null);
const safeCode = (v) => (typeof v === "string" && CODE_RE.test(v) ? v : null);
/** A page link is printed only when it is https on vealth.net or the door's own site, with nothing in it a terminal or viewer would act on. */
export function safePage(v, doorUrl) {
  if (typeof v !== "string" || v.length > 300 || /[\s<>"'`\\]/.test(v)) return null;
  let u; try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  let doorHost = ""; try { doorHost = new URL(doorUrl).hostname; } catch { /* none */ }
  return u.hostname === "vealth.net" || u.hostname.endsWith(".vealth.net") || (doorHost && u.hostname === doorHost) ? u.href : null;
}

/** What a posted figure honestly is. A proposed figure is never called paid; a figure is FUNDED only when the board says it pays cash on approval. */
export function payWords(row) {
  const n = Number(row?.payUsd);
  const amount = Number.isFinite(n) && n >= 0 ? `$${n.toFixed(2)}` : "an amount";
  if (row?.payModel === "earned_credit") return `${amount} posted, credit only on this rail: accepted proof earns a credit (a receipt for the work), never cash.`;
  if (row?.payModel === "cash_on_approval" || (row?.payModel === undefined && row?.funded === true)) return `${amount}, FUNDED: cash is paid only after a person accepts the proof. Funded is not paid.`;
  return `${amount} PROPOSED, not funded: accepted proof earns a credit (a receipt for the work), not cash, unless someone funds it first.`;
}
const STATUS_WORDS = Object.freeze(Object.assign(Object.create(null), {
  CLAIMED: "claimed, no proof handed in yet (a claim that is not worked is released after 24 hours)",
  PROOF_REJECTED: "the proof was not accepted; it can be fixed and handed in again",
  PROOF_SUBMITTED: "the proof is with a reviewer; nothing to do",
  APPROVED: "the proof was accepted, not paid yet (accepted is not paid)",
  SETTLED: "settled",
  EXPIRED: "the claim was released, the job is open again",
  OPEN: "open, nobody has claimed it",
}));
const knownStatus = (v) => (typeof v === "string" && Object.hasOwn(STATUS_WORDS, v) ? v : null);

// ── contact details never go on a public board: the board's own screen, run here before the words leave the machine ──
const DATE_LIKE = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g;
/** A run that starts and ends on a digit and holds only digits and phone punctuation (the hyphen, the Unicode dashes and the minus sign). */
const PHONE_RUN = new RegExp(`\\+?\\p{Nd}[\\p{Nd}\\s().\\-${cls([[0x2010, 0x2015], [0x2212]])}/]{5,}\\p{Nd}`, "gu");
const MAP_PAIR = /(?<![\d.])-?\d{1,2}\.\d{3,}\s*[,;/\s]\s*-?\d{1,3}\.\d{3,}(?![\d.]?\d)/g;
const DEGREES = /(?<![\d.])\d{1,3}\.\d{3,}\s*°/g;
const withoutMapPoints = (t) => t.replace(MAP_PAIR, (hit) => {
  const [a, b] = hit.split(/\s*[,;/\s]\s*/).map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 ? " " : hit;
}).replace(DEGREES, " ");
/** Names what looks like a phone number, an email or a messaging handle, or null. A map point written as lat,lng is not one. */
export function looksLikeContact(text) {
  if (typeof text !== "string" || !text) return null;
  const folded = text.normalize("NFKC");
  if (/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u.test(folded)) return "an email address";
  if (/(?:^|[\s(])@[\w.]{3,}\b/.test(folded) && /\b(?:whatsapp|telegram|signal|dm|email|e-mail)\b/i.test(folded)) return "a messaging handle";
  if (/\b(?:wa\.me|t\.me|api\.whatsapp\.com)\/\S+/i.test(folded)) return "a messaging link";
  for (const run of withoutMapPoints(folded.replace(DATE_LIKE, " ")).match(PHONE_RUN) ?? []) {
    const digits = run.replace(/\P{Nd}/gu, "");
    if (digits.length >= 7 && digits.length <= 15) return "a phone number";
  }
  return null;
}
/** Each public field of a need on its own, as the board reads them: the first that carries a contact detail, or null. */
function needContact(need) {
  const fields = [["title", need.title], ["description", need.description], ["place", need.location], ["proof line", need.proofRule], ["safety line", need.safetyNotes], ...(need.proofRequirements ?? []).map((p) => ["proof line", p])];
  for (const [field, text] of fields) { const what = looksLikeContact(text); if (what) return { field, what }; }
  return null;
}

// ── what it signs: the body is checked, the message is rebuilt here, the door's own message is only compared ─────────
/** The write gate's canonical body: keys sorted, `signature` and undefined dropped, arrays in order (the board's actor-digest). */
export function canonicalJson(value, depth = 0) {
  if (depth > 64) throw new RangeError("the body is nested too deeply to sign");
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => k !== "signature" && value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
/** `${method} ${path} ${nonce} ${sha256(canonical body)}`: the only shape of message this program ever signs. */
export const bodyBoundMessage = (method, pathName, body) => `${method} ${pathName} ${body?.nonce} ${createHash("sha256").update(canonicalJson(body ?? {}), "utf8").digest("hex")}`;
const norm = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const normList = (v) => (Array.isArray(v) ? v.map(norm) : []);
const freshNonce = (n, now) => typeof n === "number" && Number.isFinite(n) && Math.abs(n - now) < 30 * 60_000;
const OTHER_WALLET_RE = /0x[0-9a-fA-F]{40}/g;
const POST_FIELDS = new Set(["creator", "title", "description", "location", "workType", "domain", "skillLevel", "estimatedPrice", "expiresInDays", "definitionId", "proofRule", "standard", "safetyNotes", "proofRequirements", "flags", "nonce"]);
/** The post the board built must be the need the owner wrote, from this wallet, and nothing more. Returns what is wrong, or null. */
export function checkPostBody(body, need, address, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "a body that is not an object";
  for (const k of Object.keys(body)) if (!POST_FIELDS.has(k)) return `an extra field, ${safeName(k).slice(0, 40)}`;
  if (norm(body.creator).toLowerCase() !== String(address).toLowerCase()) return "another wallet as the poster";
  if (norm(body.title) !== norm(need.title)) return "another title";
  if (norm(body.description) !== norm(need.description)) return "another description";
  if (norm(body.location) !== norm(need.location)) return "another place";
  if (Number(body.estimatedPrice) !== need.proposedPayUsd) return "another pay";
  if (Number(body.workType) !== need.workType) return "another work type";
  if (body.domain !== undefined && body.domain !== "ecological") return "another domain";
  if (body.skillLevel !== undefined && body.skillLevel !== (need.skillLevel ?? "entry")) return "another skill level";
  if (body.expiresInDays !== undefined && Number(body.expiresInDays) !== (need.expiresInDays ?? 30)) return "another open period";
  for (const [k, mine] of [["proofRule", need.proofRule], ["standard", need.standard], ["safetyNotes", need.safetyNotes]]) {
    if ((body[k] !== undefined || mine !== undefined) && norm(body[k]) !== norm(mine)) return `another ${k}`;
  }
  if (JSON.stringify(normList(body.proofRequirements)) !== JSON.stringify(normList(need.proofRequirements))) return "other proof items";
  if (JSON.stringify(normList(body.flags).map((f) => f.toLowerCase()).sort()) !== JSON.stringify(normList(need.flags).sort())) return "other authority flags";
  if (body.definitionId !== undefined) {
    if (typeof body.definitionId !== "string" || body.definitionId.length > 200) return "an odd job definition";
    for (const w of body.definitionId.match(OTHER_WALLET_RE) ?? []) if (w.toLowerCase() !== String(address).toLowerCase()) return "a job definition in another wallet's name";
  }
  if (!freshNonce(body.nonce, now)) return "a stale or odd nonce";
  return null;
}
const VOTE_FIELDS = new Set(["voterWallet", "stance", "nonce", "reason", "voterKind"]);
/** The vote the board built must be a vote FOR, from this wallet, recorded as an agent's, with the steward's own reason. */
export function checkVoteBody(body, address, reason, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "a body that is not an object";
  for (const k of Object.keys(body)) if (!VOTE_FIELDS.has(k)) return `an extra field, ${safeName(k).slice(0, 40)}`;
  if (norm(body.voterWallet).toLowerCase() !== String(address).toLowerCase()) return "another wallet as the voter";
  if (body.stance !== "for") return "another stance";
  if (body.voterKind !== "agent") return "a vote not marked as an agent's";
  if (body.reason !== undefined && norm(body.reason) !== norm(reason).slice(0, 280)) return "another reason";
  if (!freshNonce(body.nonce, now)) return "a stale or odd nonce";
  return null;
}
/** The one place a message to sign is decided: the body the door handed back, checked, and the message rebuilt here from it. */
function checkedSigning(prep, submitTool, pathName, check) {
  const nc = prep.next?.tool === submitTool ? prep.next : null;
  const bodyJson = typeof nc?.args?.bodyJson === "string" ? nc.args.bodyJson : /^BODY_JSON: (.+)$/m.exec(prep.text)?.[1] ?? null;
  const offered = typeof nc?.message_to_sign === "string" ? nc.message_to_sign : /^MESSAGE_TO_SIGN: (.+)$/m.exec(prep.text)?.[1] ?? null;
  if (!bodyJson) return { why: "no body to sign" };
  let body; try { body = JSON.parse(bodyJson); } catch { return { why: "a body that is not JSON" }; }
  const wrong = check(body);
  if (wrong) return { why: `a body that is not the one the steward asked for (${wrong})` };
  let message; try { message = bodyBoundMessage("POST", pathName, body); } catch { return { why: "a body nested too deeply to sign" }; }
  if (offered !== null && offered.trim() !== message) return { why: "a message to sign for something other than this post or vote (another route or another body)" };
  return { body, message };
}

// ── the owner's folder ────────────────────────────────────────────────────────────────────────────────────────────
export const homeDir = (flag) => path.resolve(flag || process.env.VEALTH_STEWARD_HOME || path.join(os.homedir(), ".vealth-steward"));
export const pathsOf = (dir) => ({
  dir, key: path.join(dir, "wallet.key"), address: path.join(dir, "wallet.address"), config: path.join(dir, "config.json"),
  state: path.join(dir, "state.json"), digest: path.join(dir, "digest.md"), log: path.join(dir, "steward.log"), heartbeat: path.join(dir, "heartbeat.json"),
  needs: path.join(dir, "needs"), votes: path.join(dir, "votes.txt"), stop: path.join(dir, "STOP"), lock: path.join(dir, "steward.lock"),
});
const VOTES_TEMPLATE = "# Work ids you want this steward to vote FOR, one per line (free, recorded as an agent vote).\n# The digest prints each new job's id. Lines starting with # are ignored.\n";
const NEEDS_NOTE = [
  "Drop a .txt or .md file in this folder to post a need. Header lines, a blank line, then what needs doing:",
  "",
  "  title: Photograph the fire exit signs at the construction site gate",
  "  pay: 12",
  "  standard: construction_site_safety",
  "  safety: Document from the public sidewalk only. Never enter the site.",
  "  proof: photos of each sign",
  "",
  "  Walk the public sidewalk at the gate and photograph every fire exit sign you can see.",
  "",
  "A file posts once (the same words are never posted twice). Never put a phone number or an email in it: a job is public.",
  "",
].join("\n");

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const exists = (file) => { try { fs.lstatSync(file); return true; } catch { return false; } };
const iso = (ms) => new Date(ms).toISOString();
/** Write, flush to disk, then rename over the old file: a crash or a power cut leaves the old file or the new one, never half of either. */
function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", mode);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
const writeJsonAtomic = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
/** Append to a file that rolls over at the cap: file to file.1 to file.2 to file.3, the oldest dropped. */
export function appendRotating(file, text, cap = LOG_CAP_BYTES, keep = LOG_KEEP) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* a new file */ }
  if (size > 0 && size + Buffer.byteLength(text) > cap) {
    fs.rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* not there yet */ } }
    try { fs.renameSync(file, `${file}.1`); } catch { /* gone */ }
  }
  fs.appendFileSync(file, text, { mode: 0o600 });
}
/** The folder holds the key and decides what gets posted: it must be this user's, readable and writable by this user alone. */
function ensureOwnerDir(dir, say = () => {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.statSync(dir);
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder.`);
  if (process.platform === "win32") return;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`The folder ${dir} belongs to another user. The steward keeps its key only in a folder that is yours alone.`);
  if (st.mode & 0o077) { fs.chmodSync(dir, 0o700); say(`Tightened ${dir} to owner-only: it was open to other users of this machine.`); }
}

let viemCache = null;
async function loadViem() {
  if (viemCache) return viemCache;
  try { viemCache = await import("viem/accounts"); return viemCache; } catch {
    throw new Error("The steward signs with one dependency, viem. Run `npm ci --ignore-scripts` once in its folder, then start it again.");
  }
}
/** The key file must be a plain file of this user's holding a usable key. Whatever is wrong, its content is never shown. */
function readKey(file) {
  const bad = `The key file ${file} does not hold a 32-byte hex key. Its content is not shown. Move the file aside to make a new wallet (jobs posted by the old wallet stay with the old key).`;
  let st;
  try { st = fs.lstatSync(file); } catch { throw new Error(`There is no key file at ${file}. Run: node steward.mjs setup --place "Your Place"`); }
  if (st.isSymbolicLink()) throw new Error(`${file} is a link. The steward reads its key only from a plain file in its own folder. Its content is not shown.`);
  if (!st.isFile()) throw new Error(`${file} is not a plain file. Its content is not shown.`);
  if (process.platform !== "win32" && typeof process.getuid === "function" && st.uid !== process.getuid()) throw new Error(`${file} belongs to another user. The steward uses only a key that is yours alone.`);
  if (st.size > 200) throw new Error(bad);
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!KEY_RE.test(raw)) throw new Error(bad);
  const k = BigInt(raw);
  if (k === 0n || k >= CURVE_N) throw new Error(bad);
  return raw;
}
/** Looser permissions on the key are tightened, never ignored. Windows keeps its own access lists (see the README). */
function tightenKey(file, say = () => {}) {
  if (process.platform === "win32") return false;
  let st; try { st = fs.lstatSync(file); } catch { return false; }
  if (!st.isFile() || (st.mode & 0o077) === 0) return false;
  fs.chmodSync(file, 0o600);
  say(`Tightened ${file} to owner-only.`);
  return true;
}
async function signerFor(keyHex) {
  const { privateKeyToAccount } = await loadViem();
  const account = privateKeyToAccount(keyHex);
  return { address: account.address, sign: (message) => account.signMessage({ message }) };
}

export function parsePlace(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ""));
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}
// ── --kind: watch only one kind of work ───────────────────────────────────────────────────────────────────────────────
/** Words the way the board itself reads them (accents folded, lower case, every run of other characters one space), so a kind the board would find, the steward finds. */
const COMBINING_MARKS_RE = new RegExp(`[${cls([[0x300, 0x36f]])}]`, "g"); // built at run time, like the other invisible-character classes, so no such character sits in this file
export const kindWords = (s) => String(s ?? "").normalize("NFD").replace(COMBINING_MARKS_RE, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/**
 * The kinds a person asked to watch, as plain words: `--kind "fire,ember zone"` is two kinds. Commas separate kinds; a kind is one or
 * more words. `all` or `any` on its own means no filter (watch everything again). Returns the list, never null.
 */
export function parseKinds(raw) {
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((x) => String(x ?? "").split(","));
  const kinds = [];
  for (const part of parts) {
    const k = kindWords(part);
    if (!k) continue;
    if (k.length < 2 || k.length > MAX_KIND_CHARS) throw new Error(`A kind is one or more words of 2 to ${MAX_KIND_CHARS} letters or digits in all ("${safeName(part).slice(0, 30)}" is not).`);
    if (!kinds.includes(k)) kinds.push(k);
  }
  if (kinds.length === 1 && (kinds[0] === "all" || kinds[0] === "any")) return [];
  if (kinds.length > MAX_KINDS) throw new Error(`Watch at most ${MAX_KINDS} kinds at a time (it was ${kinds.length}).`);
  return kinds;
}
/** The work type as words: the board sends a number (0 water, 1 soil and planting, 2 building) or its own label. */
const WORK_TYPE_WORDS = ["water", "soil planting", "building"];
const workTypeWords = (v) => (typeof v === "number" ? (WORK_TYPE_WORDS[v] ?? "") : typeof v === "string" ? v : "");
/** What a kind is matched against: the job's title, its proof line and its work type, as find_work returns them. Never its place, so a kind is never a street. */
export function kindText(row) {
  const words = (x) => scrub(textOf(x)).replace(FENCE_RE, " ");
  return kindWords([words(row?.title), words(row?.proofRule), workTypeWords(row?.workType)].join(" "));
}
/** True when the row has no filter on it (no kinds), or when any kind begins a word of the row's title, proof line or work type, the board's own rule. */
export function matchesKinds(row, kinds) {
  if (!Array.isArray(kinds) || !kinds.length) return true;
  const hay = ` ${kindText(row)}`;
  return kinds.some((k) => hay.includes(` ${k}`));
}
/** The words for the board's own search, so it sends back work that carries them; null when there are more than it reads (the steward then filters alone). */
export function kindQuery(kinds) {
  const words = [...new Set((Array.isArray(kinds) ? kinds : []).flatMap((k) => k.split(" ")))];
  return words.length && words.length <= MAX_QUERY_WORDS ? words.join(" ") : null;
}
/** The kinds to keep: the ones just asked for (an empty list clears them), else the ones already saved. */
const checkedKinds = (asked, saved) => (asked === undefined ? parseKinds(saved) : parseKinds(asked));

function checkedPlace({ place, lat, lng, radiusKm, intervalMinutes }, base = {}) {
  const c = { ...base };
  if (place !== undefined && place !== null && String(place).trim()) {
    const clean = scrub(String(place)).replace(/\s+/g, " ").trim().slice(0, 120);
    const point = parsePlace(clean);
    delete c.lat; delete c.lng; // a new place never keeps the old place's coordinates
    if (point) { c.lat = point.lat; c.lng = point.lng; c.place = `${point.lat},${point.lng}`; } else c.place = clean;
  }
  if (lat !== undefined || lng !== undefined) { c.lat = Number(lat); c.lng = Number(lng); }
  if (c.lat !== undefined && !(Number.isFinite(c.lat) && Number.isFinite(c.lng) && Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180)) throw new Error("The coordinates are not a place on Earth. Give --lat between -90 and 90 and --lng between -180 and 180.");
  if (!c.place && c.lat !== undefined) c.place = `${c.lat},${c.lng}`;
  if (!c.place) throw new Error('Tell the steward the place: --place "Boyle Heights, Los Angeles, CA" or --lat 34.03 --lng -118.21.');
  if (radiusKm !== undefined) c.radiusKm = Number(radiusKm);
  if (!(c.radiusKm > 0 && c.radiusKm <= 200)) c.radiusKm = c.radiusKm > 200 ? 200 : 10;
  if (intervalMinutes !== undefined) c.intervalMinutes = Number(intervalMinutes);
  c.intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, Number.isFinite(c.intervalMinutes) ? c.intervalMinutes : 30);
  return c;
}
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const isLoopbackUrl = (url) => { try { return LOOPBACK.has(new URL(url).hostname); } catch { return false; } };
function checkedMcpUrl(url) {
  let u; try { u = new URL(String(url)); } catch { throw new Error(`The door address ${safeName(String(url)).slice(0, 80)} is not a web address.`); }
  if (u.username || u.password) throw new Error("The door address must not carry a user name or a password.");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error("The door address must be https (plain http is only allowed for this computer's own address).");
  u.hash = "";
  return u.toString();
}

/** First run: make the folder, the wallet and the config. Run again: keep the wallet, update the place. Prints the address, never the key. */
export async function setupSteward(opts, say = () => {}) {
  const p = pathsOf(homeDir(opts.dir));
  ensureOwnerDir(p.dir, say);
  fs.mkdirSync(p.needs, { recursive: true, mode: 0o700 });
  if (!exists(p.votes)) fs.writeFileSync(p.votes, VOTES_TEMPLATE, { mode: 0o600 });
  const readme = path.join(p.needs, "README.txt");
  if (!exists(readme)) fs.writeFileSync(readme, NEEDS_NOTE, { mode: 0o600 });
  let created = false;
  if (!exists(p.key)) {
    const { generatePrivateKey } = await loadViem();
    fs.writeFileSync(p.key, `${generatePrivateKey()}\n`, { mode: 0o600, flag: "wx" }); // wx: never over a file, a link or a race
    created = true;
  }
  tightenKey(p.key, say);
  const signer = await signerFor(readKey(p.key));
  if (readText(p.address).trim() !== signer.address) writeFileAtomic(p.address, `${signer.address}\n`, 0o644);
  const previous = readJson(p.config, {});
  const config = checkedPlace(opts, previous);
  config.mcpUrl = checkedMcpUrl(opts.mcpUrl || previous.mcpUrl || DEFAULT_MCP_URL);
  const kinds = checkedKinds(opts.kinds, previous.kinds);
  if (kinds.length) config.kinds = kinds; else delete config.kinds; // no kinds saved means watch everything, as before this existed
  const changed = JSON.stringify(config) !== JSON.stringify(previous);
  if (changed) writeJsonAtomic(p.config, config);
  if (created || changed) {
    say(`${created ? "Made a new wallet for this steward." : "Kept the wallet this steward already has."} Its public address: ${signer.address}`);
    say(`The key is in ${p.key}, readable only by you. It never leaves this machine and is never printed. The wallet holds nothing and needs nothing.`);
    say(`Place: ${config.place}, within ${config.radiusKm} km. Looks every ${config.intervalMinutes} minutes. Door: ${config.mcpUrl}`);
    if (config.kinds) say(`Only work matching: ${config.kinds.join(", ")}. Watch everything again with --kind all.`);
  }
  if (created) {
    say([
      "First run. What happens now:",
      `  1. It looks at the board near ${config.place} now, then every ${config.intervalMinutes} minutes, and writes what is new to ${p.digest}.`,
      "  2. It is DRY until you add --live: it shows what it would post and vote, and does neither.",
      `  3. To post a need, put a .txt file in ${p.needs} (the README.txt there shows the format).`,
      `  4. To vote for a job, put its id on a line in ${p.votes}.`,
      `  Where it stands: node steward.mjs status --dir ${p.dir}`,
      `  To stop it: Ctrl-C, or create the file ${p.stop} (it stays stopped until you delete that file).`,
    ].join("\n"));
  }
  return { dir: p.dir, address: signer.address, created, changed, config };
}

/** Everything one run needs, in one object, so a test can hand it a different door, clock and screen. */
export async function openSteward(opts = {}) {
  const p = pathsOf(homeDir(opts.dir));
  const config = readJson(p.config, null);
  if (!config) throw new Error(`No steward is set up in ${p.dir}. Start it with: node steward.mjs run --place "Your Place" --radius 5`);
  const deps = opts.deps ?? {};
  ensureOwnerDir(p.dir);
  tightenKey(p.key);
  const keyHex = readKey(p.key);
  const signer = await signerFor(keyHex);
  const merged = checkedPlace(opts, config);
  const kinds = checkedKinds(opts.kinds, config.kinds);
  if (kinds.length) merged.kinds = kinds; else delete merged.kinds;
  const mcpUrl = checkedMcpUrl(opts.mcpUrl || config.mcpUrl || DEFAULT_MCP_URL);
  const secrets = [keyHex.slice(2).toLowerCase()];
  const out = makeOut(secrets, deps.write, deps.log === false ? null : p.log);
  const pace = Number.isFinite(opts.paceMs) ? Math.max(0, opts.paceMs) : 1250;
  const s = {
    dir: p.dir, paths: p, config: merged, signer, address: signer.address, secrets,
    live: Boolean(opts.live), mcpUrl, era: opts.era ?? MODERN_ERA, eraFellBack: false, house: opts.house ?? null,
    fetch: deps.fetch ?? globalThis.fetch, now: deps.now ?? (() => Date.now()), sleep: deps.sleep ?? sleepMs,
    out, say: out.say, jitter: deps.jitter ?? Math.random,
    // a pace below a second is only for a door on this computer: a real door gets at most one call a second from one steward
    paceMs: isLoopbackUrl(mcpUrl) ? pace : Math.max(1000, pace),
    maxCalls: opts.maxCalls ?? 150, maxNew: opts.maxNew ?? 15, maxPages: opts.maxPages ?? 4,
    postsPerDay: Math.min(POSTS_PER_DAY, opts.postsPerDay ?? POSTS_PER_DAY), maxVotes: opts.maxVotes ?? 10, timeoutMs: opts.timeoutMs ?? 30_000,
    stopFiles: [p.stop, ...(opts.stopFiles ?? []).map((f) => path.resolve(f))], lockFile: null, heartbeat: {},
    localContactCheck: opts.localContactCheck !== false, stopped: false, calls: 0, signal: opts.signal,
  };
  s.wait = deps.wait ?? ((ms) => waitChunked(s, ms));
  return s;
}

/** The one place anything is printed or logged for a person: it hides the key even if a bug tried to show it, in any form. */
export function makeOut(secrets = [], write = (t) => process.stdout.write(t), logFile = null) {
  const res = secrets.filter((k) => k && k.length > 8).map((k) => new RegExp(`(?:0x)?${k.replace(/^0x/i, "").replace(/[^0-9a-fA-F]/g, "")}`, "gi"));
  const hide = (t) => {
    let s = String(t);
    for (const re of res) s = s.replace(re, "[hidden]");
    return s.replace(/0x[0-9a-fA-F]{64}\b/g, "[hidden]").replace(/\d{60,}/g, "[hidden]");
  };
  const say = (t) => {
    const text = hide(t);
    write(`${text}\n`);
    if (!logFile) return;
    const stamp = new Date().toISOString();
    try { appendRotating(logFile, `${text.split("\n").map((l) => `${stamp} ${l}`).join("\n")}\n`); } catch { /* a full disk never stops a look */ }
  };
  return { hide, say };
}

/** A sleep that a stop cuts short, and that leaves no listener behind when it ends on its own. */
export const sleepMs = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  let t = null;
  const done = () => { if (t) clearTimeout(t); signal?.removeEventListener?.("abort", done); resolve(); };
  t = setTimeout(done, Math.max(0, ms));
  signal?.addEventListener?.("abort", done, { once: true });
});
/** The first stop file present (the folder's STOP, then any --stop-file), or null. */
export const stopFileFound = (s) => s.stopFiles.find((f) => exists(f)) ?? null;
/** Wait by the wall clock, a minute at a time, watching for a stop file and keeping the lock fresh. */
export async function waitChunked(s, ms) {
  const until = s.now() + ms;
  while (!s.stopped) {
    const left = until - s.now();
    if (left <= 0) return "due";
    if (stopFileFound(s)) return "stop file";
    refreshLock(s);
    await s.sleep(Math.min(SLEEP_CHUNK_MS, left), s.signal);
  }
  return "stopped";
}

// ── the door ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Thrown when the door asks the steward to stop for now (429, 503, no answer) or this look has used its budget. */
export class StopLook extends Error {
  constructor(why, { retryAfter = 0, status = 0, backoff = true } = {}) { super(why); this.retryAfter = retryAfter; this.status = status; this.backoff = backoff; }
}
function retryAfterSeconds(header, nowMs) {
  if (!header) return 0;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - nowMs) / 1000)) : 0;
}
export function parseNextCall(text) {
  const at = text.lastIndexOf("NEXT_CALL:\n");
  if (at < 0) return null;
  try {
    const next = JSON.parse(text.slice(at + "NEXT_CALL:\n".length).trim());
    return next && typeof next === "object" && typeof next.tool === "string" ? next : null;
  } catch { return null; }
}
/** Read the body, but never more than the cap: past it the reading stops and the look backs off. */
async function readCapped(res, max) {
  const tooBig = () => new StopLook(`the door's answer was larger than ${Math.round(max / 1e6)} MB, so the steward did not read it`);
  const reader = res.body?.getReader?.();
  if (!reader) { const t = await res.text(); if (Buffer.byteLength(t) > max) throw tooBig(); return t; }
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* closed */ } throw tooBig(); }
    chunks.push(Buffer.from(value));
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}
/** A Streamable HTTP answer may come as an event stream: the JSON-RPC message is its last `data:` event. */
function jsonFromBody(raw, contentType) {
  if (!/text\/event-stream/i.test(String(contentType ?? ""))) return JSON.parse(raw);
  const events = raw.split(/\n\n+/).map((ev) => ev.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n")).filter(Boolean);
  return JSON.parse(events.at(-1) ?? "");
}
/** What went wrong on the wire, in words a person can act on. */
function netWords(e, s) {
  const code = String(e?.cause?.code ?? e?.code ?? "");
  const msg = `${e?.message ?? e} ${e?.cause?.message ?? ""}`;
  if (/redirect/i.test(msg)) return "the door did not answer here: it sent a redirect to somewhere else, and the steward only talks to the address it was given";
  if (e?.name === "AbortError" || /aborted|timeout/i.test(msg)) return `the door did not answer within ${Math.round(s.timeoutMs / 1000)} seconds`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the door did not answer: its name did not resolve (no DNS answer; the network may be down)";
  if (code === "ECONNREFUSED") return "the door did not answer: it refused the connection";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "the door did not answer: the connection was cut";
  if (/CERT|SELF_SIGNED|TLS|SSL/i.test(code)) return `the door did not answer safely: its certificate did not check out (${code}), and the steward will not talk to it until it does`;
  return `the door did not answer (${safeName(msg.trim()).slice(0, 80)})`;
}

async function callOnce(s, name, args) {
  const params = { name, arguments: args };
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": `vealth-steward/${VERSION}`, "mcp-protocol-version": s.era };
  if (s.era === MODERN_ERA) {
    params._meta = { "io.modelcontextprotocol/protocolVersion": MODERN_ERA, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "vealth-steward", version: VERSION } };
    headers["mcp-method"] = "tools/call";
    headers["mcp-name"] = name;
  }
  if (s.house) headers["x-vealth-house"] = s.house;
  const wire = JSON.stringify({ jsonrpc: "2.0", id: s.calls, method: "tools/call", params });
  // the key never leaves this machine: a request that would carry it is stopped here, whatever put it there
  const lower = wire.toLowerCase();
  if (s.secrets.some((k) => k && lower.includes(k))) throw new StopLook("a request that would have carried this steward's key was stopped before it left the machine", { backoff: false });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), s.timeoutMs);
  const onStop = () => ac.abort();
  if (s.signal?.aborted) ac.abort(); else s.signal?.addEventListener?.("abort", onStop, { once: true });
  let res; let raw = "";
  try {
    res = await s.fetch(s.mcpUrl, { method: "POST", headers, body: wire, redirect: "error", signal: ac.signal });
    if (res.status >= 300 && res.status < 400) throw new StopLook("the door did not answer here: it sent a redirect to somewhere else, and the steward only talks to the address it was given");
    raw = await readCapped(res, MAX_REPLY_BYTES);
  } catch (e) {
    if (e instanceof StopLook) throw e;
    if (s.stopped) throw new StopLook("the steward is stopping", { backoff: false });
    throw new StopLook(netWords(e, s));
  } finally {
    clearTimeout(timer);
    s.signal?.removeEventListener?.("abort", onStop);
  }
  const retryAfter = retryAfterSeconds(res.headers?.get?.("retry-after"), s.now());
  if (res.status === 429 || res.status >= 500) throw new StopLook(`the door answered ${res.status}`, { retryAfter, status: res.status });
  let json = null;
  try { json = jsonFromBody(raw, res.headers?.get?.("content-type")); } catch { throw new StopLook(`the door sent something that is not JSON (HTTP ${res.status})`, { status: res.status }); }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new StopLook("the door sent an answer that is not one JSON-RPC message");
  if (json.error) {
    // a protocol error means the door did not run the tool: never the board's words about the need, so it backs off and tries again later
    const code = Number(json.error?.code);
    const words = plain(String(json.error?.message ?? ""), 160).replace(/\s+/g, " ");
    if (s.era === MODERN_ERA && !s.eraFellBack && (code === -32022 || code === -32020 || (res.status === 400 && /_meta|protocol/i.test(words)))) return { eraRefused: true };
    throw new StopLook(`the door could not run ${name} (protocol error ${Number.isFinite(code) ? code : "?"}: ${safeName(words)})`, { status: res.status });
  }
  if (res.status >= 400) throw new StopLook(`the door answered ${res.status}`, { status: res.status });
  const result = json.result && typeof json.result === "object" ? json.result : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const text = scrub(content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n")).slice(0, 200_000);
  const sc = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent) ? result.structuredContent : {};
  const fallbackNext = sc.next_call && typeof sc.next_call === "object" && typeof sc.next_call.tool === "string" ? sc.next_call : null;
  const rep = { status: res.status, isError: result.isError === true, text, prose: text, sc, next: parseNextCall(text) ?? fallbackNext };
  // The board relays its own gates inside a tool reply. A 429 or 5xx there is the door asking to wait, except the day cap, which is its own words.
  const inner = /\(HTTP (429|5\d\d)\)/.exec(text);
  if (rep.isError && inner && !/signed_post_cap_reached/.test(text)) throw new StopLook(`the board answered ${inner[1]} inside the tool`, { retryAfter, status: Number(inner[1]) });
  if (rep.isError && /did not answer in time/i.test(text)) throw new StopLook("the board's gate did not answer in time");
  return rep;
}

/** One tools/call to the door. Never throws for a refusal in words; throws StopLook for 429, 5xx, a protocol error, no answer or a spent budget. */
export async function door(s, name, args) {
  if (!TOOLS.has(name)) throw new StopLook(`the steward does not call ${safeName(String(name)).slice(0, 40)}`, { backoff: false });
  if (s.stopped) throw new StopLook("the steward is stopping", { backoff: false });
  if (s.calls >= s.maxCalls) throw new StopLook("this look used its call budget; the rest waits for the next look", { backoff: false });
  if (s.calls > 0 && s.paceMs > 0) await s.sleep(s.paceMs, s.signal);
  if (s.stopped) throw new StopLook("the steward is stopping", { backoff: false });
  s.calls += 1;
  refreshLock(s);
  let rep = await callOnce(s, name, args);
  if (rep.eraRefused) {
    s.era = LEGACY_ERA; s.eraFellBack = true;
    s.say(`steward: this door does not take the ${MODERN_ERA} form of the protocol; speaking ${LEGACY_ERA} from now on.`);
    s.calls += 1;
    rep = await callOnce(s, name, args);
  }
  return rep;
}

// ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const MAPS = ["seen", "needs", "postedHashes", "pending", "postStatus", "votes", "voteRefused", "voteDry"];
const nullProto = (o) => Object.assign(Object.create(null), o && typeof o === "object" && !Array.isArray(o) ? o : {});
const freshState = () => ({ version: 2, ...Object.fromEntries(MAPS.map((k) => [k, Object.create(null)])), posts: [], ignored: [], ownSig: "", lastLookAt: null, backoffUntil: null });
/** What it has already shown, posted and voted. A file that cannot be read is kept aside and said, never silently reset. */
export function loadState(s) {
  const st = freshState();
  let raw;
  try { raw = fs.readFileSync(s.paths.state, "utf8"); } catch { return st; }
  let parsed;
  try { parsed = JSON.parse(raw); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object"); } catch {
    const aside = `${s.paths.state}.unreadable-${iso(s.now()).replace(/[:.]/g, "-")}`;
    try { fs.renameSync(s.paths.state, aside); } catch { /* left where it is */ }
    st.note = `state.json could not be read, so it was kept aside as ${path.basename(aside)} and the steward started its memory again: jobs it showed before may be shown once more. The board's own day limit still counts its posts.`;
    return st;
  }
  for (const k of MAPS) st[k] = nullProto(parsed[k]);
  st.posts = Array.isArray(parsed.posts) ? parsed.posts.filter((p) => p && typeof p.at === "string").slice(-200) : [];
  st.ignored = Array.isArray(parsed.ignored) ? parsed.ignored.filter((x) => typeof x === "string").slice(0, 200) : [];
  st.ownSig = typeof parsed.ownSig === "string" ? parsed.ownSig : "";
  st.lastLookAt = typeof parsed.lastLookAt === "string" ? parsed.lastLookAt : null;
  st.backoffUntil = typeof parsed.backoffUntil === "string" ? parsed.backoffUntil : null;
  if (!(parsed.version >= 2)) { // 0.1.0 kept posts by file name only: carry each posted file's words into the content record
    for (const [name, v] of Object.entries(st.needs)) if (v?.status === "posted" && typeof v.hash === "string" && !st.postedHashes[v.hash]) st.postedHashes[v.hash] = { workId: v.workId ?? null, at: v.at ?? null, name };
  }
  return st;
}
const stamp = (v) => String(v?.last ?? v?.at ?? "");
function capMap(map, n) {
  const keys = Object.keys(map);
  if (keys.length <= n) return;
  for (const k of keys.sort((a, b) => stamp(map[a]).localeCompare(stamp(map[b]))).slice(0, keys.length - n)) delete map[k];
}
function saveState(s, state) {
  const now = s.now();
  capMap(state.seen, 5000);
  capMap(state.postedHashes, 2000);
  capMap(state.votes, 2000);
  for (const [id, v] of Object.entries(state.postStatus)) if ((v?.status === "SETTLED" || v?.status === "EXPIRED") && Date.parse(v.checkedAt ?? "") < now - 30 * 86_400_000) delete state.postStatus[id];
  for (const [h, v] of Object.entries(state.pending)) if (!(Date.parse(v?.at ?? "") >= now - 7 * 86_400_000)) delete state.pending[h];
  state.posts = state.posts.slice(-200);
  const { note, ...keep } = state;
  writeJsonAtomic(s.paths.state, keep);
}
/** Posts in the rolling day, a post sent but not confirmed included (never more than ten, even across a crash or a clock moved back). */
export const postsInLastDay = (state, now) => [...(state.posts ?? []), ...Object.values(state.pending ?? {})].filter((p) => Date.parse(p?.at ?? "") >= now - 86_400_000).length;

// ── 1. new jobs near the place ────────────────────────────────────────────────────────────────────────────────────
export const searchArgs = (c) => {
  const query = kindQuery(c.kinds); // with kinds, the board is asked for work that carries those words; the steward still checks every row itself
  return { ...(c.lat !== undefined ? { latitude: c.lat, longitude: c.lng, radiusKm: c.radiusKm } : { near: c.place, radiusKm: c.radiusKm }), ...(query ? { query } : {}) };
};

async function phaseJobs(s, state, report) {
  const seenRows = []; const ids = new Set(); let dropped = 0; let more = false;
  for (let page = 1; page <= s.maxPages && !s.stopped; page++) {
    const rep = await door(s, "find_work", { ...searchArgs(s.config), limit: 25, page });
    if (rep.isError) { report.notes.push(`find_work said: ${boardWords(rep.prose, 240)}`); break; }
    for (const row of Array.isArray(rep.sc.matches) ? rep.sc.matches.slice(0, 25) : []) {
      const id = safeId(row?.workId);
      if (!id) { dropped += 1; continue; }
      if (ids.has(id)) continue;
      ids.add(id); seenRows.push({ ...row, workId: id });
    }
    more = rep.sc.morePages === true;
    if (!more) break;
  }
  // --kind: only the work whose title, proof line or work type carries one of the kinds. Everything else is left out of this look and never marked seen,
  // so changing the kinds takes effect at the next look.
  const found = seenRows.filter((r) => matchesKinds(r, s.config.kinds));
  report.jobsFiltered = seenRows.length - found.length;
  const at = iso(s.now());
  for (const r of found) { const seen = state.seen[r.workId]; if (seen && typeof seen === "object") seen.last = at; } // still open: kept as newest
  const fresh = found.filter((r) => !Object.hasOwn(state.seen, r.workId));
  for (const row of fresh.slice(0, s.maxNew)) {
    if (s.stopped) break;
    const packet = await door(s, "get_work_packet", { workId: row.workId });
    const answers = !packet.isError && packet.sc.answers && typeof packet.sc.answers === "object" ? packet.sc.answers : null;
    report.jobs.push({ row, answers });
    state.seen[row.workId] = { at, last: at };
  }
  report.jobsWaiting = Math.max(0, fresh.length - s.maxNew);
  report.jobsOpen = found.length;
  report.jobsMore = more;
  if (dropped) report.notes.push(`${dropped} job(s) from the door had an id that is not a work id, so they were left out.`);
}

function jobBlock(item, s) {
  const { row, answers } = item;
  const km = Number.isFinite(row.distanceKm) ? `, ${Number(row.distanceKm).toFixed(1)} km from your place` : "";
  const place = row.place?.address ? fence(row.place.address) : row.place?.remote === true ? "remote, can be done from anywhere" : "the board gave no place";
  const pin = row.place?.pinNote ? ` (${boardWords(row.place.pinNote, 160)})` : row.place?.pointSource === "none" ? " (the board has no map point for it yet)" : "";
  const judged = answers?.proof?.judged ? boardWords(answers.proof.judged, 300) : "the board did not say";
  const claim = row.claimable === false ? `not open to claim right now (${safeCode(row.claimabilityReasonCode) ?? "closed"})` : "open to claim";
  return [
    `- ${fence(row.title)}`,
    `  where: ${place}${km}${pin}`,
    `  pay: ${payWords(row)}`,
    `  who checks the proof: ${judged}`,
    `  proof asked: ${row.proofRule ? fence(row.proofRule, 300) : "not stated"}`,
    `  level: ${SKILLS.has(row.skillLevel) ? row.skillLevel : "not stated"}; ${claim}`,
    `  page: ${safePage(row.page, s.mcpUrl) ?? "the board gave no page link"}`,
    `  id: ${row.workId}   (to vote for it, add the id to votes.txt)`,
  ].join("\n");
}

// ── 2. the owner's needs ──────────────────────────────────────────────────────────────────────────────────────────
const NEED_KEYS = Object.assign(Object.create(null), { title: "title", place: "place", where: "place", location: "place", pay: "pay", price: "pay", standard: "standard", skill: "skill", level: "skill", type: "type", worktype: "type", proof: "proof", safety: "safety", expires: "expires", days: "expires", description: "description", flag: "flag", flags: "flag" });
const HEADER_RE = /^\s*([A-Za-z][A-Za-z ]{1,16}):\s*(.*?)\s*$/;

/** Read a small file through one handle that refuses a link: no more than the cap, and only UTF-8 text. */
function readSmallText(file, max) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); } catch { return { why: "it could not be opened as a plain file" }; }
  try {
    const buf = Buffer.alloc(max + 1);
    const n = fs.readSync(fd, buf, 0, max + 1, 0);
    if (n > max) return { why: "it is more than 20 KB" };
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) return { why: "it is not plain text (it holds binary bytes)" };
    try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; } catch { return { why: "it is not plain text (not UTF-8)" }; }
  } finally { fs.closeSync(fd); }
}

/** The need files in needs/: plain .txt and .md files only (a link is never followed), at most 50 a look, each at most 20 KB of UTF-8. */
export function listNeedFiles(dir, max = MAX_NEED_FILES) {
  const items = []; const ignored = []; const present = new Set(); let skipped = 0;
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch { return { items, ignored, present, skipped }; }
  for (const name of names) {
    present.add(name);
    if (name.startsWith(".") || /^readme\.txt$/i.test(name)) continue;
    const file = path.join(dir, name);
    let st; try { st = fs.lstatSync(file); } catch { continue; }
    const shown = safeName(name);
    if (st.isSymbolicLink()) { ignored.push(`${shown}: ignored, it is a link. Only plain files in needs/ are read, so nothing outside the folder is ever sent.`); continue; }
    if (!st.isFile()) continue;
    if (!/\.(txt|md)$/i.test(name)) { ignored.push(`${shown}: ignored, only .txt and .md files are read.`); continue; }
    if (items.length >= max) { skipped += 1; continue; }
    if (st.size > MAX_NEED_BYTES) { ignored.push(`${shown}: ignored, it is more than 20 KB.`); continue; }
    const got = readSmallText(file, MAX_NEED_BYTES);
    if (got.why) { ignored.push(`${shown}: ignored, ${got.why}.`); continue; }
    items.push({ name, shown, text: got.text, hash: createHash("sha256").update(got.text).digest("hex").slice(0, 32) });
  }
  return { items, ignored, present, skipped };
}

/** A need file: header lines (title, pay, place, standard, skill, type, proof, safety, expires, flag), a blank line, then the description. */
export function parseNeed(text, config) {
  const raw = String(text);
  const lines = (raw.startsWith(BOM) ? raw.slice(1) : raw).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const head = Object.create(null); const proofs = []; const flags = [];
  for (; i < lines.length; i++) {
    const m = HEADER_RE.exec(lines[i]);
    const key = m ? NEED_KEYS[m[1].toLowerCase().replace(/\s+/g, "")] : null;
    if (!key) break;
    if (key === "proof") { if (m[2]) proofs.push(m[2]); } else if (key === "flag") { if (m[2]) flags.push(m[2].toLowerCase()); } else head[key] = m[2];
  }
  let rest = lines.slice(i).join("\n").trim();
  let title = head.title;
  if (!title) { const [first, ...others] = rest.split(/\r?\n/); title = (first ?? "").trim(); rest = others.join("\n").trim(); }
  const description = (head.description || rest).trim();
  const no = (why) => ({ ok: false, why });
  if (!title) return no("it has no title. Start the file with a line like `title: Photograph the posted safety notices at the gate`.");
  if (!description) return no("it has no description. After the header lines, leave a blank line and write what needs doing, so a stranger could do it from the text alone.");
  const pay = Number(String(head.pay ?? "").replace(/^\$/, ""));
  if (!(Number.isFinite(pay) && pay > 0)) return no("it has no pay line. Add one like `pay: 15` (US dollars, proposed; nobody is charged, and an unfunded job earns a credit, not cash).");
  if (head.type !== undefined && head.type !== "" && !["0", "1", "2"].includes(head.type)) return no("its type line must be 0 (water), 1 (soil and planting) or 2 (building).");
  if (head.skill && !SKILLS.has(head.skill.toLowerCase())) return no("its skill line must be entry, intermediate or advanced.");
  if (head.standard && !/^[a-z0-9_]{2,80}$/.test(head.standard)) return no("its standard line must be the board's own id in snake_case, like construction_site_safety (when the board refuses a post it lists the nearest ones).");
  if (head.expires && !(Number(head.expires) >= 1 && Number(head.expires) <= 365)) return no("its expires line must be a number of days from 1 to 365.");
  if (head.safety && head.safety.length > 600) return no("its safety line is longer than 600 characters. The board keeps no more, and clipped safety text is worse than none.");
  for (const f of flags) if (!FLAGS.has(f)) return no("a flag line takes permit-required (the work needs a permit) or regulated (it needs a licensed trade), nothing else.");
  // The steward's own place, with its map point written in the text so the board pins the post (the board's own convention, "words lat,lng").
  const point = config.lat !== undefined ? `${config.lat.toFixed(4)},${config.lng.toFixed(4)}` : "";
  const here = !point ? config.place : parsePlace(config.place) ? `Near ${point}` : `${config.place} ${point}`;
  const need = {
    title: title.slice(0, 200), description: description.slice(0, 4000), location: (head.place || here).slice(0, 300).trim(),
    proposedPayUsd: pay, workType: head.type === undefined || head.type === "" ? 1 : Number(head.type),
  };
  if (head.standard) need.standard = head.standard;
  if (head.skill) need.skillLevel = head.skill.toLowerCase();
  if (head.safety) need.safetyNotes = head.safety;
  if (head.expires) need.expiresInDays = Number(head.expires);
  if (proofs.length) { need.proofRequirements = proofs.slice(0, 20); need.proofRule = proofs.join(" + ").slice(0, 1000); }
  if (flags.length) need.flags = [...new Set(flags)];
  return { ok: true, need };
}

async function postOne(s, state, file) {
  const refuse = (why) => ({ status: "refused", words: `NOT POSTED: ${why}` });
  const parsed = parseNeed(file.text, s.config);
  if (!parsed.ok) return refuse(parsed.why);
  const { need } = parsed;
  const lower = file.text.toLowerCase();
  if (s.secrets.some((k) => lower.includes(k))) return refuse("it carries this steward's own wallet key. That never leaves this machine, so nothing was sent. Take it out of the file.");
  const contact = s.localContactCheck ? needContact(need) : null;
  if (contact) return refuse(`it carries ${contact.what} (in its ${contact.field}). A job is public, so contact details never go on the board. Take it out and save the file; the steward tries again when the file changes.`);
  if (s.live && postsInLastDay(state, s.now()) >= s.postsPerDay) {
    return { status: "waiting", words: `WAITING: this wallet has already posted ${s.postsPerDay} jobs in the last 24 hours, the free lane's limit. It will post this one when a slot frees up.` };
  }
  const prep = await door(s, "prepare_post_work", { creatorWallet: s.address, ...need });
  if (prep.isError) return refuse(`the board said: ${boardWords(prep.prose, 600)}`);
  const unplaced = /No map point yet/.test(prep.text) ? " The board cannot place that spot on a map yet, so a search by coordinates will not find it; add coordinates to the place line, like `place: Alvarado St gate 34.0600,-118.2600`." : "";
  const signing = checkedSigning(prep, "submit_post_work", "/labor/work", (body) => checkPostBody(body, need, s.address, s.now()));
  if (signing.why) return refuse(`the board handed back ${signing.why}, so nothing was signed and nothing was posted.`);
  if (!s.live) return { status: "dry", words: `WOULD POST (dry run, add --live to post): ${fence(need.title)} at ${fence(need.location)}, proposed pay $${need.proposedPayUsd.toFixed(2)}, proposed and not funded.${unplaced}` };
  // Written down BEFORE it is sent: a crash between the board's answer and the next save is found on the next look, and the board's
  // own one-job-per-title rule answers "Already on the board" instead of making a second job.
  const resumed = Object.hasOwn(state.pending, file.hash);
  state.pending[file.hash] = { at: iso(s.now()), title: need.title };
  saveState(s, state);
  const sub = await door(s, "submit_post_work", { bodyJson: JSON.stringify(signing.body), signature: await s.signer.sign(signing.message) });
  delete state.pending[file.hash];
  if (sub.isError && /signed_post_cap_reached/.test(sub.text)) return { status: "waiting", words: `WAITING: the board says this wallet reached the free lane's limit of ten posts in a day. ${boardWords(sub.prose, 300)}` };
  if (sub.isError) return refuse(`the board said: ${boardWords(sub.prose, 600)}`);
  const body = plain(sub.prose, 2000);
  if (!/(^|\n)\s*(Posted\.|Already on the board)/.test(body)) return refuse(`the board's answer was not a confirmation: ${boardWords(sub.prose, 300)}`);
  const workId = safeId(sub.sc.workId) ?? safeId(/\b(WORK_[A-Za-z0-9_-]+)/.exec(sub.text)?.[1]);
  const dupe = /^Already on the board/m.test(body);
  const at = iso(s.now());
  if (workId) {
    if (!dupe || resumed) state.posts.push({ at, workId, title: need.title }); // a job found again after a crash is this steward's own post
    if (!Object.hasOwn(state.postStatus, workId)) state.postStatus[workId] = { status: "OPEN", checkedAt: null };
    state.seen[workId] = { at, last: at, own: true }; // the owner's own post is not announced back as a new job
  }
  state.postedHashes[file.hash] = { workId, at, name: file.name };
  return { status: "posted", workId, words: `${dupe ? "ALREADY ON THE BOARD" : "POSTED"}: ${fence(need.title)}${workId ? ` (${workId})` : ""}, proposed pay $${need.proposedPayUsd.toFixed(2)}, proposed and not funded. You approve any proof for it yourself.${unplaced}` };
}

async function phaseNeeds(s, state, report) {
  const { items, ignored, present, skipped } = listNeedFiles(s.paths.needs);
  const told = new Set(state.ignored);
  for (const line of ignored) if (!told.has(line)) report.needs.push(`- ${line}`); // each ignored file is said once, not every half hour
  state.ignored = ignored.slice(0, 200);
  if (skipped) report.notes.push(`needs/ holds more than ${MAX_NEED_FILES} need files; the first ${MAX_NEED_FILES} by name are read each look and the rest wait.`);
  for (const file of items) {
    if (s.stopped) return;
    const prev = state.needs[file.name];
    const done = state.postedHashes[file.hash];
    if (done) { // the same words posted before, under this name or another: never posted twice
      if (!(prev?.hash === file.hash && prev.status === "posted")) {
        state.needs[file.name] = { hash: file.hash, status: "posted", at: iso(s.now()), workId: done.workId ?? null };
        report.needs.push(`- ${file.shown}: already posted${done.workId ? ` as ${done.workId}` : ""} (the same words were posted before), so it is not posted again.`);
      }
      continue;
    }
    if (prev?.hash === file.hash && (prev.status === "refused" || (prev.status === "dry" && !s.live))) continue;
    const res = await postOne(s, state, file);
    state.needs[file.name] = { hash: file.hash, status: res.status, at: iso(s.now()), workId: res.workId ?? null };
    if (!(res.status === "waiting" && prev?.status === "waiting" && prev.hash === file.hash)) report.needs.push(`- ${file.shown}: ${res.words}`);
  }
  for (const name of Object.keys(state.needs)) if (!present.has(name)) delete state.needs[name]; // a file taken away is forgotten (its words stay recorded if posted)
  // What happened to the jobs this steward posted: reads only. A proof on one of them is the owner's to accept or refuse.
  const open = Object.entries(state.postStatus).filter(([id, v]) => safeId(id) && v?.status !== "SETTLED" && v?.status !== "EXPIRED").sort((a, b) => String(a[1]?.checkedAt ?? "").localeCompare(String(b[1]?.checkedAt ?? ""))).slice(0, 6);
  for (const [workId, was] of open) {
    if (s.stopped) return;
    const rep = await door(s, "work_status", { workId });
    const status = rep.isError ? null : knownStatus(rep.sc.status);
    state.postStatus[workId] = { status: status ?? was?.status ?? "OPEN", checkedAt: iso(s.now()) };
    if (!status || status === was?.status) continue;
    const mine = state.posts.find((p) => p.workId === workId);
    const note = status === "PROOF_SUBMITTED" ? " A proof is waiting for YOU to accept or refuse, on the job's page. This steward never decides a proof." : "";
    report.needs.push(`- ${fence(mine?.title ?? workId)} (${workId}): now ${status} (${STATUS_WORDS[status]}).${note}`);
  }
}

// ── 3. the owner's own work ───────────────────────────────────────────────────────────────────────────────────────
/** A NEXT_CALL's arguments for a read: plain values only, its own wallet only, never a placeholder it would have to invent. */
function fillReadArgs(args, address) {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) return null;
  const out = {};
  for (const [k, v] of Object.entries(args).slice(0, 10)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(k)) return null;
    if (v === "YOUR_WALLET_ADDRESS") { out[k] = address; continue; }
    if (typeof v === "string") {
      if (v.length > 200 || (/^[A-Z][A-Z0-9_]{6,}$/.test(v) && !/^WORK_/.test(v))) return null;
      if (/wallet/i.test(k) && v.toLowerCase() !== address.toLowerCase()) return null; // a read of its own wallet only
      if (k === "workId" && !safeId(v)) return null;
      out[k] = v; continue;
    }
    if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean") { out[k] = v; continue; }
    return null;
  }
  return out;
}
function ownRow(r) {
  if (!r || typeof r !== "object") return null;
  const workId = safeId(r.workId);
  if (!workId) return null;
  return { workId, status: knownStatus(r.status), movedAt: typeof r.movedAt === "string" ? r.movedAt.slice(0, 40) : null, title: r.title, page: r.page,
    pay: r.pay && typeof r.pay === "object" ? r.pay : null, settlement: r.settlement && typeof r.settlement === "object" ? r.settlement : null, rejection: r.rejection && typeof r.rejection === "object" ? r.rejection : null };
}

async function phaseOwn(s, state, report) {
  const rep = await door(s, "my_work", { wallet: s.address });
  const sc = rep.sc;
  const list = (v) => (Array.isArray(v) ? v.slice(0, 100) : []);
  const rows = [...list(sc.waitingOnYou), ...list(sc.inReview), ...list(sc.settled)].map(ownRow).filter(Boolean);
  report.ownCount = rows.length;
  if (rep.isError) { report.notes.push(`my_work said: ${boardWords(rep.prose, 240)}`); return; }
  if (!Array.isArray(sc.waitingOnYou) && !rows.length) {
    if (sc.waitingOnYou !== undefined) report.notes.push("my_work answered in a shape the steward does not know, so nothing was read from it.");
    return;
  }
  const sig = createHash("sha256").update(JSON.stringify(rows.map((r) => [r.workId, r.status, r.movedAt]))).digest("hex").slice(0, 16);
  // NEXT_CALL, for read steps on its own work only: two hops at most, never twice the same call, never a write.
  const reads = []; const tried = new Set(); let cur = rep;
  for (let hop = 0; hop < 2 && rows.length && cur.next && READ_ONLY_FOLLOW.has(cur.next.tool); hop++) {
    const args = fillReadArgs(cur.next.args, s.address);
    const key = JSON.stringify([cur.next.tool, args]);
    if (!args || tried.has(key)) break;
    tried.add(key);
    const tool = cur.next.tool;
    cur = await door(s, tool, args);
    reads.push({ tool, rep: cur });
  }
  if (sig === state.ownSig) return;
  state.ownSig = sig;
  if (!rows.length) { report.own.push("This wallet has not claimed any job yet. Claim one yourself, on the job's page or with the Vealth client; this steward never claims for you."); return; }
  for (const r of rows) {
    const title = r.title ? fence(r.title) : r.workId;
    const pay = r.pay ? ` Pay: ${payWords({ payUsd: r.pay.postedUsd, funded: r.pay.funded, payModel: r.pay.payModel })}` : "";
    const usd = Number(r.settlement?.paymentUsd);
    const paid = r.status === "SETTLED" ? ` ${r.settlement?.paymentVerified === true && Number.isFinite(usd) ? `Paid $${usd.toFixed(2)}, the payment verified.` : "Settled, the payment is not verified yet."}` : "";
    const why = r.status === "PROOF_REJECTED" && r.rejection?.reason ? ` Reason given: ${fence(r.rejection.reason, 300)}.` : "";
    const where = r.status ? STATUS_WORDS[r.status] : "a status the steward does not know";
    report.own.push(`- ${title} (${r.workId}): ${where}.${why}${paid}${pay}\n  page: ${safePage(r.page, s.mcpUrl) ?? "the board gave no page link"}`);
  }
  for (const { tool, rep: got } of reads) {
    const id = safeId(got.sc.workId); const status = knownStatus(got.sc.status);
    if (tool === "work_status" && id && status) report.own.push(`  live status of ${id}: ${status}`);
  }
  report.own.push("This steward does not claim a job or hand in proof for you; that stays yours.");
}

// ── 4. the owner's votes ──────────────────────────────────────────────────────────────────────────────────────────
export function readVotesFile(file) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8").slice(0, 200_000); } catch { return []; }
  const ids = [];
  for (const line of raw.split(/\r?\n/)) {
    const id = line.replace(/#.*$/, "").trim();
    if (id && WORK_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, 1000);
}
const VOTE_REASON = "Marked by the person who runs this steward agent.";

async function phaseVotes(s, state, report) {
  const marked = readVotesFile(s.paths.votes);
  for (const book of [state.voteRefused, state.voteDry]) for (const id of Object.keys(book)) if (!marked.includes(id)) delete book[id]; // a line removed and added again is tried again
  let cast = 0;
  for (const id of marked) {
    if (s.stopped || cast >= s.maxVotes) break;
    if (Object.hasOwn(state.votes, id) || Object.hasOwn(state.voteRefused, id)) continue;
    if (!s.live) {
      if (!Object.hasOwn(state.voteDry, id)) { state.voteDry[id] = true; report.votes.push(`- WOULD VOTE for ${id} (dry run, add --live to vote). Free, recorded as an agent vote.`); cast += 1; }
      continue;
    }
    const prep = await door(s, "prepare_vote", { workId: id, voterWallet: s.address, stance: "for", voterKind: "agent", reason: VOTE_REASON });
    let words = prep.isError ? `the board said: ${boardWords(prep.prose, 400)}` : null;
    if (!words) {
      const signing = checkedSigning(prep, "submit_vote", `/labor/work/${id}/vote`, (body) => checkVoteBody(body, s.address, VOTE_REASON, s.now()));
      if (signing.why) words = `the board handed back ${signing.why}, so nothing was signed`;
      else {
        const sub = await door(s, "submit_vote", { workId: id, bodyJson: JSON.stringify(signing.body), signature: await s.signer.sign(signing.message) });
        if (!sub.isError && /Vote recorded/.test(sub.text)) { state.votes[id] = { at: iso(s.now()) }; report.votes.push(`- VOTED for ${id}, free, as an agent vote.`); cast += 1; continue; }
        words = `the board said: ${boardWords(sub.prose, 400)}`;
      }
    }
    state.voteRefused[id] = { at: iso(s.now()) };
    report.votes.push(`- NOT VOTED for ${id}: ${words}`);
  }
}

// ── one look, and the loop ────────────────────────────────────────────────────────────────────────────────────────
export async function runLook(s) {
  s.calls = 0;
  const state = loadState(s);
  const report = { at: iso(s.now()), jobs: [], jobsWaiting: 0, jobsOpen: 0, jobsFiltered: 0, jobsMore: false, needs: [], own: [], ownCount: 0, votes: [], notes: [], backoff: null, failed: null };
  if (state.note) report.notes.push(state.note);
  try {
    await phaseJobs(s, state, report);
    await phaseNeeds(s, state, report);
    await phaseOwn(s, state, report);
    await phaseVotes(s, state, report);
  } catch (e) {
    if (e instanceof StopLook) {
      report.notes.push(e.backoff ? `The door asked the steward to wait (${e.message}). Backing off.` : e.message);
      if (e.backoff) report.backoff = { why: e.message, status: e.status, retryAfter: e.retryAfter };
    } else { // never a crash: a look that went wrong is said, and the loop backs off and tries again
      report.failed = s.out.hide(String(e?.message ?? e)).slice(0, 300);
      report.notes.push(`Something went wrong in this look (${safeName(report.failed)}). The steward keeps running and tries again later.`);
    }
  } finally {
    state.lastLookAt = report.at;
    state.backoffUntil = report.backoff?.retryAfter > 0 ? iso(s.now() + Math.min(3600, report.backoff.retryAfter) * 1000) : null;
    try { saveState(s, state); } catch (e) { report.failed ??= "state.json could not be written"; report.notes.push(`state.json could not be written (${safeName(String(e?.code ?? e?.message ?? e))}).`); }
  }
  const sections = [];
  const watching = s.config.kinds?.length ? ` (only work matching ${s.config.kinds.join(", ")})` : "";
  if (report.jobs.length) sections.push(`### New jobs near ${scrub(s.config.place)}${watching} (${report.jobs.length})\n\n${report.jobs.map((j) => jobBlock(j, s)).join("\n\n")}${report.jobsWaiting ? `\n\n${report.jobsWaiting} more new jobs will be listed at the next look.` : ""}`);
  if (report.needs.length) sections.push(`### Your needs\n\n${report.needs.join("\n")}`);
  if (report.own.length) sections.push(`### Your own work (this wallet)\n\n${report.own.join("\n")}`);
  if (report.votes.length) sections.push(`### Votes\n\n${report.votes.join("\n")}`);
  if (report.notes.length) sections.push(`### Notes\n\n${report.notes.map((n) => `- ${n}`).join("\n")}`);
  if (sections.length) {
    const text = `## ${report.at.slice(0, 16).replace("T", " ")} UTC, ${scrub(s.config.place)}${s.live ? "" : " (dry run)"}\n\n${sections.join("\n\n")}\n`;
    s.say(text);
    try { appendRotating(s.paths.digest, `${s.out.hide(text)}\n`); } catch (e) { s.say(`steward: digest.md could not be written (${safeName(String(e?.code ?? e))}).`); }
  }
  const open = `${report.jobsOpen}${report.jobsMore ? "+" : ""}`;
  const skipped = report.jobsFiltered ? `, ${report.jobsFiltered} more left out as not matching ${s.config.kinds.join(", ")}` : "";
  report.summary = `look at ${report.at.slice(0, 16).replace("T", " ")} UTC. New jobs: ${report.jobs.length} (${open} open near the place${skipped}). Need notes: ${report.needs.length}. Claimed by this wallet: ${report.ownCount}. Votes: ${report.votes.length}.${report.backoff ? " The door asked the steward to wait." : ""}${report.failed ? " The look went wrong; it will be tried again." : ""}`;
  return report;
}

/** Seconds to wait after the nth failure in a row: what the door asked for, or 1, 2, 4, 8 minutes and so on, never more than an hour. */
export function backoffSeconds(failures, retryAfter = 0, jitter = 0) {
  const base = Math.min(3600, 60 * 2 ** Math.max(0, failures - 1));
  return Math.ceil(Math.min(3600, Math.max(retryAfter, base)) * (1 + 0.1 * jitter));
}

/** What a monitor or a person reads to know the steward is alive: written after every look and when it stops. */
function writeHeartbeat(s, fields) {
  const state = readJson(s.paths.state, {});
  s.heartbeat = {
    ...s.heartbeat, schema: "vealth-steward-heartbeat-v1", version: VERSION, pid: process.pid, address: s.address, place: s.config.place, radiusKm: s.config.radiusKm,
    intervalMinutes: s.config.intervalMinutes, door: s.mcpUrl, mode: s.live ? "live" : "dry", startedAt: s.startedAt ?? null, ...(s.config.kinds?.length ? { kinds: s.config.kinds } : {}), ...fields,
    postsLast24h: postsInLastDay({ posts: Array.isArray(state.posts) ? state.posts : [], pending: state.pending ?? {} }, s.now()), postCap: s.postsPerDay, updatedAt: iso(s.now()),
  };
  try { writeJsonAtomic(s.paths.heartbeat, s.heartbeat); } catch { /* a heartbeat that cannot be written never stops the steward */ }
}

/** In --once mode (a scheduler starts it): skip a look the door asked to wait for, or one too soon after the last. */
function onceGate(s) {
  const st = readJson(s.paths.state, {});
  const until = Date.parse(st.backoffUntil ?? "");
  if (Number.isFinite(until) && until > s.now()) return `the door asked the steward to wait until ${iso(until).slice(0, 16).replace("T", " ")} UTC, so this run does not look.`;
  const last = Date.parse(st.lastLookAt ?? "");
  if (Number.isFinite(last) && s.now() - last < MIN_INTERVAL_MINUTES * 60_000 && s.now() >= last) return `the last look was less than ${MIN_INTERVAL_MINUTES} minutes ago (looks are at least ${MIN_INTERVAL_MINUTES} minutes apart), so this run does not look.`;
  return null;
}

export async function runLoop(s, { once = false, maxLooks = Infinity } = {}) {
  let failures = 0; let looks = 0; let because = null;
  s.startedAt ??= iso(s.now());
  for (let n = 1; n <= maxLooks && !s.stopped; n++) {
    const stop = stopFileFound(s);
    if (stop) { because = `the stop file ${stop}`; s.say(`steward: the stop file ${stop} is there, so the steward does not look. Delete it to start again.`); break; }
    const gate = once ? onceGate(s) : null;
    if (gate) { because = "nothing due"; s.say(`steward: ${gate}`); break; }
    const report = await runLook(s);
    looks += 1;
    s.say(`steward: ${report.summary}`);
    const bad = Boolean(report.backoff) || Boolean(report.failed);
    failures = bad ? failures + 1 : 0;
    const wait = bad ? backoffSeconds(failures, report.backoff?.retryAfter ?? 0, s.jitter()) : s.config.intervalMinutes * 60;
    const last = once || n >= maxLooks || s.stopped;
    writeHeartbeat(s, { lastLookAt: report.at, lastLook: report.failed ? "failed" : report.backoff ? "backed off" : "ok", lastLookSummary: report.summary, failuresInARow: failures, nextLookAt: last ? null : iso(s.now() + wait * 1000), stoppedAt: null, stoppedBecause: null });
    if (last) break;
    s.say(`steward: next look in ${wait >= 120 ? `${Math.round(wait / 60)} minutes` : `${wait} seconds`}${bad ? " (backing off)" : ""}. Stop it with Ctrl-C, or create the file ${s.paths.stop}.`);
    await s.wait(wait * 1000);
  }
  because ??= s.stopped ? (s.stopReason ?? "a stop signal") : once ? "one look (--once)" : "done";
  writeHeartbeat(s, { nextLookAt: null, stoppedAt: iso(s.now()), stoppedBecause: because });
  return { looks, because };
}

// ── the lock and the status ───────────────────────────────────────────────────────────────────────────────────────
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}
function readLock(file) {
  const raw = readText(file);
  let held = null; try { held = JSON.parse(raw); } catch { /* 0.1.0 wrote the bare pid */ }
  if (typeof held === "number") held = { pid: held };
  if (!held || typeof held !== "object") held = { pid: Number(raw) || null };
  let age = Infinity; try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { /* gone */ }
  return { pid: held.pid, age };
}
/** Take the folder: refused only while another live steward touched the lock in the last five minutes. A pid reused after a reboot is not a steward. */
export function takeLock(file) {
  const mine = JSON.stringify({ pid: process.pid, token: randomBytes(8).toString("hex"), at: new Date().toISOString() });
  try { fs.writeFileSync(file, mine, { flag: "wx", mode: 0o600 }); return true; } catch { /* held, or left behind */ }
  const held = readLock(file);
  if (held.pid !== process.pid && pidAlive(held.pid) && held.age < LOCK_FRESH_MS) return false;
  writeFileAtomic(file, mine);
  return readText(file) === mine;
}
function refreshLock(s) { if (!s.lockFile) return; try { const t = new Date(); fs.utimesSync(s.lockFile, t, t); } catch { /* gone */ } }
function releaseLock(file) { if (readLock(file).pid === process.pid) { try { fs.unlinkSync(file); } catch { /* gone */ } } }

/** Where the steward stands, from its own files: what it watches, its last and next look, today's posts, its address, whether it runs. */
export function statusOf(dir, extraStopFiles = []) {
  const p = pathsOf(dir);
  const config = readJson(p.config, null);
  if (!config) return { dir, setUp: false };
  const state = readJson(p.state, {});
  const hb = readJson(p.heartbeat, null);
  const lock = readLock(p.lock);
  const running = exists(p.lock) && pidAlive(lock.pid) && lock.age < LOCK_FRESH_MS;
  const now = Date.now();
  return {
    dir, setUp: true, version: VERSION, address: readText(p.address).trim() || null, place: config.place, radiusKm: config.radiusKm, intervalMinutes: config.intervalMinutes,
    ...(Array.isArray(config.kinds) && config.kinds.length ? { kinds: config.kinds } : {}), door: config.mcpUrl, mode: hb?.mode ?? null, running, pid: running ? lock.pid : null, lastLookAt: state.lastLookAt ?? hb?.lastLookAt ?? null,
    lastLook: hb?.lastLook ?? null, lastLookSummary: hb?.lastLookSummary ?? null, nextLookAt: running ? hb?.nextLookAt ?? null : null, stoppedBecause: running ? null : hb?.stoppedBecause ?? null,
    postsLast24h: postsInLastDay({ posts: Array.isArray(state.posts) ? state.posts : [], pending: state.pending ?? {} }, now), postCap: POSTS_PER_DAY,
    votesCast: Object.keys(state.votes ?? {}).length, jobsSeen: Object.keys(state.seen ?? {}).length, backoffUntil: state.backoffUntil ?? null,
    stopFile: [p.stop, ...extraStopFiles.map((f) => path.resolve(f))].find((f) => exists(f)) ?? null, digest: p.digest, log: p.log, heartbeat: p.heartbeat, heartbeatAt: hb?.updatedAt ?? null,
  };
}
const when = (v) => (v ? `${String(v).slice(0, 16).replace("T", " ")} UTC` : null);
export function statusText(st) {
  if (!st.setUp) return `No steward is set up in ${st.dir}.`;
  const next = st.stopFile ? `none: the stop file ${st.stopFile} is there (delete it to start again)` : st.running ? (when(st.nextLookAt) ?? "after the look it is on") : st.stoppedBecause === "one look (--once)" || st.stoppedBecause === "nothing due" ? "when its schedule starts it again (it runs one look at a time)" : "none: it is not running";
  return [
    `Steward ${st.version} in ${st.dir}`,
    `  watching: ${st.place}, within ${st.radiusKm} km, a look every ${st.intervalMinutes} minutes`,
    ...(st.kinds?.length ? [`  only work matching: ${st.kinds.join(", ")} (change it with --kind, or --kind all to watch everything)`] : []),
    `  door: ${st.door}${st.door === DEFAULT_MCP_URL ? "" : " (not the public Vealth door)"}`,
    `  wallet: ${st.address ?? "not made yet"}`,
    `  mode: ${st.mode === "live" ? "live (it posts your needs and casts your votes)" : st.mode === "dry" ? "dry (it shows what it would post and vote, and does neither)" : "not run yet"}`,
    `  running: ${st.running ? `yes, pid ${st.pid}` : `no${st.stoppedBecause ? `, it stopped (${st.stoppedBecause})` : ""}`}`,
    `  last look: ${when(st.lastLookAt) ?? "none yet"}${st.lastLook ? `, ${st.lastLook}` : ""}`,
    `  next look: ${next}`,
    ...(st.backoffUntil && Date.parse(st.backoffUntil) > Date.now() ? [`  the door asked it to wait until ${when(st.backoffUntil)}`] : []),
    `  posts in the last 24 hours: ${st.postsLast24h} of ${st.postCap}; votes cast: ${st.votesCast}; jobs seen: ${st.jobsSeen}`,
    `  digest: ${st.digest}`,
    `  log: ${st.log}`,
  ].join("\n");
}

// ── the command line ──────────────────────────────────────────────────────────────────────────────────────────────
class UsageError extends Error {}
const BOOLEAN_FLAGS = new Set(["live", "once", "help", "version", "json"]);
const VALUE_FLAGS = new Set(["dir", "place", "lat", "lng", "radius", "interval", "mcp-url", "max-new", "pace-ms", "stop-file", "house", "kind"]);
export function parseArgs(argv) {
  const out = { command: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      if (!out.command) { out.command = a; continue; }
      throw new UsageError(`Unexpected word "${safeName(a).slice(0, 40)}". Options start with --; run with --help to see them.`);
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name)) { out.flags[name] = true; continue; }
    if (!VALUE_FLAGS.has(name)) throw new UsageError(`Unknown option --${safeName(name).slice(0, 30)}. Run with --help to see the options.`);
    const value = inline ?? argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError(`--${name} needs a value.`);
    if (name === "stop-file" || name === "kind") (out.flags[name] ??= []).push(value); else out.flags[name] = value;
  }
  return out;
}
function numFlag(name, raw, min, max) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (String(raw).trim() === "" || !Number.isFinite(n) || n < min || n > max) throw new UsageError(`--${name} must be a number from ${min} to ${max} (it was "${safeName(String(raw)).slice(0, 20)}").`);
  return n;
}
export const HELP = `vealth steward ${VERSION}: keeps provisioning one place through ${DEFAULT_MCP_URL}, forever, on your own machine.

  node steward.mjs run --place "Boyle Heights, Los Angeles, CA" --radius 5     first time: makes your wallet, then looks
  node steward.mjs run --live                                                  later: act (post your needs, cast your votes)
  node steward.mjs run --once                                                  one look, then stop (for a scheduler)
  node steward.mjs run --kind "fire,ember zone"                                watch only work whose title, proof line or work type carries those words
  node steward.mjs setup --lat 34.03 --lng -118.21 --radius 5                  set the place and make the wallet, no look
  node steward.mjs status [--json]                                             where things stand
  node steward.mjs address                                                     your wallet's public address

  --dir <folder>        the steward's folder (default ~/.vealth-steward, or VEALTH_STEWARD_HOME)
  --kind <words>        watch only one kind of work: words separated by commas (up to ${MAX_KINDS}); saved with the place; --kind all watches everything again
  --interval <min>      minutes between looks (default 30, at least ${MIN_INTERVAL_MINUTES})
  --mcp-url <url>       the door (default ${DEFAULT_MCP_URL}); https only
  --max-new <n>         new jobs listed per look (default 15)
  --pace-ms <ms>        pause between calls to the door (default 1250, at least 1000 for a door that is not this computer)
  --stop-file <path>    one more stop file to honour before every look (the folder's STOP is always honoured)
  --house <label>       mark these calls as Vealth's own, for the people who run vealth.net, so they are never counted as outside demand

Without --live nothing is posted and nothing is voted: it prints what it would do. It never pays, claims, hands in proof or
decides one. Stop it with Ctrl-C, or create the file STOP in its folder (it stays stopped until you delete the file).`;

async function askForPlace() {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const place = (await rl.question("Which place will you steward? A name (Boyle Heights, Los Angeles, CA) or lat,lng: ")).trim();
    const radius = (await rl.question("How far around it, in km? [10] ")).trim();
    return { place, radiusKm: radius ? numFlag("radius", radius, 0.1, 200) : undefined };
  } finally { rl.close(); }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const say = io.say ?? ((t) => process.stdout.write(`${t}\n`));
  const shown = makeOut([]);
  let command; let flags; let given; let maxNew; let paceMs;
  try {
    ({ command, flags } = parseArgs(argv));
    if (flags.help || command === "help") { say(HELP); return 0; }
    if (flags.version) { say(VERSION); return 0; }
    if (flags.house !== undefined && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(flags.house)) throw new UsageError("--house takes a short label of lowercase letters, digits and dashes.");
    given = {
      dir: homeDir(flags.dir), place: flags.place, lat: numFlag("lat", flags.lat, -90, 90), lng: numFlag("lng", flags.lng, -180, 180),
      radiusKm: numFlag("radius", flags.radius, 0.1, 200), intervalMinutes: numFlag("interval", flags.interval, MIN_INTERVAL_MINUTES, 1440), mcpUrl: flags["mcp-url"],
    };
    maxNew = numFlag("max-new", flags["max-new"], 1, 100);
    paceMs = numFlag("pace-ms", flags["pace-ms"], 0, 60_000);
    if (flags.kind !== undefined) {
      try { given.kinds = parseKinds(flags.kind); } catch (e) { throw new UsageError(`--kind: ${e.message}`); }
    }
  } catch (e) {
    if (e instanceof UsageError) { say(e.message); return 2; }
    throw e;
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") { say("NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks for every https call, so a stranger could pose as the door. The steward does not run that way; unset it and start again."); return 2; }
  const p = pathsOf(given.dir);
  const stopFiles = flags["stop-file"] ?? [];
  try {
    if (command === "address") { say(readText(p.address).trim() || "No steward is set up here yet."); return 0; }
    if (command === "status") { const st = statusOf(given.dir, stopFiles); say(flags.json ? JSON.stringify(st, null, 2) : statusText(st)); return 0; }
    if (command && !["run", "setup"].includes(command)) { say(`Unknown command "${safeName(command).slice(0, 40)}".\n\n${HELP}`); return 2; }
    if (command !== "setup") {
      const stop = [p.stop, ...stopFiles.map((f) => path.resolve(f))].find((f) => exists(f));
      if (stop) { say(`steward: the stop file ${stop} is there, so the steward does not start. Delete it to start again.`); return 0; } // exit 0: a service that restarts on failure leaves it stopped
    }
    const configured = exists(p.config) && exists(p.key);
    const asked = given.place !== undefined || given.lat !== undefined;
    if (!configured && !asked) {
      if (!process.stdin.isTTY) { say('No place yet. Run: node steward.mjs run --place "Your Place" --radius 5'); return 2; }
      Object.assign(given, await askForPlace());
    }
    if (!configured || command === "setup" || asked || given.kinds !== undefined) await setupSteward(given, say);
    if (command === "setup") return 0;
    const s = await openSteward({ ...given, live: flags.live, maxNew, paceMs, stopFiles, house: flags.house });
    if (s.mcpUrl !== DEFAULT_MCP_URL) say(`steward: note, this steward talks to ${s.mcpUrl}, not ${DEFAULT_MCP_URL}. It signs only the posts and votes it checked itself, but the words it shows come from that door.`);
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22) say(`steward: note, Node ${process.versions.node} no longer gets security fixes. Use Node 22 or newer for a program that runs for months.`);
    if (!takeLock(p.lock)) { say(`Another steward is already running in ${given.dir}. Two at once would post and vote twice. Stop it first.`); return 1; }
    s.lockFile = p.lock;
    const ac = new AbortController();
    s.signal = ac.signal;
    const release = () => releaseLock(p.lock);
    process.once("exit", release);
    for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { s.stopped = true; s.stopReason = `a ${sig} signal`; ac.abort(); s.say("steward: stopping after the step it is on."); process.once(sig, () => process.exit(130)); });
    say(`steward ${VERSION}: ${s.live ? "LIVE, it will post your needs and cast your votes" : "DRY, it prints what it would post and vote (add --live to act)"}. Wallet ${s.address}.`);
    await runLoop(s, { once: Boolean(flags.once) });
    release();
    return s.heartbeat.lastLook === "failed" ? 1 : 0; // a look that backed off is the door's normal answer, not a failure
  } catch (e) {
    say(`steward: ${shown.hide(String(e?.message ?? e))}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { process.stdout.write(`steward: ${makeOut([]).hide(String(e?.message ?? e))}\n`); process.exitCode = 1; });
}
