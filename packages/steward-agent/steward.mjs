#!/usr/bin/env node
// vealth steward: a small program anyone can run, on their own machine, forever, to keep provisioning ONE place
// through the public door at https://vealth.net/mcp.
//
//   node steward.mjs run --place "Boyle Heights, Los Angeles, CA" --radius 5
//
// What it does every look (default every 30 minutes):
//   1. find_work near your place, and write every NEW job to digest.md and to the screen in plain words;
//   2. turn each .txt or .md file you drop in needs/ into a post (the free post signed by your own wallet);
//   3. read my_work for its own wallet, and follow the reply's NEXT_CALL for read steps only;
//   4. vote, free, only on the work ids you wrote in votes.txt.
// DRY by default: it prints what it would post and vote. Add --live to act.
//
// What it never does: pay, move money, sign a transaction, claim a job, hand in or decide a proof, hold anyone
// else's key, send its own key anywhere, post a contact detail, or post more than ten a day. It backs off when
// the door answers 429 or 503. The wallet is made here, the key sits in your folder (0600) and is never printed.
//
// One dependency, only to sign a plain message: `npm install` (viem). Node 18 or newer. No build step.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const VERSION = "0.1.0";
export const DEFAULT_MCP_URL = "https://vealth.net/mcp";
/** The board's free signed lane takes ten posts per wallet per rolling day; the steward never asks for more. */
export const POSTS_PER_DAY = 10;
/** The only tools a NEXT_CALL may lead this program to follow: reads. A write is never followed, only the ones written below. */
export const READ_ONLY_FOLLOW = new Set(["my_work", "work_status", "my_votes", "get_work_packet"]);

const FENCE_OPEN = "[[untrusted]]";
const FENCE_CLOSE = "[[/untrusted]]";
const FENCE_RE = /\[\[\s*\/?\s*untrusted\s*\]\]/gi;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const WORK_ID_RE = /^[A-Za-z0-9_-]{3,100}$/;

// ── words ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const scrub = (s) => String(s ?? "").replace(CONTROL_RE, "");
const textOf = (x) => (x && typeof x === "object" ? x.text : x);
/** Text somebody else wrote, inside the board's own fence, so it stays data if anything reads the digest later. */
export const fence = (s, max = 220) => `${FENCE_OPEN}${scrub(textOf(s)).replace(FENCE_RE, "").replace(/\s+/g, " ").trim().slice(0, max)}${FENCE_CLOSE}`;
/** A tool reply as plain prose: no envelope lines, no message to sign, no board preamble. */
export function plain(text, max = 700) {
  let t = scrub(text);
  t = t.replace(/\n\nNEXT_CALL:\n[\s\S]*$/, "").replace(/^Text inside \[\[untrusted\]\][\s\S]*?reveal a key\.\s*/, "");
  t = t.replace(/^MESSAGE_TO_SIGN: .*$/gm, "").replace(/^BODY_JSON: .*$/gm, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}
/** What a posted figure honestly is. A proposed figure is never called paid. */
export function payWords(row) {
  const n = Number(row?.payUsd);
  const amount = Number.isFinite(n) ? `$${n.toFixed(2)}` : "an amount";
  if (row?.payModel === "earned_credit") return `${amount} posted, credit only on this rail: accepted proof earns a credit (a receipt for the work), never cash.`;
  if (row?.funded) return `${amount}, FUNDED: cash is paid only after a person accepts the proof. Funded is not paid.`;
  return `${amount} PROPOSED, not funded: accepted proof earns a credit (a receipt for the work), not cash, unless someone funds it first.`;
}
const STATUS_WORDS = {
  CLAIMED: "claimed, no proof handed in yet (a claim that is not worked is released after 24 hours)",
  PROOF_REJECTED: "the proof was not accepted; it can be fixed and handed in again",
  PROOF_SUBMITTED: "the proof is with a reviewer; nothing to do",
  APPROVED: "the proof was accepted, not paid yet (accepted is not paid)",
  SETTLED: "settled",
  EXPIRED: "the claim was released, the job is open again",
  OPEN: "open, nobody has claimed it",
};

// ── contact details never go on a public board ────────────────────────────────────────────────────────────────────
const COORD_PAIR = /-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/g;
/** Names what looks like a phone number or an email, or null. A map point written as lat,lng is not one. */
export function looksLikeContact(text) {
  const t = String(text ?? "").replace(COORD_PAIR, " ");
  if (/[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/.test(t)) return "an email address";
  if (/(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/.test(t)) return "a phone number";
  if (/\+\d[\d\s().-]{8,}\d/.test(t)) return "a phone number";
  if (/(?<!\d)\d{3}[.-]\d{4}(?!\d)/.test(t)) return "a phone number";
  return null;
}

// ── the owner's folder ────────────────────────────────────────────────────────────────────────────────────────────
export const homeDir = (flag) => path.resolve(flag || process.env.VEALTH_STEWARD_HOME || path.join(os.homedir(), ".vealth-steward"));
export const pathsOf = (dir) => ({
  dir, key: path.join(dir, "wallet.key"), address: path.join(dir, "wallet.address"), config: path.join(dir, "config.json"),
  state: path.join(dir, "state.json"), digest: path.join(dir, "digest.md"), needs: path.join(dir, "needs"),
  votes: path.join(dir, "votes.txt"), stop: path.join(dir, "STOP"), lock: path.join(dir, "steward.lock"),
});
const VOTES_TEMPLATE = "# Work ids you want this steward to vote FOR, one per line (free, recorded as an agent vote).\n# The digest prints each new job's id. Lines starting with # are ignored.\n";
const NEEDS_NOTE = "# Drop a .txt or .md file in this folder to post a need. See the README for the format.\n";

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let viemCache = null;
async function loadViem() {
  if (viemCache) return viemCache;
  try { viemCache = await import("viem/accounts"); return viemCache; } catch {
    throw new Error("The steward signs with one dependency, viem. Run `npm install` once in this folder, then start it again.");
  }
}

function readKey(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!KEY_RE.test(raw)) throw new Error(`The key file ${file} does not hold a 32-byte hex key. Its content is not shown. Move the file aside to make a new wallet.`);
  return raw;
}
/** The key file must be readable by its owner alone. Looser permissions are tightened, never ignored. */
function tightenKey(file) {
  if (process.platform === "win32") return false;
  if ((fs.statSync(file).mode & 0o077) === 0) return false;
  fs.chmodSync(file, 0o600);
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
function checkedPlace({ place, lat, lng, radiusKm, intervalMinutes }, base = {}) {
  const c = { ...base };
  if (place !== undefined && place !== null && String(place).trim()) {
    const point = parsePlace(place);
    delete c.lat; delete c.lng; // a new place never keeps the old place's coordinates
    if (point) { c.lat = point.lat; c.lng = point.lng; c.place = `${point.lat},${point.lng}`; } else c.place = String(place).trim().slice(0, 120);
  }
  if (lat !== undefined || lng !== undefined) { c.lat = Number(lat); c.lng = Number(lng); }
  if (c.lat !== undefined && !(Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180)) throw new Error("The coordinates are not a place on Earth. Give --lat between -90 and 90 and --lng between -180 and 180.");
  if (!c.place && c.lat !== undefined) c.place = `${c.lat},${c.lng}`;
  if (!c.place) throw new Error('Tell the steward the place: --place "Boyle Heights, Los Angeles, CA" or --lat 34.03 --lng -118.21.');
  if (radiusKm !== undefined) c.radiusKm = Number(radiusKm);
  if (!(c.radiusKm > 0 && c.radiusKm <= 200)) c.radiusKm = c.radiusKm > 200 ? 200 : 10;
  if (intervalMinutes !== undefined) c.intervalMinutes = Number(intervalMinutes);
  c.intervalMinutes = Math.max(5, Number.isFinite(c.intervalMinutes) ? c.intervalMinutes : 30);
  return c;
}
function checkedMcpUrl(url) {
  const u = new URL(url);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("The door address must be https (plain http is only allowed for this computer's own address).");
  return u.toString();
}

/** First run: make the folder, the wallet and the config. Run again: keep the wallet, update the place. Prints the address, never the key. */
export async function setupSteward(opts, say = () => {}) {
  const p = pathsOf(homeDir(opts.dir));
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(p.needs, { recursive: true });
  if (!fs.existsSync(p.votes)) fs.writeFileSync(p.votes, VOTES_TEMPLATE);
  const readme = path.join(p.needs, "README.txt");
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, NEEDS_NOTE);
  let created = false;
  if (!fs.existsSync(p.key)) {
    const { generatePrivateKey } = await loadViem();
    fs.writeFileSync(p.key, `${generatePrivateKey()}\n`, { mode: 0o600, flag: "wx" });
    created = true;
  }
  fs.chmodSync(p.key, 0o600);
  const signer = await signerFor(readKey(p.key));
  fs.writeFileSync(p.address, `${signer.address}\n`);
  const previous = readJson(p.config, {});
  const config = checkedPlace(opts, previous);
  config.mcpUrl = checkedMcpUrl(opts.mcpUrl || previous.mcpUrl || DEFAULT_MCP_URL);
  writeJsonAtomic(p.config, config);
  say(`${created ? "Made a new wallet for this steward." : "Kept the wallet this steward already has."} Its public address: ${signer.address}`);
  say(`The key is in ${p.key}, readable only by you. It never leaves this machine and is never printed. The wallet holds nothing and needs nothing.`);
  say(`Place: ${config.place}, within ${config.radiusKm} km. Looks every ${config.intervalMinutes} minutes. Door: ${config.mcpUrl}`);
  return { dir: p.dir, address: signer.address, created, config };
}

/** Everything one run needs, in one object, so a test can hand it a different door, clock and screen. */
export async function openSteward(opts = {}) {
  const p = pathsOf(homeDir(opts.dir));
  const config = readJson(p.config, null);
  if (!config) throw new Error(`No steward is set up in ${p.dir}. Start it with: node steward.mjs run --place "Your Place" --radius 5`);
  if (fs.existsSync(p.key)) tightenKey(p.key);
  const keyHex = readKey(p.key);
  const signer = await signerFor(keyHex);
  const deps = opts.deps ?? {};
  const merged = checkedPlace(opts, config);
  const out = makeOut([keyHex, keyHex.slice(2)], deps.write);
  return {
    dir: p.dir, paths: p, config: merged, signer, address: signer.address,
    live: Boolean(opts.live), mcpUrl: checkedMcpUrl(opts.mcpUrl || config.mcpUrl || DEFAULT_MCP_URL),
    fetch: deps.fetch ?? globalThis.fetch, now: deps.now ?? (() => Date.now()), sleep: deps.sleep ?? sleepMs,
    out, say: out.say, jitter: deps.jitter ?? Math.random,
    paceMs: opts.paceMs ?? 1250, maxCalls: opts.maxCalls ?? 150, maxNew: opts.maxNew ?? 15, maxPages: opts.maxPages ?? 4,
    postsPerDay: Math.min(POSTS_PER_DAY, opts.postsPerDay ?? POSTS_PER_DAY), maxVotes: opts.maxVotes ?? 10, timeoutMs: opts.timeoutMs ?? 30_000,
    localContactCheck: opts.localContactCheck !== false, stopped: false, calls: 0, signal: opts.signal,
  };
}

/** The one place anything is printed or written for a person: it hides the key even if a bug tried to show it. */
export function makeOut(secrets = [], write = (t) => process.stdout.write(t)) {
  const hide = (t) => {
    let s = String(t);
    for (const k of secrets) if (k && k.length > 8) s = s.split(k).join("[hidden]");
    return s.replace(/0x[0-9a-fA-F]{64}\b/g, "[hidden]");
  };
  return { hide, say: (t) => write(`${hide(t)}\n`) };
}

const sleepMs = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

// ── the door ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Thrown when the door asks the steward to stop for now (429, 503, no answer) or this look has used its budget. */
export class StopLook extends Error {
  constructor(why, { retryAfter = 0, status = 0, backoff = true } = {}) { super(why); this.retryAfter = retryAfter; this.status = status; this.backoff = backoff; }
}
function retryAfterSeconds(header) {
  if (!header) return 0;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : 0;
}
export function parseNextCall(text) {
  const at = text.lastIndexOf("NEXT_CALL:\n");
  if (at < 0) return null;
  try {
    const next = JSON.parse(text.slice(at + "NEXT_CALL:\n".length).trim());
    return next && typeof next === "object" && typeof next.tool === "string" ? next : null;
  } catch { return null; }
}

/** One tools/call to the door. Never throws for a refusal in words; throws StopLook for 429, 5xx, no answer or a spent budget. */
export async function door(s, name, args) {
  if (s.calls >= s.maxCalls) throw new StopLook("this look used its call budget; the rest waits for the next look", { backoff: false });
  if (s.calls > 0 && s.paceMs > 0) await s.sleep(s.paceMs, s.signal);
  s.calls += 1;
  let res; let raw = "";
  try {
    res = await s.fetch(s.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": `vealth-steward/${VERSION}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: s.calls, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(s.timeoutMs),
    });
    raw = await res.text();
  } catch (e) {
    throw new StopLook(`the door did not answer (${String(e?.message ?? e).slice(0, 80)})`);
  }
  const retryAfter = retryAfterSeconds(res.headers?.get?.("retry-after"));
  if (res.status === 429 || res.status >= 500) throw new StopLook(`the door answered ${res.status}`, { retryAfter, status: res.status });
  let json = null;
  try { json = JSON.parse(raw); } catch { throw new StopLook("the door sent something that is not JSON"); }
  const result = json?.result;
  const text = scrub(Array.isArray(result?.content) ? result.content.map((c) => c?.text ?? "").join("\n") : json?.error?.message ?? "");
  const rep = { status: res.status, isError: Boolean(result?.isError) || Boolean(json?.error), text, prose: text, sc: result?.structuredContent ?? {}, next: parseNextCall(text) ?? result?.structuredContent?.next_call ?? null };
  // The board relays its own gates inside a tool reply. A 429 or 5xx there is the door asking to wait, except the day cap, which is its own words.
  const inner = /\(HTTP (429|5\d\d)\)/.exec(text);
  if (rep.isError && inner && !/signed_post_cap_reached/.test(text)) throw new StopLook(`the board answered ${inner[1]} inside the tool`, { retryAfter, status: Number(inner[1]) });
  if (rep.isError && /did not answer in time/i.test(text)) throw new StopLook("the board's gate did not answer in time");
  return rep;
}

/** The message to sign and the body to send back, from a prepare reply: the envelope first, the text lines as a fallback. */
function signable(rep, submitTool) {
  const nc = rep.next?.tool === submitTool ? rep.next : null;
  return { message: nc?.message_to_sign ?? /MESSAGE_TO_SIGN: (.+)/.exec(rep.text)?.[1] ?? null, bodyJson: nc?.args?.bodyJson ?? /BODY_JSON: (.+)/.exec(rep.text)?.[1] ?? null };
}
/** prepare, sign with the owner's own wallet, submit. Returns the submit reply, or what stopped it. */
async function signedAct(s, prepareTool, submitTool, args, extraSubmit = {}) {
  const prep = await door(s, prepareTool, args);
  if (prep.isError) return { stopped: "prepare", rep: prep };
  const { message, bodyJson } = signable(prep, submitTool);
  if (!message || !bodyJson) return { stopped: "unsigned", rep: prep };
  const signature = await s.signer.sign(message);
  return { rep: await door(s, submitTool, { ...extraSubmit, bodyJson, signature }), prep };
}

// ── state ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const freshState = () => ({ version: 1, seen: {}, needs: {}, posts: [], postStatus: {}, votes: {}, voteRefused: {}, voteDry: {}, ownSig: "", lastLookAt: null });
export const loadState = (s) => ({ ...freshState(), ...readJson(s.paths.state, {}) });
function saveState(s, state) {
  const keys = Object.keys(state.seen);
  if (keys.length > 5000) for (const k of keys.sort((a, b) => String(state.seen[a].at).localeCompare(String(state.seen[b].at))).slice(0, keys.length - 5000)) delete state.seen[k];
  state.posts = state.posts.slice(-200);
  writeJsonAtomic(s.paths.state, state);
}
export const postsInLastDay = (state, now) => state.posts.filter((p) => Date.parse(p.at) >= now - 86_400_000).length;

// ── 1. new jobs near the place ────────────────────────────────────────────────────────────────────────────────────
export const searchArgs = (c) => (c.lat !== undefined ? { latitude: c.lat, longitude: c.lng, radiusKm: c.radiusKm } : { near: c.place, radiusKm: c.radiusKm });

async function phaseJobs(s, state, report) {
  const found = [];
  for (let page = 1; page <= s.maxPages; page++) {
    const rep = await door(s, "find_work", { ...searchArgs(s.config), limit: 25, page });
    if (rep.isError) { report.notes.push(`find_work said: ${plain(rep.prose, 240)}`); break; }
    for (const row of Array.isArray(rep.sc?.matches) ? rep.sc.matches : []) if (row?.workId) found.push(row);
    if (!rep.sc?.morePages) break;
  }
  const fresh = found.filter((r) => !state.seen[r.workId]);
  for (const row of fresh.slice(0, s.maxNew)) {
    if (s.stopped) break;
    const packet = await door(s, "get_work_packet", { workId: row.workId });
    report.jobs.push({ row, answers: packet.isError ? null : packet.sc?.answers ?? null });
    state.seen[row.workId] = { at: new Date(s.now()).toISOString() };
  }
  report.jobsWaiting = Math.max(0, fresh.length - s.maxNew);
  report.jobsOpen = found.length;
}

function jobBlock(item) {
  const { row, answers } = item;
  const km = Number.isFinite(row.distanceKm) ? `, ${row.distanceKm} km from your place` : "";
  const place = row.place?.address ? fence(row.place.address) : row.place?.remote ? "remote, can be done from anywhere" : "the board gave no place";
  const pin = row.place?.pinNote ? ` (${plain(row.place.pinNote, 160)})` : row.place?.pointSource === "none" ? " (the board has no map point for it yet)" : "";
  const judged = answers?.proof?.judged ? plain(answers.proof.judged, 300) : "the board did not say";
  const claim = row.claimable === false ? `not open to claim right now (${row.claimabilityReasonCode ?? "closed"})` : "open to claim";
  return [
    `- ${fence(row.title)}`,
    `  where: ${place}${km}${pin}`,
    `  pay: ${payWords(row)}`,
    `  who checks the proof: ${judged}`,
    `  proof asked: ${row.proofRule ? fence(row.proofRule, 300) : "not stated"}`,
    `  level: ${row.skillLevel ?? "not stated"}; ${claim}`,
    `  page: ${row.page ?? ""}`,
    `  id: ${row.workId}   (to vote for it, add the id to votes.txt)`,
  ].join("\n");
}

// ── 2. the owner's needs ──────────────────────────────────────────────────────────────────────────────────────────
const NEED_KEYS = { title: "title", place: "place", where: "place", location: "place", pay: "pay", price: "pay", standard: "standard", skill: "skill", level: "skill", type: "type", worktype: "type", proof: "proof", safety: "safety", expires: "expires", days: "expires", description: "description" };
const HEADER_RE = /^\s*([A-Za-z][A-Za-z ]{1,16}):\s*(.*?)\s*$/;

export function listNeedFiles(dir) {
  const items = []; const ignored = [];
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch { return { items, ignored }; }
  for (const name of names) {
    if (name.startsWith(".") || /^readme\.txt$/i.test(name)) continue;
    const file = path.join(dir, name);
    let stat; try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    if (!/\.(txt|md)$/i.test(name)) { ignored.push(name); continue; }
    if (stat.size > 20_000) { ignored.push(`${name} (more than 20 KB)`); continue; }
    const text = fs.readFileSync(file, "utf8");
    items.push({ name, text, hash: createHash("sha256").update(text).digest("hex").slice(0, 16) });
  }
  return { items, ignored };
}

/** A need file: header lines (title, pay, place, standard, skill, type, proof, safety, expires), a blank line, then the description. */
export function parseNeed(text, config) {
  const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const head = {}; const proofs = [];
  for (; i < lines.length; i++) {
    const m = HEADER_RE.exec(lines[i]);
    const key = m ? NEED_KEYS[m[1].toLowerCase().replace(/\s+/g, "")] : null;
    if (!key) break;
    if (key === "proof") { if (m[2]) proofs.push(m[2]); } else head[key] = m[2];
  }
  let rest = lines.slice(i).join("\n").trim();
  let title = head.title;
  if (!title) { const [first, ...others] = rest.split(/\r?\n/); title = (first ?? "").trim(); rest = others.join("\n").trim(); }
  const description = (head.description || rest).trim();
  if (!title) return { ok: false, why: "it has no title. Start the file with a line like `title: Photograph the posted safety notices at the gate`." };
  if (!description) return { ok: false, why: "it has no description. After the header lines, leave a blank line and write what needs doing, so a stranger could do it from the text alone." };
  const pay = Number(String(head.pay ?? "").replace(/^\$/, ""));
  if (!(pay > 0)) return { ok: false, why: "it has no pay line. Add one like `pay: 15` (US dollars, proposed; nobody is charged, and an unfunded job earns a credit, not cash)." };
  // The steward's own place, with its map point written in the text so the board pins the post (the board's own convention, "words lat,lng").
  const point = config.lat !== undefined ? `${config.lat.toFixed(4)},${config.lng.toFixed(4)}` : "";
  const here = !point ? config.place : parsePlace(config.place) ? `Near ${point}` : `${config.place} ${point}`;
  const need = {
    title: title.slice(0, 200), description: description.slice(0, 4000), location: (head.place || here).slice(0, 300),
    proposedPayUsd: pay, workType: head.type === undefined || head.type === "" ? 1 : Number(head.type),
  };
  if (head.standard) need.standard = head.standard;
  if (head.skill) need.skillLevel = head.skill.toLowerCase();
  if (head.safety) need.safetyNotes = head.safety.slice(0, 600);
  if (head.expires) need.expiresInDays = Number(head.expires);
  if (proofs.length) { need.proofRequirements = proofs.slice(0, 20); need.proofRule = proofs.join(" + ").slice(0, 1000); }
  return { ok: true, need };
}

async function postOne(s, state, file) {
  const refuse = (why) => ({ status: "refused", words: `NOT POSTED: ${why}` });
  const parsed = parseNeed(file.text, s.config);
  if (!parsed.ok) return refuse(parsed.why);
  const { need } = parsed;
  const contact = looksLikeContact([need.title, need.description, need.location, need.proofRule, need.safetyNotes, ...(need.proofRequirements ?? [])].filter(Boolean).join("\n"));
  if (contact && s.localContactCheck) return refuse(`it carries ${contact}. A job is public, so contact details never go on the board. Take it out and save the file; the steward tries again when the file changes.`);
  if (s.live && postsInLastDay(state, s.now()) >= s.postsPerDay) {
    return { status: "waiting", words: `WAITING: this wallet has already posted ${s.postsPerDay} jobs in the last 24 hours, the free lane's limit. It will post this one when a slot frees up.` };
  }
  const prep = await door(s, "prepare_post_work", { creatorWallet: s.address, ...need });
  if (prep.isError) return refuse(`the board said: ${plain(prep.prose, 600)}`);
  const unplaced = /No map point yet/.test(prep.text) ? " The board cannot place that spot on a map yet, so a search by coordinates will not find it; add coordinates to the place line, like `place: Alvarado St gate 34.0600,-118.2600`." : "";
  const { message, bodyJson } = signable(prep, "submit_post_work");
  if (!message || !bodyJson) return refuse("the board did not hand back a message to sign, so nothing was posted.");
  if (!s.live) return { status: "dry", words: `WOULD POST (dry run, add --live to post): ${fence(need.title)} at ${fence(need.location)}, proposed pay $${need.proposedPayUsd.toFixed(2)}, proposed and not funded.${unplaced}` };
  const sub = await door(s, "submit_post_work", { bodyJson, signature: await s.signer.sign(message) });
  if (sub.isError && /signed_post_cap_reached/.test(sub.text)) return { status: "waiting", words: `WAITING: the board says this wallet reached the free lane's limit of ten posts in a day. ${plain(sub.prose, 300)}` };
  if (sub.isError) return refuse(`the board said: ${plain(sub.prose, 600)}`);
  const body = plain(sub.prose, 2000);
  if (!/(^|\n)\s*(Posted\.|Already on the board)/.test(body)) return refuse(`the board's answer was not a confirmation: ${plain(sub.prose, 300)}`);
  const workId = sub.sc?.workId ?? /\b(WORK_[A-Za-z0-9_-]+)/.exec(sub.text)?.[1] ?? null;
  const dupe = /^Already on the board/m.test(body);
  if (workId && !dupe) {
    const at = new Date(s.now()).toISOString();
    state.posts.push({ at, workId, title: need.title });
    state.postStatus[workId] = { status: "OPEN", checkedAt: null };
    state.seen[workId] = { at, own: true }; // the owner's own post is not announced back as a new job
  }
  return { status: "posted", workId, words: `${dupe ? "ALREADY ON THE BOARD" : "POSTED"}: ${fence(need.title)}${workId ? ` (${workId})` : ""}, proposed pay $${need.proposedPayUsd.toFixed(2)}, proposed and not funded. You approve any proof for it yourself.${unplaced}` };
}

async function phaseNeeds(s, state, report) {
  const { items, ignored } = listNeedFiles(s.paths.needs);
  for (const name of ignored) report.needs.push(`- ${name}: ignored, only .txt and .md files are read.`);
  for (const file of items) {
    if (s.stopped) return;
    const prev = state.needs[file.name];
    if (prev?.hash === file.hash && (prev.status === "posted" || prev.status === "refused" || (prev.status === "dry" && !s.live))) continue;
    const res = await postOne(s, state, file);
    state.needs[file.name] = { hash: file.hash, status: res.status, at: new Date(s.now()).toISOString(), workId: res.workId ?? null };
    if (!(res.status === "waiting" && prev?.status === "waiting" && prev.hash === file.hash)) report.needs.push(`- ${file.name}: ${res.words}`);
  }
  // What happened to the jobs this steward posted: reads only. A proof on one of them is the owner's to accept or refuse.
  const open = Object.entries(state.postStatus).filter(([, v]) => !["SETTLED", "EXPIRED"].includes(v.status)).sort((a, b) => String(a[1].checkedAt ?? "").localeCompare(String(b[1].checkedAt ?? ""))).slice(0, 6);
  for (const [workId, was] of open) {
    if (s.stopped) return;
    const rep = await door(s, "work_status", { workId });
    const status = rep.sc?.status;
    state.postStatus[workId] = { status: status ?? was.status, checkedAt: new Date(s.now()).toISOString() };
    if (!status || status === was.status) continue;
    const mine = state.posts.find((p) => p.workId === workId);
    const note = status === "PROOF_SUBMITTED" ? " A proof is waiting for YOU to accept or refuse, on the job's page. This steward never decides a proof." : "";
    report.needs.push(`- ${fence(mine?.title ?? workId)} (${workId}): now ${status} (${STATUS_WORDS[status] ?? "see its page"}).${note}`);
  }
}

// ── 3. the owner's own work ───────────────────────────────────────────────────────────────────────────────────────
function fillReadArgs(args, address) {
  const out = {};
  for (const [k, v] of Object.entries(args ?? {})) {
    if (v === "YOUR_WALLET_ADDRESS") { out[k] = address; continue; }
    if (typeof v === "string" && /^[A-Z][A-Z0-9_]{6,}$/.test(v) && !/^WORK_/.test(v)) return null;
    if (typeof v === "object" && v !== null) return null;
    out[k] = v;
  }
  return out;
}

async function phaseOwn(s, state, report) {
  const rep = await door(s, "my_work", { wallet: s.address });
  const sc = rep.sc ?? {};
  const rows = [...(sc.waitingOnYou ?? []), ...(sc.inReview ?? []), ...(sc.settled ?? [])];
  report.ownCount = rows.length;
  const sig = createHash("sha256").update(JSON.stringify(rows.map((r) => [r.workId, r.status, r.movedAt]))).digest("hex").slice(0, 16);
  if (rep.isError || (!Array.isArray(sc.waitingOnYou) && !rows.length)) { if (rep.isError) report.notes.push(`my_work said: ${plain(rep.prose, 240)}`); return; }
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
    const paid = r.status === "SETTLED" ? ` ${r.settlement?.paymentVerified ? `Paid $${Number(r.settlement.paymentUsd).toFixed(2)}, the payment verified.` : "Settled, the payment is not verified yet."}` : "";
    const why = r.status === "PROOF_REJECTED" && r.rejection?.reason ? ` Reason given: ${fence(r.rejection.reason, 300)}.` : "";
    report.own.push(`- ${title} (${r.workId}): ${STATUS_WORDS[r.status] ?? r.status}.${why}${paid}${pay}\n  page: ${r.page ?? ""}`);
  }
  for (const { tool, rep: got } of reads) if (tool === "work_status" && got.sc?.status) report.own.push(`  live status of ${got.sc.workId}: ${got.sc.status}`);
  report.own.push("This steward does not claim a job or hand in proof for you; that stays yours.");
}

// ── 4. the owner's votes ──────────────────────────────────────────────────────────────────────────────────────────
export function readVotesFile(file) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const ids = [];
  for (const line of raw.split(/\r?\n/)) {
    const id = line.replace(/#.*$/, "").trim();
    if (id && WORK_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

async function phaseVotes(s, state, report) {
  const marked = readVotesFile(s.paths.votes);
  for (const book of [state.voteRefused, state.voteDry]) for (const id of Object.keys(book)) if (!marked.includes(id)) delete book[id]; // a line removed and added again is tried again
  let cast = 0;
  for (const id of marked) {
    if (s.stopped || cast >= s.maxVotes) break;
    if (state.votes[id] || state.voteRefused[id]) continue;
    if (!s.live) {
      if (!state.voteDry[id]) { state.voteDry[id] = true; report.votes.push(`- WOULD VOTE for ${id} (dry run, add --live to vote). Free, recorded as an agent vote.`); cast += 1; }
      continue;
    }
    const done = await signedAct(s, "prepare_vote", "submit_vote", { workId: id, voterWallet: s.address, stance: "for", voterKind: "agent", reason: "Marked by the person who runs this steward agent." }, { workId: id });
    const ok = !done.stopped && !done.rep.isError && /Vote recorded/.test(done.rep.text);
    if (ok) { state.votes[id] = { at: new Date(s.now()).toISOString() }; report.votes.push(`- VOTED for ${id}, free, as an agent vote.`); cast += 1; continue; }
    state.voteRefused[id] = { at: new Date(s.now()).toISOString() };
    report.votes.push(`- NOT VOTED for ${id}: the board said: ${plain(done.rep.prose, 400)}`);
  }
}

// ── one look, and the loop ────────────────────────────────────────────────────────────────────────────────────────
export async function runLook(s) {
  s.calls = 0;
  const state = loadState(s);
  const at = new Date(s.now());
  const report = { at: at.toISOString(), jobs: [], jobsWaiting: 0, jobsOpen: 0, needs: [], own: [], ownCount: 0, votes: [], notes: [], backoff: null };
  try {
    await phaseJobs(s, state, report);
    await phaseNeeds(s, state, report);
    await phaseOwn(s, state, report);
    await phaseVotes(s, state, report);
  } catch (e) {
    if (!(e instanceof StopLook)) throw e;
    report.notes.push(e.backoff ? `The door asked the steward to wait (${e.message}). Backing off.` : e.message);
    if (e.backoff) report.backoff = { why: e.message, status: e.status, retryAfter: e.retryAfter };
  } finally {
    state.lastLookAt = report.at;
    saveState(s, state);
  }
  const sections = [];
  if (report.jobs.length) sections.push(`### New jobs near ${s.config.place} (${report.jobs.length})\n\n${report.jobs.map(jobBlock).join("\n\n")}${report.jobsWaiting ? `\n\n${report.jobsWaiting} more new jobs will be listed at the next look.` : ""}`);
  if (report.needs.length) sections.push(`### Your needs\n\n${report.needs.join("\n")}`);
  if (report.own.length) sections.push(`### Your own work (this wallet)\n\n${report.own.join("\n")}`);
  if (report.votes.length) sections.push(`### Votes\n\n${report.votes.join("\n")}`);
  if (report.notes.length) sections.push(`### Notes\n\n${report.notes.map((n) => `- ${n}`).join("\n")}`);
  if (sections.length) {
    const text = `## ${report.at.slice(0, 16).replace("T", " ")} UTC, ${s.config.place}${s.live ? "" : " (dry run)"}\n\n${sections.join("\n\n")}\n`;
    s.say(text);
    fs.appendFileSync(s.paths.digest, `${s.out.hide(text)}\n`, { mode: 0o600 });
  }
  report.summary = `look at ${report.at.slice(0, 16).replace("T", " ")} UTC. New jobs: ${report.jobs.length} (${report.jobsOpen} open near the place). Need notes: ${report.needs.length}. Claimed by this wallet: ${report.ownCount}. Votes: ${report.votes.length}.${report.backoff ? " The door asked the steward to wait." : ""}`;
  return report;
}

/** Seconds to wait after the nth failure in a row: what the door asked for, or 1, 2, 4, 8 minutes and so on, never more than an hour. */
export function backoffSeconds(failures, retryAfter = 0, jitter = 0) {
  const base = Math.min(3600, 60 * 2 ** Math.max(0, failures - 1));
  return Math.ceil(Math.min(3600, Math.max(retryAfter, base)) * (1 + 0.1 * jitter));
}

export async function runLoop(s, { once = false, maxLooks = Infinity } = {}) {
  let failures = 0;
  for (let n = 1; n <= maxLooks && !s.stopped; n++) {
    if (fs.existsSync(s.paths.stop)) { s.say("STOP file found: the steward is stopping."); break; }
    const report = await runLook(s);
    s.say(`steward: ${report.summary}`);
    if (report.backoff) failures += 1; else failures = 0;
    const wait = report.backoff ? backoffSeconds(failures, report.backoff.retryAfter, s.jitter()) : s.config.intervalMinutes * 60;
    if (once || n >= maxLooks || s.stopped) break;
    s.say(`steward: next look in ${wait >= 120 ? `${Math.round(wait / 60)} minutes` : `${wait} seconds`}${report.backoff ? " (backing off)" : ""}. Stop it with Ctrl-C, or create the file ${s.paths.stop}.`);
    await s.sleep(wait * 1000, s.signal);
  }
}

function takeLock(file) {
  try { fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 }); return true; } catch { /* held, or stale */ }
  const pid = Number(readText(file));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch (e) { alive = e?.code === "EPERM"; }
  if (alive && pid !== process.pid) return false;
  fs.writeFileSync(file, String(process.pid), { mode: 0o600 });
  return true;
}
const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };

// ── the command line ──────────────────────────────────────────────────────────────────────────────────────────────
const BOOLEAN_FLAGS = new Set(["live", "once", "help", "version"]);
export function parseArgs(argv) {
  const out = { command: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { if (!out.command) out.command = a; continue; }
    const [name, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(name)) out.flags[name] = true;
    else out.flags[name] = inline ?? argv[++i];
  }
  return out;
}
export const HELP = `vealth steward ${VERSION}: keeps provisioning one place through ${DEFAULT_MCP_URL}, forever, on your own machine.

  node steward.mjs run --place "Boyle Heights, Los Angeles, CA" --radius 5     first time: makes your wallet, then looks
  node steward.mjs run --live                                                  later: act (post your needs, cast your votes)
  node steward.mjs run --once                                                  one look, then stop
  node steward.mjs setup --lat 34.03 --lng -118.21 --radius 5                  set the place and make the wallet, no look
  node steward.mjs status                                                      where things stand
  node steward.mjs address                                                     your wallet's public address

  --dir <folder>      the steward's folder (default ~/.vealth-steward, or VEALTH_STEWARD_HOME)
  --interval <min>    minutes between looks (default 30, at least 5)
  --mcp-url <url>     the door (default ${DEFAULT_MCP_URL})
  --max-new <n>       new jobs listed per look (default 15)
  --pace-ms <ms>      pause between calls to the door (default 1250, which keeps well under its 60 a minute)

Without --live nothing is posted and nothing is voted: it prints what it would do. It never pays, claims, hands in proof or
decides one. Stop it with Ctrl-C, or create the file STOP in its folder.`;

async function askForPlace() {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const place = (await rl.question("Which place will you steward? A name (Boyle Heights, Los Angeles, CA) or lat,lng: ")).trim();
    const radius = (await rl.question("How far around it, in km? [10] ")).trim();
    return { place, radiusKm: radius || undefined };
  } finally { rl.close(); }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const say = io.say ?? ((t) => process.stdout.write(`${t}\n`));
  const { command, flags } = parseArgs(argv);
  if (flags.help || command === "help") { say(HELP); return 0; }
  if (flags.version) { say(VERSION); return 0; }
  const dir = homeDir(flags.dir);
  const p = pathsOf(dir);
  const given = { dir, place: flags.place, lat: flags.lat, lng: flags.lng, radiusKm: flags.radius, intervalMinutes: flags.interval, mcpUrl: flags["mcp-url"] };
  try {
    if (command === "address") { say(readText(p.address).trim() || "No steward is set up here yet."); return 0; }
    if (command === "status") {
      const config = readJson(p.config, null);
      if (!config) { say(`No steward is set up in ${dir}.`); return 0; }
      const state = readJson(p.state, freshState());
      say([`Place: ${config.place}, within ${config.radiusKm} km, a look every ${config.intervalMinutes} minutes.`, `Wallet: ${readText(p.address).trim()}`, `Last look: ${state.lastLookAt ?? "none yet"}`, `Jobs seen: ${Object.keys(state.seen).length}; posted in the last 24 hours: ${postsInLastDay(state, Date.now())} of ${POSTS_PER_DAY}; votes cast: ${Object.keys(state.votes).length}`, `Digest: ${p.digest}`].join("\n"));
      return 0;
    }
    if (command && !["run", "setup"].includes(command)) { say(`Unknown command "${command}".\n\n${HELP}`); return 2; }
    const configured = fs.existsSync(p.config) && fs.existsSync(p.key);
    const asked = given.place !== undefined || given.lat !== undefined;
    if (!configured && !asked) {
      if (!process.stdin.isTTY) { say('No place yet. Run: node steward.mjs run --place "Your Place" --radius 5'); return 2; }
      Object.assign(given, await askForPlace());
    }
    if (!configured || command === "setup" || asked) await setupSteward(given, say);
    if (command === "setup") return 0;
    const s = await openSteward({ ...given, live: flags.live, maxNew: flags["max-new"] ? Number(flags["max-new"]) : undefined, paceMs: flags["pace-ms"] !== undefined ? Number(flags["pace-ms"]) : undefined });
    if (!takeLock(p.lock)) { say(`Another steward is already running in ${dir}. Two at once would post and vote twice. Stop it first.`); return 1; }
    const ac = new AbortController();
    s.signal = ac.signal;
    const release = () => { try { if (readText(p.lock).trim() === String(process.pid)) fs.unlinkSync(p.lock); } catch { /* gone */ } };
    process.once("exit", release);
    for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { s.stopped = true; ac.abort(); s.say("steward: stopping after the step it is on."); process.once(sig, () => process.exit(130)); });
    say(`steward ${VERSION}: ${s.live ? "LIVE, it will post your needs and cast your votes" : "DRY, it prints what it would post and vote (add --live to act)"}. Wallet ${s.address}.`);
    await runLoop(s, { once: Boolean(flags.once) });
    try { if (fs.existsSync(p.stop)) fs.unlinkSync(p.stop); } catch { /* fine */ }
    release();
    return 0;
  } catch (e) {
    say(`steward: ${String(e?.message ?? e)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; });
}
