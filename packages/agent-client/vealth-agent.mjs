#!/usr/bin/env node
// vealth-agent.mjs — the zero-compute onramp to the Vealth work board.
//
// One file. An agent, crawler, or bot runs the whole worker loop with almost no
// inference: every board reply carries NEXT_CALL, and this client follows it.
// Browsing, voting, claiming, and proof submission are FREE — the only gate is
// your own wallet's signature. This client never prints or transmits a
// private key. It carries exactly ONE payment command, `spend-402`, for the
// day this agent has earned enough to pay its own way — everything else stays
// free, exactly as before.
//
//   npm i viem            (the one dependency — real, audited signing; only the commands that sign need it)
//   node vealth-agent.mjs                     # read-only preflight, no wallet needed
//   node vealth-agent.mjs --flag vsh_eligible # preflight, but only packets that pay REGEN (proposal 77)
//   node vealth-agent.mjs earn --dry          # read-only: the work you could take from anywhere, what each pays, the proof each needs
//   node vealth-agent.mjs earn [--origin https://your-host] [--work <workId>] [--query words] [--adult] [--safety-read]
//                                             # claim ONE packet (free, signed by your VEALTH_AGENT_KEY) and print the NEXT_CALL for the proof
//   node vealth-agent.mjs vote <workId>       # cast one FREE vote (voterKind: agent)
//   node vealth-agent.mjs claim <workId> [httpsOriginYouControl] [--adult] [--safety-read]
//                                             # the origin is taken only by a self-verifying template packet; on any other the
//                                             # board takes none, and claim says so and signs nothing (run it again without it)
//   node vealth-agent.mjs proof <workId> <claimId> <proofs.json>
//   node vealth-agent.mjs proof-photo <workId> <claimId> <photo...>  # upload photos, print references
//   node vealth-agent.mjs physical <workId> <claimId> --gps <lat,lng> [capturedAtISO] # record them for the human reviewer
//   node vealth-agent.mjs status <workId>     # packet state (free, keyless)
//   node vealth-agent.mjs mine                # everything your wallet has done
//   node vealth-agent.mjs spend-402 <https url> [bodyJson] [--pay-to <0x address>]   # pay a 402 door in USDC-on-Base
//
// spend-402: POSTs `bodyJson` (default `{}`) to `url`. If the door answers 402,
// this reads its standard `accepts[]` challenge, picks the exact-scheme
// USDC-on-Base offer, signs an EIP-3009 transferWithAuthorization with THIS
// wallet's own key (never a fetched or shared key), and retries with the
// signed payment in the `X-PAYMENT` header — the same wire format every
// vealth.net x402 door decodes. Capped at $0.25 by default
// (VEALTH_AGENT_MAX_SPEND_USDC to change it): a bare, unfunded wallet always
// gets refused on-chain (no USDC to move) — that refusal is the honest,
// expected outcome, not a bug.
//
// What came of the money: after the door has been asked, spend-402 prints ONE line,
// `spend-402 result: {"status":…,"signedUsdc":…,"settled":…,"paidUsdc":…}`, whatever came
// back. These are the three fields the shared payment helper returns, with the same
// meaning. `signedUsdc` is the price once the payment was signed and sent, always: a door
// that answers with an error (a 503, a second 402) may still have broadcast it, and it stays
// valid for its window, so a loop that counts what it spends counts THIS. `settled` is true
// only when something was signed and the paid call came back with a status from 200 to 299.
// `paidUsdc` is the price only when settled, and 0 otherwise. A free answer signed nothing
// (0, false). A refusal before the signature prints no result line, because nothing was signed.
//
// What the door never decides: a 402 door is a stranger. The token, its six
// decimals, the EIP-712 domain it is signed under and the longest an
// authorization can live are pinned in this file, and the price is compared to
// your cap in whole base units (an integer, never a float). An offer for any
// other token, a decimals claim that is not 6, a domain that is not the real
// USDC's, a settlement other than EIP-3009, a chain hint that is not Base (8453),
// a payee written in mixed case with a bad EIP-55 checksum, a fractional,
// negative, zero or oversized amount is refused before anything is signed. Base
// may be spelled "base" or "eip155:8453" (the server reads them as one chain).
// Only the door's FIRST Base USDC offer is read: a pin never picks among several,
// it refuses when that offer names another payee. These are the same refusals as
// the shared payment helper (recipes/x402-pay.mjs), and one check holds the two
// to each other. Only an https door is paid (a door on this machine may use
// http, for a local check), a redirect is never followed, and the payee and the exact
// amount are printed BEFORE the signature is made.
//
// WHAT REMAINS, plainly: the payee is the DOOR'S choice unless you pin it. Pass
// --pay-to <0x address> (or set VEALTH_AGENT_PAY_TO) and a payment to any other
// address is refused. And the cap is per RUN, not across runs: each run may spend
// up to the cap, so a loop that calls spend-402 again and again spends the cap
// every time. An https door at a private or internal address (a private IP address,
// an internal name) is still allowed, so do not point this at an address you would
// not want a stranger's door to be. And no reply, from the board or from a door,
// has a size or a time limit: a hostile one can stall this client or fill its
// memory. Keep the wallet this key holds no larger than you can lose.
//
// proof-photo: a phone photo is megabytes and an MCP tool call is a small JSON
// envelope, so photos never ride through the assistant. This command reads each
// file on THIS machine, hashes it, signs {workerWallet, claimId, sha256, bytes}
// with this wallet (the same body-bound signature every board write uses), and
// uploads it straight to the board's proof-upload door. It prints only the
// small `sha256:<hex>` references, which the assistant then passes to
// prepare_proof as {"type":"photo","upload":"sha256:<hex>"}. The model never
// reads the photo. The board stores each photo once under its own hash, bound
// to this wallet, packet and claim, and serves it to nobody but the packet's
// reviewer. `physical` then records those photos on the physical proof rail,
// with the on-site --gps lat,lng you captured (the `camera GPS` proof-photo
// printed, or the gps you sent with the proof): the board never reads a stored
// location back to a caller, because the packet, claim and wallet are public.
//
// claim on PHYSICAL work: the board asks the person two factual questions
// before a claim can be signed (claim-attestation.ts, #1226): "I am at least 18
// years old." and, when the packet names its own hazards, "I have read the
// safety and stop-work lines shown above for this packet." This client asks
// the board for those statements FIRST, prints them and the packet's own safety
// text, and only then prepares a claim that affirms them, and only for the
// statements the person passed on the command line: --adult affirms the age
// statement, --safety-read affirms the safety statement. Nothing defaults to
// yes. Without the flags the statements are printed and nothing is signed. The
// safety text is re-hashed here, and the claim is signed only when the hash in
// the prepared body is the hash of the text that was printed. When the board
// printed a statement and you passed its flag, the prepared claim must carry
// that statement; a claim that drops it is refused, and so is one that carries
// a statement the board never printed or you never passed.
//
// EVERY write this client signs (vote, claim, proof, physical) is checked the
// same way before the key is used: the board hands back a body and the message
// for it, and neither is trusted. The body is checked field by field against
// what you typed (the packet, your wallet, the claim, the proof file, the
// location, the target address), a field you never asked for is refused, and
// the message is rebuilt HERE from that body and from a path built here. A
// board that swaps a packet or a wallet, adds a field, or hands back a message
// for anything else gets a plain refusal, and nothing is signed.
//
// SOME PHYSICAL PACKETS ALSO PAY REGEN: `--flag vsh_eligible` on the bare
// (no-command) preflight finds only the packets carrying Regen Network
// proposal 77's terms — a human-accepted hour pays REGEN, never a USD
// conversion. The claim/proof/photo/physical steps above are IDENTICAL on
// one of these; `status <workId>` and `mine` say which packets are which.
//
// Identity: set VEALTH_AGENT_KEY=0x… (a private key YOU generate and keep) so
// votes, claims, spends, and any credit accrue to one wallet across runs.
// Without it, a fresh ephemeral wallet is generated per run (address printed,
// key never) — spend-402 will then always be refused, since a fresh wallet
// holds no USDC.

import { createHash } from "node:crypto";

// ── a stranger's text never reaches the screen unmarked ──────────────────────
//
// Everything a board or a 402 door sends is printed. Some characters change what a screen
// shows without being seen, or erase what was shown: the C0 controls (an ESC that erases a
// line, a lone carriage return that overwrites it), DEL and the C1 range, the soft hyphen,
// the Arabic letter mark, bidirectional controls and isolates, zero-width and format marks,
// line and paragraph separators, the byte order mark, annotation anchors and the invisible
// "tag" characters. Newline, tab and a CRLF pair are kept.
// Code point ranges that hide, erase or reorder what a screen shows. Built from numbers at run time, so no invisible
// character (and no escape that could turn into one) sits in this file.
const HIDDEN_RANGES = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad], [0x61c], [0x180e], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x206f], [0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f],
];
const BACKSLASH = String.fromCharCode(92);
const hiddenEscape = (n) => `${BACKSLASH}u{${n.toString(16)}}`;
const rangeClass = (ranges) => ranges.map(([a, b]) => (b === undefined ? hiddenEscape(a) : `${hiddenEscape(a)}-${hiddenEscape(b)}`)).join("");
const HIDDEN_CLASS = rangeClass(HIDDEN_RANGES);
const HIDDEN_ONE = new RegExp(`[${HIDDEN_CLASS}]`, "u");
const HIDDEN_ALL = new RegExp(`[${HIDDEN_CLASS}]`, "gu");
// Marks that draw ON a letter. One or two are an accent and pass. A tall stack smears the line it sits on, the overlay marks
// (U+0334 to U+0338, and U+20D0 to U+20F0) strike a line through or cross it out, and an enclosing mark (category Me, such as
// the circle U+20DD) rings it, while the whole text is still hashed exactly as typed. A run of more than 4 marks on one letter,
// any overlay mark and any enclosing mark are refused in text a person affirms, and spelled out wherever text is printed.
const OVERLAY_CLASS = rangeClass([[0x334, 0x338], [0x20d0, 0x20f0]]);
const OVERLAY_ONE = new RegExp(`[${OVERLAY_CLASS}]|${BACKSLASH}p{Me}`, "u");
const OVERLAY_ALL = new RegExp(`[${OVERLAY_CLASS}]|${BACKSLASH}p{Me}`, "gu");
const MARK_RUN_ONE = /\p{M}{5,}/u;
const MARK_RUN_ALL = /\p{M}{5,}/gu;
const spell = (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`;
/** The text with each hidden character, each mark of a tall stack and each overlay or enclosing mark shown as <U+XXXX> instead of acted on. */
const scrub = (text) => String(text).replace(/\r\n/g, "\n").replace(HIDDEN_ALL, spell).replace(MARK_RUN_ALL, (run) => [...run].map(spell).join("")).replace(OVERLAY_ALL, spell);
// What a person is asked to affirm has to fit one screen, so the statements cannot be scrolled out of sight.
const MAX_AFFIRMED_CHARS = 2000;
const MAX_AFFIRMED_LINES = 40;
/** Why the text a person is asked to affirm cannot be affirmed as shown, or null. */
function unreadableReason(text) {
  const t = String(text).replace(/\r\n/g, "\n");
  if (HIDDEN_ONE.test(t)) return "hold characters that hide, erase or reorder what a screen shows (each is spelled out as <U+XXXX>)";
  if (MARK_RUN_ONE.test(t) || OVERLAY_ONE.test(t)) {
    return "hold combining marks that can smear, strike through or circle a line on a screen (more than 4 on one letter, or an overlay or enclosing mark; each is spelled out as <U+XXXX>)";
  }
  if (t.length > MAX_AFFIRMED_CHARS || t.split("\n").length > MAX_AFFIRMED_LINES) {
    return `are longer than one screen holds (more than ${MAX_AFFIRMED_CHARS} characters or ${MAX_AFFIRMED_LINES} lines), so the statements can scroll out of sight`;
  }
  return null;
}
// One place covers every line this client prints (board replies, door answers, the packet's own
// safety text): a hostile string is shown with its hidden characters spelled out.
for (const level of ["log", "error", "warn", "info", "debug"]) {
  const print = console[level].bind(console);
  console[level] = (...args) => print(...args.map((a) => (typeof a === "string" ? scrub(a) : a)));
}

// viem is loaded only if it is installed: the commands that read (no command,
// status, earn --dry) need no install, and the ones that sign say so when it is
// missing instead of failing at import.
let viem = null;
try { viem = await import("viem/accounts"); } catch { /* account() explains */ }

const MCP = process.env.VEALTH_MCP_URL || "https://vealth.net/mcp";
// The board's own HTTP doors (the photo upload is the one call that is not MCP).
const BOARD = process.env.VEALTH_BOARD_URL || new URL(MCP).origin;
// The board's decoded ceiling for one proof photo (EWP_PHOTO_MAX_BYTES default).
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;

// ── x402 exact-scheme (EIP-3009) — the ONE wire format every vealth.net paid
// door decodes (apps/api/src/x402/x402-standard.ts decodeExactPayment). Base
// mainnet only: USDC 0x8335…2913, chainId 8453, written "base" or "eip155:8453"
// (getX402Chain there reads both as Base). A door on another chain in
// accepts[] is skipped — this client speaks Base/USDC, nothing else, so it
// can never sign an authorization it cannot reason about.
//
// PINNED HERE, never read from a door: the token, its decimals, the domain it
// is signed under and the longest window an authorization may live. Copied from
// the server's own chain table (apps/api/src/x402/x402-standard.ts: USDC_BASE
// and X402_CHAINS.base.eip712); a check holds this file to that table.
const BASE_CHAIN_ID = 8453;
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const USDC_DOMAIN_NAME = "USD Coin";
const USDC_DOMAIN_VERSION = "2";
// Our own doors advertise maxTimeoutSeconds 3600, and the settle core's slowest
// recovery path (a pending settlement is retried fresh after 600 s, a confirm
// waits 30 s) fits well inside 900 s. A door may ask for less; it is never
// given more, so a signed authorization cannot sit around for an hour.
const MAX_AUTH_WINDOW_SECONDS = 900;
const DEFAULT_MAX_SPEND_USDC = "0.25";
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

function account() {
  if (!viem) {
    console.error("this command signs, so it needs the one dependency: npm i viem (then run it again). Commands that only read need no install.");
    process.exit(1);
  }
  const { generatePrivateKey, privateKeyToAccount } = viem;
  const k = process.env.VEALTH_AGENT_KEY;
  if (k && !/^0x[0-9a-fA-F]{64}$/.test(k)) {
    console.error("VEALTH_AGENT_KEY must be a 0x…64-hex private key. Never share it with anyone — including vealth.net.");
    process.exit(1);
  }
  const acct = privateKeyToAccount(k || generatePrivateKey());
  if (!k) console.error(`ephemeral wallet ${acct.address} (set VEALTH_AGENT_KEY to keep one identity across runs)`);
  return acct;
}

async function call(name, args) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  // A reply that is not JSON is not read at all. The parse error of a stranger's bytes carries those bytes, and
  // Node prints an uncaught error without passing it through the scrub, so the sentence is fixed.
  let json;
  try { json = await res.json(); } catch { json = undefined; }
  if (!json || typeof json !== "object") throw new Error(`${name}: the board answered ${res.status} with something that is not JSON, so nothing was read from it`);
  if (json.error) throw new Error(scrub(`${name}: ${JSON.stringify(json.error)}`));
  const text = (json.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, structured: json.result?.structuredContent, isError: !!json.result?.isError };
}

// The structured envelope carries everything a signer needs, but it is a
// stranger's word until checked. The board's body and message are NOT signed as
// handed over: `bound` says what THIS command was asked to do, and the key is
// used only after that is proven (see checkPrepared). A call with no `bound`
// throws, so no write can be added later that skips the look.
async function signedSubmit(acct, prepared, submitTool, bound) {
  return sendSigned(acct, submitTool, checkPrepared(acct, prepared, submitTool, bound), bound);
}

// ── the last look before the key is used ─────────────────────────────────────
//
// Every write here is signed as `POST <path> <nonce> <sha256 of the canonical
// body>`, the board's own body-bound form (bodyBoundActorMessage in the labor
// API). The board hands back a body and that message; this proves, locally,
// that the body is the thing the person asked for and that the message is
// exactly that body's digest on a path built HERE, and only then signs.
//
// `bound` = {
//   label     the word for the plain sentences ("vote", "claim", ...)
//   path      the API path the message is for, built from the person's own arguments
//   workId    when the submit tool takes one: the id the person typed
//   fields    every field a body of this kind may carry (anything else is refused)
//   wallet    the body field that names the signer
//   check     (body) => null | a plain sentence for what is wrong
//   show      (body) => lines printed BEFORE the signature, for every field the
//             person agrees to but did not type (optional)
// }

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
// The nonce is the BOARD's own clock when it prepared the body, and the board takes a signature
// for five minutes behind that clock and five seconds ahead of it (NONCE_WINDOW_BEHIND_MS and
// NONCE_WINDOW_AHEAD_MS in signature-refusal.ts). So a stamp ahead of this machine's clock can
// only be honest clock drift, and the further ahead a hostile board sets it, the longer it can
// hold a signature before using it: the signature stays usable until stamp + 5 minutes.
//   ahead:  2 minutes of drift slack, so a signature is never usable more than 7 minutes out;
//   behind: the board's 5 minutes plus the same 2 of drift slack. Older than that the board
//           refuses it anyway, so refusing here costs an honest person nothing.
const NONCE_AHEAD_MS = 2 * 60 * 1000;
const NONCE_BEHIND_MS = 7 * 60 * 1000;

/** A board's words, made safe to print: printable ASCII only, short. */
const plain = (v) => String(v).replace(/[^\x20-\x7e]/g, "?").slice(0, 60);

function fail(why, hint) {
  console.error(`${why}, so nothing was signed.`);
  if (hint) console.error(hint);
  process.exit(1);
}

// A field the board adds to a body after this copy was made is refused like any other, so an old copy says where the new one is.
const STRAY_FIELD_HINT = "If the board has added a field since this copy was made, fetch the newest copy from https://vealth.net/vealth-agent.mjs and run it again.";

/** The id of a packet, as find_work prints it. Refused before anything is built from it. */
function requireSafeId(id, what = "workId") {
  if (typeof id === "string" && SAFE_ID_RE.test(id)) return id;
  console.error(`${what} must be letters, digits, _ and - only (the id exactly as find_work printed it), so nothing was signed.`);
  process.exit(1);
}

/** A key named `signature` is left out of the board's digest, so it could ride in a body unsigned. */
function hasSignatureKey(value, depth = 0) {
  if (depth > MAX_BODY_DEPTH) return false; // canonical() refuses a body this deep
  if (Array.isArray(value)) return value.some((v) => hasSignatureKey(v, depth + 1));
  if (value && typeof value === "object") return Object.keys(value).some((k) => k === "signature" || hasSignatureKey(value[k], depth + 1));
  return false;
}

/** What is wrong with the shape of a prepared body, whatever the command. Null when nothing is. */
function bodyProblem(body, bound, address) {
  const word = bound.label;
  if (!body || typeof body !== "object" || Array.isArray(body)) return `The prepared ${word} is not a JSON object`;
  const stray = Object.keys(body).find((k) => !bound.fields.includes(k));
  if (stray !== undefined) return `The prepared ${word} carries a field you did not ask for (${plain(stray)})`;
  if (hasSignatureKey(body)) return `The prepared ${word} hides a field named signature, which the board's digest leaves out`;
  const who = body[bound.wallet];
  if (!(typeof who === "string" && WALLET_RE.test(who) && who.toLowerCase() === String(address).toLowerCase())) {
    return `The prepared ${word} names another wallet than yours`;
  }
  if (!Number.isSafeInteger(body.nonce)) return `The prepared ${word} carries a time stamp that is not a time`;
  const drift = body.nonce - Date.now();
  if (drift > NONCE_AHEAD_MS) {
    return `The prepared ${word} carries a time stamp more than 2 minutes ahead of this machine's clock (set this machine's clock right, or the board is not telling the truth)`;
  }
  if (-drift > NONCE_BEHIND_MS) {
    return `The prepared ${word} carries a time stamp more than 7 minutes behind this machine's clock (the board takes a signature for 5 minutes only, so check this machine's clock)`;
  }
  return null;
}

/** Prove the prepared write is the one asked for. Returns what to sign and send, or exits with a plain sentence. */
function checkPrepared(acct, prepared, submitTool, bound) {
  const nc = prepared.structured?.next_call;
  if (!nc || nc.tool !== submitTool || typeof nc.message_to_sign !== "string" || typeof nc.args?.bodyJson !== "string") {
    throw new Error(scrub(`expected a ${submitTool} envelope with message_to_sign and bodyJson; got:\n${prepared.text.slice(0, 600)}`));
  }
  if (!bound || typeof bound.path !== "string" || typeof bound.check !== "function" || !Array.isArray(bound.fields)) {
    throw new Error(`${submitTool} was called with no local binding, so nothing was signed`);
  }
  const word = bound.label;
  if (bound.workId !== undefined && nc.args.workId !== bound.workId) fail(`The prepared ${word} is for another packet than the one you named`);
  let body;
  try { body = JSON.parse(nc.args.bodyJson); } catch { return fail(`The prepared ${word} body is not JSON`); }
  let problem;
  try { problem = bodyProblem(body, bound, acct.address) ?? bound.check(body); } catch { problem = `The prepared ${word} could not be read`; }
  if (problem) fail(problem, /a field you did not ask for/.test(problem) ? STRAY_FIELD_HINT : undefined);
  let message;
  try {
    message = `POST ${bound.path} ${body.nonce} ${createHash("sha256").update(canonical(body), "utf8").digest("hex")}`;
  } catch {
    return fail(`The prepared ${word} is nested too deeply to sign`);
  }
  if (nc.message_to_sign !== message) fail(`The message to sign is not this ${word} body's own digest`);
  // Everything the person is agreeing to is on the screen before the key is used: the fields
  // they typed are in the command they ran, the rest are printed here from the checked body.
  if (typeof bound.show === "function") for (const line of bound.show(body)) console.log(line);
  return { body, message };
}

/** Sign the message rebuilt here and send the body that was checked, as parsed (never the board's own bytes, so a duplicate
 * key or an odd escape cannot make what is sent differ from what was read). Nothing else the board put in next_call.args rides along. */
async function sendSigned(acct, submitTool, checked, bound) {
  const signature = await acct.signMessage({ message: checked.message });
  return call(submitTool, { ...(bound.workId !== undefined ? { workId: bound.workId } : {}), bodyJson: JSON.stringify(checked.body), signature });
}

// ── proof-photo: upload photo bytes from THIS machine, hand back references ──

// The board's canonical body digest (canonicalizeForActorDigest in the labor
// API): object keys sorted, a key named `signature` and undefined values
// dropped, arrays in order. Both sides hash this form, never the wire bytes.
// Nesting is bounded at the same depth the board bounds it.
const MAX_BODY_DEPTH = 64;
function canonical(value, depth = 0) {
  if (depth > MAX_BODY_DEPTH) throw new RangeError("body is nested too deeply to sign");
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v, depth + 1)).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => k !== "signature" && value[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k], depth + 1)).join(",") + "}";
  }
  return JSON.stringify(value);
}

async function uploadPhoto(acct, workId, claimId, file) {
  const { readFileSync, statSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const size = statSync(file).size;
  if (size > MAX_PHOTO_BYTES) {
    return { file, size, status: 0, json: { error: `larger than the board's ${MAX_PHOTO_BYTES}-byte photo ceiling; export a smaller copy` } };
  }
  const bytes = readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const apiPath = `/labor/work/${encodeURIComponent(workId)}/proof-upload`;
  const body = { workerWallet: acct.address, claimId, sha256, data: bytes.toString("base64"), nonce: Date.now() };
  const digest = createHash("sha256").update(canonical(body), "utf8").digest("hex");
  const signature = await acct.signMessage({ message: `POST ${apiPath} ${body.nonce} ${digest}` });
  const res = await fetch(`${BOARD}${apiPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-signature": signature },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { file, size, sha256, status: res.status, json };
}

async function proofPhoto(acct, workId, claimId, files) {
  const refs = [];
  let failed = 0;
  for (const file of files) {
    const r = await uploadPhoto(acct, workId, claimId, file);
    if (r.status === 200 || r.status === 201) {
      const exif = r.json.exif ?? {};
      const where = exif.gps ? `camera GPS ${exif.gps.lat},${exif.gps.lng}${exif.kmFromPacket === null || exif.kmFromPacket === undefined ? "" : ` (${exif.kmFromPacket} km from the packet)`}` : "no camera GPS";
      console.log(`${r.json.upload.ref}  ${file}  ${r.size} bytes  ${where}${exif.capturedAt ? `  taken ${exif.capturedAt}` : ""}${r.json.duplicate ? "  (already uploaded)" : ""}`);
      refs.push({ ref: r.json.upload.ref, capturedAt: exif.capturedAt ?? undefined, gps: exif.gps ?? undefined });
    } else {
      failed += 1;
      console.error(`NOT uploaded: ${file} (${r.status || "local"}): ${r.json.detail ?? r.json.error ?? "no reason given"}`);
    }
  }
  if (!refs.length) process.exit(1);
  console.log(`\n${refs.length} photo(s) uploaded for packet ${workId}, claim ${claimId}, as ${acct.address}.`);
  console.log("The photo bytes went from this machine straight to the board; only the references above go to the assistant.");
  const proofs = refs.map((r, i) => ({ type: "photo", upload: r.ref, step: i + 1, ...(r.capturedAt ? { capturedAt: r.capturedAt } : {}) }));
  const gps = refs.find((r) => r.gps)?.gps;
  console.log(`\nproofs for prepare_proof (add the packet's other items, such as a text note, and hoursClaimed where it counts hours):\n${JSON.stringify(proofs)}`);
  console.log(`\nnext: prepare_proof ${JSON.stringify({ workId, claimId, workerWallet: acct.address, proofs, ...(gps ? { gps } : {}) })}`);
  if (failed) process.exit(1);
}

function report(r) {
  console.log(r.text);
  const nc = r.structured?.next_call;
  if (nc) console.log(`\nnext: ${nc.tool} ${JSON.stringify(nc.args)}`);
  if (r.isError) process.exit(1);
}

// ── claim: physical work asks for two factual statements before a signature ──

// The only flags this client takes, each mapped to the ONE prepare_claim
// argument it sets (mcpRoutes.ts prepareClaim reads `=== true`, nothing else).
const CLAIM_FLAGS = { "--adult": "attestAtLeast18", "--safety-read": "attestSafetyRead" };

// prepare_claim's own refusal, read by the markers it writes around the
// statements (mcpRoutes.ts prepareClaim). The packet's safety text is the
// poster's words and may contain anything, so the text is taken between the
// FIRST safety header and the LAST hash line, both of which the board writes.
const STATEMENT_LINE = "REQUIRED STATEMENT: ";
const SAFETY_HEADER = "PACKET SAFETY / STOP-WORK TEXT:\n";
const SAFETY_HASH_LINE = "\nSAFETY_TEXT_SHA256: ";
const NOTHING_ACCEPTED = "\nNo statement was accepted for you";

function statementsAsked(text) {
  if (!text.includes(STATEMENT_LINE)) return null;
  const end = text.lastIndexOf(NOTHING_ACCEPTED);
  const shown = (end >= 0 ? text.slice(0, end) : text).trimEnd();
  const hashAt = shown.lastIndexOf(SAFETY_HASH_LINE);
  const headAt = shown.indexOf(SAFETY_HEADER);
  const safetySha256 = hashAt >= 0 ? shown.slice(hashAt + SAFETY_HASH_LINE.length).split("\n")[0].trim().toLowerCase() : null;
  const safetyText = hashAt >= 0 && headAt >= 0 && headAt < hashAt ? shown.slice(headAt + SAFETY_HEADER.length, hashAt) : null;
  return { shown, safetySha256, safetyText };
}

// Every field a prepared claim body may carry (mcpRoutes.ts prepareClaim). `crew`
// is not here: this client never sends one, so a body that names a crew is not the
// claim that was asked for.
const CLAIM_FIELDS = ["workId", "workerWallet", "nonce", "termsVersion", "targetUrl", "attestation", "programFundingTermsHash"];
const CLAIM_ATTESTATION_FIELDS = ["atLeast18", "safetyTextSha256"];

/**
 * What is wrong with a prepared claim, or null. The rule for the statements:
 *   - The board printed the statements ONLY when the packet asks for them (`asked`).
 *     When it printed them and the person passed their flags, the claim MUST carry
 *     them: the age statement as exactly `true`, and, when a safety text was printed,
 *     the hash of THAT text. A claim that dropped one is refused.
 *   - A statement the person did not pass, a safety hash that is not the printed
 *     text's, and any statement on a packet that printed none, are refused. A flag
 *     passed on a packet that asks for nothing changes nothing and breaks nothing.
 */
function claimBodyProblem(body, { workId, targetUrl, passed, asked }) {
  if (body.workId !== workId) return "The prepared claim is for another packet than the one you named";
  // The board puts a target address into the claim only on a self-verifying template packet (prepareClaim in
  // mcpRoutes.ts: `template && rawTarget`). On any other packet it takes none and leaves the address out. That is
  // an honest answer, said plainly; a DIFFERENT address, or one the person never gave, is never signed.
  if (targetUrl && body.targetUrl === undefined) return "This packet takes no target address, so the board left yours out of the claim (run it again without the address)";
  if (body.targetUrl !== (targetUrl || undefined)) return "The prepared claim names another target address than the one you gave";
  if (body.termsVersion !== undefined && !(typeof body.termsVersion === "string" && /^[0-9A-Za-z._-]{1,40}$/.test(body.termsVersion))) {
    return "The prepared claim carries a terms version this client cannot read";
  }
  if (body.programFundingTermsHash !== undefined && !(typeof body.programFundingTermsHash === "string" && HEX64_RE.test(body.programFundingTermsHash))) {
    return "The prepared claim carries a funding terms hash this client cannot read";
  }
  const att = body.attestation;
  if (att !== undefined && (!att || typeof att !== "object" || Array.isArray(att) || Object.keys(att).some((k) => !CLAIM_ATTESTATION_FIELDS.includes(k)))) {
    return "The prepared claim carries a statement this client does not know";
  }
  if (att && ((att.atLeast18 !== undefined && !passed.has("--adult")) || (att.safetyTextSha256 !== undefined && !passed.has("--safety-read")))) {
    return "The prepared claim carries a statement you did not pass on the command line";
  }
  if (att && !asked) return "The prepared claim carries a statement the board never printed for this packet";
  if (att?.atLeast18 !== undefined && att.atLeast18 !== true) return "The prepared claim carries an age statement that is not a plain yes";
  if (att?.safetyTextSha256 !== undefined && att.safetyTextSha256 !== asked?.safetySha256) {
    return "The prepared claim acknowledges a different safety text than the one printed above";
  }
  if (asked) {
    if (att?.atLeast18 !== true) return "The prepared claim dropped the age statement you passed and this packet asks for";
    if (asked.safetySha256 && att.safetyTextSha256 !== asked.safetySha256) return "The prepared claim dropped the safety statement you passed and this packet asks for";
  }
  return null;
}

/** What a claim's signature carries that the person did not type, in plain words, printed before the key is used. */
function claimTermsLines(body) {
  const lines = [];
  lines.push(body.termsVersion === undefined
    ? "This claim names no terms version."
    : `By signing you accept the Vealth terms, version ${body.termsVersion}: https://vealth.net/terms.html (the version is inside what you sign).`);
  if (body.programFundingTermsHash !== undefined) {
    lines.push(`This claim also binds the funding terms of Regen proposal 77, by their hash: ${body.programFundingTermsHash}. Read the terms on the packet's own page first; the hash is what you sign.`);
  }
  if (body.targetUrl !== undefined) lines.push(`This claim names your target address: ${body.targetUrl}`);
  return lines;
}

async function claim(acct, workId, targetUrl, passed) {
  requireSafeId(workId);
  const base = { workId, workerWallet: acct.address, ...(targetUrl ? { targetUrl } : {}) };
  // Ask with nothing affirmed. The board answers with the statements this
  // packet needs, or, when it needs none, with a claim that is ready to sign.
  const first = await call("prepare_claim", base);
  const asked = first.isError ? statementsAsked(first.text) : null;
  if (first.isError && !asked) report(first);
  let prepared = first;
  if (asked) {
    // Printed BEFORE anything is prepared or signed, in the board's own words (a hidden or
    // screen-control character in them is spelled out as <U+XXXX>, never acted on).
    console.log(asked.shown);
    console.log("");
    // What a person affirms is what they can read. A poster's safety text is stored as typed, so it can hold
    // an erase sequence, a hidden mark, a stack of marks that smears a line, or enough lines to scroll the
    // statements away; the hash below would still cover all of it.
    const unreadable = unreadableReason(asked.shown);
    if (unreadable) fail(`The statements or the safety text above ${unreadable}, so what you would affirm is not what you can read`);
    if (asked.safetySha256 && (asked.safetyText === null || createHash("sha256").update(asked.safetyText, "utf8").digest("hex") !== asked.safetySha256)) {
      console.error("The safety text printed above does not hash to the SAFETY_TEXT_SHA256 the board named, so nothing was signed.");
      process.exit(1);
    }
    const needsSafety = Boolean(asked.safetySha256);
    if (!passed.has("--adult") || (needsSafety && !passed.has("--safety-read"))) {
      console.log("Nothing was signed, and no statement was made for you.");
      console.log("  --adult        affirms: I am at least 18 years old.");
      if (needsSafety) console.log("  --safety-read  affirms: I have read the safety and stop-work lines shown above for this packet.");
      console.log(`Only if YOU affirm ${needsSafety ? "both statements" : "that statement"} yourself, run: claim ${workId}${targetUrl ? ` ${targetUrl}` : ""} --adult${needsSafety ? " --safety-read" : ""}`);
      process.exit(1);
    }
    const affirmed = {};
    for (const flag of passed) affirmed[CLAIM_FLAGS[flag]] = true;
    prepared = await call("prepare_claim", { ...base, ...affirmed });
    if (prepared.isError) report(prepared);
  } else if (passed.size) {
    console.log("This packet asks for no statement before claiming, so none was sent.");
  }
  const nc = prepared.structured?.next_call;
  if (!nc || nc.tool !== "submit_claim" || typeof nc.args?.bodyJson !== "string") {
    // Restricted work answers with where to go instead, and nothing to sign.
    report(prepared);
    process.exit(1);
  }
  // The last look before the key is used (checkPrepared): the body is for the
  // packet, wallet and target the person named and carries exactly the statements
  // the board printed and the person passed (claimBodyProblem), and the message to
  // sign is this body's own digest on /labor/claim.
  const bound = {
    label: "claim", path: "/labor/claim", fields: CLAIM_FIELDS, wallet: "workerWallet",
    check: (body) => claimBodyProblem(body, { workId, targetUrl, passed, asked }),
    show: claimTermsLines,
  };
  const checked = checkPrepared(acct, prepared, "submit_claim", bound);
  const att = checked.body.attestation;
  const said = att ? ["--adult", ...(att.safetyTextSha256 ? ["--safety-read"] : [])] : [];
  console.log(`Signing the claim on ${workId} as ${acct.address}${said.length ? `, affirming ${said.join(" and ")} as you passed them` : ""}.`);
  const done = await sendSigned(acct, "submit_claim", checked, bound);
  report(done);
  return done;
}

// ── spend-402: pay a paid door in USDC-on-Base (EIP-3009, self-settled) ─────

async function readBodyText(res) {
  const text = await res.text();
  try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; }
}

/** The one network this client pays on, under either spelling a door may use, or null: "base", or the CAIP-2 name
 * "eip155:8453", in any case and with nothing around it. The server's own table reads the two as one chain
 * (getX402Chain in apps/api/src/x402/x402-standard.ts). The shared payment helper holds the same function, word for word. */
function baseNetworkLabel(network) {
  const n = String(network ?? "").toLowerCase();
  return n === "base" || n === `eip155:${BASE_CHAIN_ID}` ? n : null;
}

/** Is this `accepts[]` entry the exact-scheme USDC offer on Base? The fallback (USDC) entry carries no `role` field on
 * the wire (only non-fallback NET, permit2 and other-chain entries are annotated), so "no role, or role === fallback"
 * IS the stablecoin-on-Base offer. The token must also BE the pinned Base USDC: a door's own word for the asset is never
 * enough, because the asset becomes the contract the authorization is signed for. */
function isBaseUsdcOffer(a) {
  return a?.scheme === "exact"
    && baseNetworkLabel(a?.network) !== null
    && typeof a?.asset === "string" && a.asset.toLowerCase() === BASE_USDC.toLowerCase()
    && (!a.role || a.role === "fallback");
}

/** The Base USDC offer to pay: the FIRST one in accepts[], and only that one. A pin never picks among several: when
 * the first offer names another payee, the pin check that follows refuses the call, even if a later offer names the
 * pin. Of the two ways the two public clients once read this, it is the stricter, and both now read it this way. */
function selectBaseUsdcRequirement(accepts) {
  if (!Array.isArray(accepts)) return null;
  return accepts.find(isBaseUsdcOffer) ?? null;
}

/** What is wrong with an address, or null when it is fine: 0x and 40 hex digits, and when it is written in mixed case
 * its EIP-55 checksum must be right. All lower or all upper case carries no checksum and is accepted, as the server's
 * own addresses are and as the shared payment helper reads them. A bad checksum is how a mistyped or tampered address
 * looks. `checksum` is viem's checksumAddress. */
function addressFault(value, checksum) {
  if (typeof value !== "string" || !WALLET_RE.test(value)) return "is not an address";
  const hex = value.slice(2);
  if (hex === hex.toLowerCase() || hex === hex.toUpperCase()) return null;
  return checksum(value) === value ? null : "has a bad checksum";
}

function describeOffers(accepts) {
  if (!Array.isArray(accepts) || !accepts.length) return "(none)";
  return accepts.slice(0, 10).map((a) => plain(`${a?.scheme}/${a?.network}/${a?.assetSymbol || a?.asset || "?"}`)).join(", ");
}

/** The cap in whole USDC base units (6 decimals), from a plain dollar amount: digits, at most six after the point.
 * Null for anything else (a letter, a sign, an exponent, a seventh decimal), so a garbled setting can never turn the cap off. */
function parseCapUnits(text) {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(String(text).trim());
  return m ? BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0")) : null;
}

/** A price in base units as dollars, for the one line a person reads. */
function formatUnits(units) {
  const scale = 10n ** BigInt(USDC_DECIMALS);
  return `${units / scale}.${String(units % scale).padStart(USDC_DECIMALS, "0")}`;
}

/** A door's amount as whole base units, or null: a digit string, or a whole non-negative JSON number. Never a fraction, a sign, a hex or an exponent. */
function parseAtomicAmount(value) {
  const text = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  return typeof text === "string" && /^\d{1,30}$/.test(text) ? BigInt(text) : null;
}

/** Read what a door asks for and say whether this client will sign it. The door's settlement, decimals, domain,
 * chain hints and window are never used to compute anything: they are only checked against the pinned values.
 * `checksum` is viem's checksumAddress, which reads a payee written in mixed case. */
function readOffer(offer, capUnits, checksum) {
  if (offer.settlement !== undefined && offer.settlement !== "eip3009") {
    return { why: `this offer names ${plain(offer.settlement)} settlement, and this client signs only the USDC EIP-3009 authorization` };
  }
  if (offer.assetDecimals !== undefined && offer.assetDecimals !== USDC_DECIMALS) {
    return { why: `this door says its token has ${plain(offer.assetDecimals)} decimals, and the real Base USDC has ${USDC_DECIMALS}` };
  }
  const extra = offer.extra;
  if (extra !== undefined && extra !== null && (typeof extra !== "object" || Array.isArray(extra))) {
    return { why: "this door's token domain is not readable" };
  }
  if (extra?.name !== undefined && extra.name !== USDC_DOMAIN_NAME) return { why: `this door names a token called ${plain(extra.name)}, and the real Base USDC is called ${USDC_DOMAIN_NAME}` };
  if (extra?.version !== undefined && extra.version !== USDC_DOMAIN_VERSION) return { why: `this door names token version ${plain(extra.version)}, and the real Base USDC signs at version ${USDC_DOMAIN_VERSION}` };
  for (const hint of [offer.chainId, extra?.chainId]) {
    if (hint !== undefined && Number(hint) !== BASE_CHAIN_ID) return { why: `this door names chain ${plain(hint)}, and this client pays on Base (${BASE_CHAIN_ID}) only` };
  }
  const value = parseAtomicAmount(offer.maxAmountRequired);
  if (value === null) return { why: `this door's amount (${plain(offer.maxAmountRequired)}) is not a whole number of USDC base units (${USDC_DECIMALS} decimals)` };
  if (value === 0n) return { why: "this door asks for a zero amount, which is nothing worth a signature" };
  if (value > capUnits) {
    return { why: `price $${formatUnits(value)} exceeds max spend $${formatUnits(capUnits)} (VEALTH_AGENT_MAX_SPEND_USDC)` };
  }
  const payToFault = addressFault(offer.payTo, checksum);
  if (payToFault) return { why: `this door names no valid payTo address (${plain(offer.payTo)} ${payToFault})` };
  if (/^0x0{40}$/i.test(offer.payTo)) return { why: "this door names the zero address as the payee, which is nobody" };
  const asked = Number(offer.maxTimeoutSeconds);
  const windowSeconds = Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), MAX_AUTH_WINDOW_SECONDS) : MAX_AUTH_WINDOW_SECONDS;
  return { value, windowSeconds, network: baseNetworkLabel(offer.network) };
}

/** Why this client will not pay a door at this address, or null. A signed payment sent over plain http can be read, and replayed
 * to the same payee, by anyone on the path; only a door on this machine may use http (a local check). */
function doorUrlProblem(url) {
  let u;
  try { u = new URL(url); } catch { return `${plain(url)} is not a web address`; }
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return null;
  return `spend-402 only pays a door on https, and ${plain(`${u.protocol}//${u.host}`)} is not (a signed payment over plain http can be read and replayed by anyone on the way)`;
}

/** The door's word that a paid call went through: a status from 200 to 299. Nothing else is read as settled (a 0 or a
 * 1xx is no answer from the door). The shared payment helper holds the same function, word for word. */
function settledBy(status) {
  return typeof status === "number" && status >= 200 && status < 300;
}

/** After the door has been asked, ONE line a caller can read whatever came back: what was signed, whether the door took
 * it, and what was paid. These are the three fields the shared payment helper returns, with the same meaning.
 * `signedUsdc` is the price once the authorization is signed and sent: a door that answers with an error may still have
 * broadcast it, and it stays valid for its window, so a loop that counts spend counts THIS. `settled` is true only when
 * something was signed and the paid call came back with a status from 200 to 299. `paidUsdc` is the price only when settled,
 * and 0 otherwise. A free answer signed nothing: zero and false. `status` is null when the paid call got no answer. */
function reportSpend(status, signedUnits) {
  const signedUsdc = Number(formatUnits(signedUnits));
  const settled = signedUnits > 0n && settledBy(status);
  console.log(`spend-402 result: ${JSON.stringify({ status, signedUsdc, settled, paidUsdc: settled ? signedUsdc : 0 })}`);
}

async function spend402(acct, url, bodyArg, payToArg) {
  // The cap is read FIRST, before anything is sent: a setting that is not a plain dollar
  // amount used to read as "no cap at all" (NaN compares false with everything).
  const capUnits = parseCapUnits(process.env.VEALTH_AGENT_MAX_SPEND_USDC || DEFAULT_MAX_SPEND_USDC);
  if (capUnits === null) {
    console.error("VEALTH_AGENT_MAX_SPEND_USDC must be a plain dollar amount such as 0.25 (digits, and at most six after the point). Nothing was sent and nothing was signed.");
    process.exit(1);
  }
  // viem is installed (account() has made sure): its EIP-55 checksum is what reads an address written in mixed case.
  const { checksumAddress } = await import("viem");
  // The optional recipient pin: --pay-to <address>, or VEALTH_AGENT_PAY_TO. With one, a payment to any other address is refused.
  // A pin that is given but blank, is not an address, or is written in mixed case with a bad checksum is refused, never read
  // as no pin (the shared payment helper refuses the same pins).
  const payToPin = payToArg ?? process.env.VEALTH_AGENT_PAY_TO;
  const pinFault = payToPin === undefined ? null : addressFault(payToPin, checksumAddress);
  if (pinFault === "is not an address") {
    const blank = payToPin.trim() === "" ? " (it is set but blank, and a blank pin is not read as no pin)" : "";
    console.error(`--pay-to (or VEALTH_AGENT_PAY_TO) must be a 0x address of 40 hex characters${blank}. Nothing was sent and nothing was signed.`);
    process.exit(1);
  }
  if (pinFault) {
    console.error(`--pay-to (or VEALTH_AGENT_PAY_TO) ${plain(payToPin)} ${pinFault} (EIP-55), so it cannot pin who is paid. Nothing was sent and nothing was signed.`);
    process.exit(1);
  }
  const urlProblem = doorUrlProblem(url);
  if (urlProblem) {
    console.error(`${urlProblem}. Nothing was sent and nothing was signed.`);
    process.exit(1);
  }
  let body;
  try {
    body = bodyArg ? JSON.parse(bodyArg) : {};
  } catch {
    console.error(`bodyJson is not valid JSON: ${bodyArg}`);
    process.exit(1);
  }
  const headers = { "content-type": "application/json", accept: "application/json" };

  // A redirect is never followed: the payment header must go to the door that was asked for and to no other.
  const first = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });
  if (first.status !== 402) {
    const { text } = await readBodyText(first);
    reportSpend(first.status, 0n); // nothing was signed
    console.log(`${url} answered ${first.status} directly — no 402 challenge, nothing to pay.`);
    console.log(text.slice(0, 2000));
    process.exit(first.status >= 400 ? 1 : 0);
  }

  const { json: challenge, text: challengeText } = await readBodyText(first);
  const accepts = challenge?.accepts;
  const offer = selectBaseUsdcRequirement(accepts);
  if (!offer) {
    console.error(
      `unsupported scheme: no exact-scheme entry for the real USDC on Base (${BASE_USDC}) in this door's accepts[]. ` +
      `Offered: ${describeOffers(accepts)}. This client only speaks exact/base/that USDC. Refusing, and nothing was signed.`,
    );
    console.error(challengeText.slice(0, 1000).replace(/[^\n\x20-\x7e]/g, "?")); // a stranger's text: no control bytes reach the terminal
    process.exit(1);
  }
  // A settlement other than EIP-3009 (permit2 among them) is refused inside readOffer, before anything is signed.
  const read = readOffer(offer, capUnits, checksumAddress);
  if (read.why) {
    console.error(`${read.why}. Refusing, and nothing was signed.`);
    process.exit(1);
  }
  if (payToPin !== undefined && offer.payTo.toLowerCase() !== payToPin.toLowerCase()) {
    console.error(
      `this door asks to be paid at ${offer.payTo}, and you pinned ${payToPin}. Only the door's first Base USDC offer is read, ` +
      "so a pin never picks among offers. Refusing, and nothing was signed.",
    );
    process.exit(1);
  }
  // Said BEFORE the key is used, so the person (or the log an agent leaves) has the payee and the exact amount first.
  console.log(
    `About to sign: pay $${formatUnits(read.value)} USDC on Base to ${offer.payTo} from ${acct.address}, good for ${read.windowSeconds} seconds. ` +
    (payToPin !== undefined ? "That payee is the address you pinned." : "The payee is the door's own choice (pin one with --pay-to to refuse any other)."),
  );

  const { randomBytes } = await import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  const validBefore = now + read.windowSeconds;
  const nonce = `0x${randomBytes(32).toString("hex")}`;
  // The domain is the real USDC's, pinned above. Nothing in it comes from the door.
  const domain = {
    name: USDC_DOMAIN_NAME,
    version: USDC_DOMAIN_VERSION,
    chainId: BASE_CHAIN_ID,
    verifyingContract: BASE_USDC,
  };
  // viem signs an address only in lower case or in its checksummed form (it refuses one written all in capitals, which
  // the helper and the server accept), so the payee is handed to it checksummed. What is signed is the same address: an
  // address is signed as its 20 bytes, whatever its case.
  const signature = await acct.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from: acct.address, to: checksumAddress(offer.payTo), value: read.value, validAfter: 0n, validBefore: BigInt(validBefore), nonce },
  });
  // What goes on the wire is the same authorization, in the shape every vealth.net door decodes.
  const authorization = { from: acct.address, to: offer.payTo, value: String(read.value), validAfter: 0, validBefore, nonce };

  console.log(`signed, nonce ${authorization.nonce.slice(0, 10)}… (unfunded wallets get refused on-chain, expected)`);

  const xPayment = Buffer.from(
    // The network as the door spelled it ("base" or "eip155:8453"), as the shared payment helper sends it.
    JSON.stringify({ x402Version: 1, scheme: "exact", network: read.network, asset: BASE_USDC, payload: { signature, authorization } }),
  ).toString("base64");

  // From here the authorization has been handed to the door. Every way out says what was signed (reportSpend), because the
  // door may have broadcast it even when it answered with an error or did not answer at all.
  let second;
  try {
    second = await fetch(url, { method: "POST", headers: { ...headers, "x-payment": xPayment }, body: JSON.stringify(body), redirect: "manual" });
  } catch (err) {
    reportSpend(null, read.value);
    console.error(`the paid call got no answer (${plain(err?.message)}) after the payment went to the door. It may still have settled, so count it as spent. It lapses by itself within ${read.windowSeconds} seconds.`);
    process.exit(1);
  }
  if (second.status >= 300 && second.status < 400) {
    reportSpend(second.status, read.value);
    console.error(`the door answered ${second.status}, a redirect, after the payment went to it. It was NOT followed, so the payment header went to no other address.`);
    process.exit(1);
  }
  let answer;
  try {
    answer = await readBodyText(second);
  } catch (err) {
    reportSpend(second.status, read.value);
    console.error(`the door answered ${second.status} after the payment, and its answer could not be read (${plain(err?.message)}).`);
    process.exit(1);
  }
  const { json: result, text: resultText } = answer;
  reportSpend(second.status, read.value);

  if (second.status === 402) {
    // The expected, honest outcome for an unfunded wallet: the signature was
    // valid, but the door's own settlement (broadcast + on-chain confirm)
    // refused it. Surface the door's own error verbatim — never paraphrase.
    // The real reason usually rides in `detail` (err402's shape) — `error`/
    // `code` alone is the generic wrapper ("payment_verification_failed"
    // covers everything from a bad signature to a guaranteed on-chain revert).
    const reason = result?.detail ?? result?.error ?? resultText.slice(0, 500);
    console.log(`door refused settlement (402): ${result?.error ?? "?"} — ${reason}`);
    // Always a string, so it goes through the scrub: an object printed by the console would skip it.
    if (result?.message) console.log(typeof result.message === "string" ? result.message : JSON.stringify(result.message));
    console.log(`\nnext: spend-402 ${url}  (fund ${acct.address} with USDC on Base, then re-run)`);
    process.exit(1);
  }
  if (second.status >= 400) {
    console.log(`door answered ${second.status} after payment: ${resultText.slice(0, 1000)}`);
    process.exit(1);
  }

  // A signed, unfunded authorization succeeding would mean either the door
  // settled for free or something is badly wrong — never treat it as routine.
  console.log(`PAID (${second.status}): ${resultText.slice(0, 2000)}`);
  console.log(
    "\nWARNING: settlement succeeded against a wallet this client believed was unfunded. " +
    "Stopping here — do not run spend-402 again until you understand why.",
  );
}

// ── earn: the one command. Read what you could take, or take ONE packet ─────
//
// `earn --dry` reads the board (no key, no install, nothing signed, nothing
// sent) and lists the work an agent can do from anywhere: what each packet
// pays, the proof it needs, and whether it needs an https origin you control.
// `earn` takes ONE of them through the same claim path as `claim` and prints
// the NEXT_CALL for the proof. Claiming is free. What the work earns is the
// board's to say, never this file's: cash only on a packet the board marks
// funded; on any other an approved proof banks a credit, a receipt for the work.

const SKILL_RANK = { entry: 0, intermediate: 1, advanced: 2 };
const EARN_VALUE_FLAGS = new Set(["--origin", "--work", "--query"]);
const EARN_USAGE = "usage: earn [--dry] [--origin https://your-host] [--work <workId>] [--query words] [--adult] [--safety-read]";

/** An https origin the person controls, or "" when none was given. */
function httpsOrigin(value) {
  if (!value) return "";
  const u = new URL(value);
  if (u.protocol !== "https:") { console.error("targetUrl must be an https origin YOU control. Never claim an origin that is not yours."); process.exit(1); }
  return u.origin;
}

function parseEarnArgs(args) {
  const o = { dry: false, passed: new Set(), origin: "", work: "", query: "" };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--dry") o.dry = true;
    else if (Object.hasOwn(CLAIM_FLAGS, a)) o.passed.add(a);
    else if (EARN_VALUE_FLAGS.has(a) && args[i + 1] !== undefined && !args[i + 1].startsWith("--")) { i += 1; o[a.slice(2)] = args[i]; }
    else { console.error(`${EARN_USAGE}  (not an argument this client takes: ${a})`); process.exit(1); }
  }
  return o;
}

/** Ids of the packets find_work labels "self-verifying template": they need an
 * https origin the person controls. Read outside the poster's fenced text, so
 * a poster's words can never decide it. */
function templateIdsIn(text) {
  const ids = new Set();
  const bare = text.replace(/\[\[untrusted\]\][\s\S]*?\[\[\/untrusted\]\]/g, "[[fenced]]");
  for (const block of bare.split("\n\n")) {
    const id = block.match(/\n {2}id: (\S+)/)?.[1];
    if (id && block.includes("self-verifying template:")) ids.add(id);
  }
  return ids;
}

async function earnCandidates(query) {
  // remote:true is the set an agent with no field presence can finish; the
  // board already surfaces funded work first, the sort below keeps it that way.
  const r = await call("find_work", { remote: true, limit: 25, ...(query ? { query } : {}), ...(flagValue ? { flag: flagValue } : {}) });
  if (r.isError) report(r);
  const needsOrigin = templateIdsIn(r.text);
  const rows = (r.structured?.matches ?? [])
    .filter((m) => m.claimable === true)
    .map((m) => ({ ...m, needsOrigin: needsOrigin.has(m.workId) }));
  rows.sort((a, b) => Number(Boolean(b.funded)) - Number(Boolean(a.funded)) || (SKILL_RANK[a.skillLevel] ?? 3) - (SKILL_RANK[b.skillLevel] ?? 3) || (b.payUsd ?? 0) - (a.payUsd ?? 0));
  return rows;
}

/** The board's own live counts, so the page says the honest number. */
async function boardCounts() {
  try {
    const res = await fetch(`${BOARD}/labor/stats`, { headers: { accept: "application/json" } });
    const s = (await res.json())?.stats;
    return s && Number.isFinite(s.claimableOpenPostings) ? s : null;
  } catch { return null; }
}

function payWords(m) {
  if (m.paysCashNow) return `$${m.payUsd}, funded: settles in USDC after approved proof`;
  if (m.funded) return `$${m.payUsd}, funded, but read the packet's pay model: it may bank credit, not cash`;
  return `$${m.payUsd} proposed, not funded: approved proof banks a credit, not cash, unless a buyer funds it`;
}

async function earn(args) {
  const o = parseEarnArgs(args);
  const targetUrl = httpsOrigin(o.origin);
  const rows = await earnCandidates(o.query);
  const counts = await boardCounts();
  console.log(counts
    ? `board now (${BOARD}/labor/stats): ${counts.claimableOpenPostings} claimable open, ${counts.fundedCount} funded, ${counts.claimableOpenCashPostings} claimable that pay cash now`
    : "board counts unavailable right now");
  if (!rows.length) {
    console.log("no claimable work that an agent can do from anywhere matched, so there is nothing to take. Try another --query, or `vote <workId>` (free) on any packet.");
    return;
  }
  if (o.dry) {
    const shown = rows.slice(0, 5);
    shown.forEach((m, i) => {
      console.log(`\n${i + 1}. ${m.title}`);
      console.log(`   id      ${m.workId}`);
      console.log(`   pays    ${payWords(m)}`);
      console.log(`   proof   ${m.proofRule}`);
      console.log(`   needs   ${m.needsOrigin ? "an https origin you control (--origin): you publish your finding there and the board checks it" : "your wallet only"}`);
      console.log(`   packet  ${m.page}`);
    });
    if (rows.length > shown.length) console.log(`\n(${rows.length - shown.length} more; use --query to narrow)`);
    console.log("\nDry: nothing was signed or sent, and no key was used.");
    console.log(`Take one: VEALTH_AGENT_KEY=<your key> node vealth-agent.mjs earn${shown[0].needsOrigin ? " --origin https://your-host" : ""}${o.query ? ` --query "${o.query}"` : ""}`);
    return;
  }
  // Your claim and your proof must be signed by the SAME wallet, so earn will
  // not claim on a throwaway one: the key would be gone before the proof.
  if (!process.env.VEALTH_AGENT_KEY) {
    console.error("earn needs a key you keep: the wallet that claims is the wallet that must hand the proof in. Make one on your machine, keep it, and export it:");
    console.error("  export VEALTH_AGENT_KEY=0x$(openssl rand -hex 32)");
    console.error("Nothing was signed. `earn --dry` reads the board with no key.");
    process.exit(1);
  }
  // `unlisted`: the person named a packet the board's list did not show (it may be a template the list cut off), so
  // the board decides whether it takes their address.
  const pick = o.work ? (rows.find((m) => m.workId === o.work) ?? { workId: o.work, needsOrigin: false, unlisted: true }) : rows.find((m) => !m.needsOrigin || targetUrl);
  if (!pick) {
    console.error("Every packet found needs an https origin you control (you publish one small finding there and the board checks it). Nothing was signed.");
    console.error("Run again with --origin https://your-host, or run `earn --dry` to read them first.");
    process.exit(1);
  }
  if (pick.needsOrigin && !targetUrl) {
    console.error(`${pick.workId} is a self-verifying packet: it needs an https origin you control. Nothing was signed. Run again with --origin https://your-host.`);
    process.exit(1);
  }
  const acct = account();
  console.log(`\nTaking ${pick.workId}${pick.title ? `: ${pick.title}` : ""}`);
  // The board takes a target address only on a self-verifying template packet, so the address goes only with one.
  const sendOrigin = targetUrl && (pick.needsOrigin || pick.unlisted) ? targetUrl : "";
  if (targetUrl && !sendOrigin) console.log(`This packet takes no target address, so the one you gave was not sent.`);
  const done = await claim(acct, pick.workId, sendOrigin, o.passed);
  // The claim id is the board's word. It goes into a command line below, so only an id shaped like one is used.
  const said = done?.structured?.claimId;
  const claimId = typeof said === "string" && SAFE_ID_RE.test(said) ? said : undefined;
  if (said !== undefined && !claimId) console.log("The board named a claim id this client will not put in a command. Read your claims with `mine`.");
  console.log(`\nearn: claimed ${pick.workId} as ${acct.address}${claimId ? `, claimId ${claimId} (keep it)` : ""}. The packet, in full: ${pick.page ?? `${BOARD}/work/${pick.workId}`}`);
  console.log("Do the work the packet names. An unworked claim is released after 24 hours.");
  if (claimId) console.log(`When you have the proof: node vealth-agent.mjs proof ${pick.workId} ${claimId} proofs.json`);
  console.log(pick.paysCashNow
    ? "This packet is funded: approved proof settles in USDC."
    : "Approved proof on this packet banks a credit, a receipt for the work. It is not cash unless a buyer funds the packet.");
}

// --flag <name> is read from anywhere in argv, stripped before the normal
// command/positional parsing below so no other command's argv shape changes,
// and used only by the no-command preflight's find_work call: --flag
// vsh_eligible finds the packets that carry Regen Network proposal 77's
// terms (accepted hours pay REGEN, never a USD conversion — get_work_packet
// says the exact rate on any one of them).
const rawArgv = process.argv.slice(2);
const flagIdx = rawArgv.indexOf("--flag");
const flagValue = flagIdx !== -1 ? rawArgv[flagIdx + 1] : undefined;
const afterFlag = flagIdx !== -1 ? [...rawArgv.slice(0, flagIdx), ...rawArgv.slice(flagIdx + 2)] : rawArgv;
// --gps <lat,lng> belongs to `physical` alone (the on-site pin the person captured),
// stripped the same way so no other command's argv shape changes.
const gpsIdx = afterFlag.indexOf("--gps");
const gpsValue = gpsIdx !== -1 ? afterFlag[gpsIdx + 1] : undefined;
const afterGps = gpsIdx !== -1 ? [...afterFlag.slice(0, gpsIdx), ...afterFlag.slice(gpsIdx + 2)] : afterFlag;
// --pay-to <address> belongs to `spend-402` alone (the one address a payment may go to), stripped the same way.
const payIdx = afterGps.indexOf("--pay-to");
const payToValue = payIdx !== -1 ? afterGps[payIdx + 1] : undefined;
const argv = payIdx !== -1 ? [...afterGps.slice(0, payIdx), ...afterGps.slice(payIdx + 2)] : afterGps;
function parsePin(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}
/**
 * What is wrong with a prepared physical proof, or null. The claim, the location and the time are the
 * person's own: the pin must be the numbers they typed (and no pin means none in the body), and a
 * capturedAt they typed must be the one in the body. The photo hashes are the board's own list of the
 * photos it already holds for this claim, which this machine cannot know, so they are checked for shape
 * only (1 to 12 SHA-256 hashes); the real board refuses any hash it does not hold for the claim.
 * No revisesProofId is allowed: this client never asks to revise a proof.
 */
function physicalBodyProblem(body, { claimId, pin, capturedAt }) {
  if (body.claimId !== claimId) return "The prepared physical proof is for another claim than the one you named";
  if (pin) {
    const g = body.gps;
    const sameShape = g && typeof g === "object" && !Array.isArray(g) && Object.keys(g).sort().join(",") === "lat,lng";
    if (!sameShape || g.lat !== pin.lat || g.lng !== pin.lng) return "The prepared physical proof carries another location than the --gps you gave";
  } else if (body.gps !== undefined) {
    return "The prepared physical proof carries a location you did not give";
  }
  if (typeof body.capturedAt !== "string" || !Number.isFinite(Date.parse(body.capturedAt))) return "The prepared physical proof carries a photo time that is not a time";
  if (capturedAt && Number.isFinite(Date.parse(capturedAt)) && body.capturedAt !== capturedAt) return "The prepared physical proof carries another photo time than the one you gave";
  const hashes = body.photoHashes;
  if (!Array.isArray(hashes) || hashes.length < 1 || hashes.length > 12 || !hashes.every((h) => typeof h === "string" && HEX64_RE.test(h))) {
    return "The prepared physical proof does not carry 1 to 12 photo hashes";
  }
  const items = body.photoItems;
  if (items !== undefined) {
    const ok = Array.isArray(items) && items.length >= 1 && items.length <= 12 && items.every((e) =>
      e && typeof e === "object" && !Array.isArray(e)
      && Object.keys(e).every((k) => k === "hash" || k === "forItem" || k === "slot")
      && typeof e.hash === "string" && hashes.includes(e.hash)
      && typeof e.forItem === "string" && SAFE_ID_RE.test(e.forItem)
      && (e.slot === undefined || e.slot === "before" || e.slot === "after"));
    if (!ok) return "The prepared physical proof carries photo labels this client cannot read";
  }
  return null;
}

/** What a physical proof's signature carries that the person did not type, printed before the key is used: the photos
 * (the board's own list of what it holds for this claim) and, when the person typed no time, the photo time the board chose. */
function physicalLines(body, { typedTime }) {
  const lines = [];
  const hashes = body.photoHashes;
  lines.push(`This records ${hashes.length} photo${hashes.length === 1 ? "" : "s"} the board already holds for this claim, by hash: ${hashes.map((h) => h.slice(0, 12)).join(", ")}.`);
  if (body.photoItems !== undefined) {
    lines.push(`Each is labelled for the proof item it answers: ${body.photoItems.map((e) => `${e.hash.slice(0, 12)} for ${e.forItem}${e.slot ? ` (${e.slot})` : ""}`).join("; ")}.`);
  }
  const typed = typedTime && Number.isFinite(Date.parse(typedTime));
  lines.push(typed
    ? `The photo time is the one you gave: ${plain(body.capturedAt)}.`
    : `You gave no usable photo time, so this uses the time the board holds for the photos: ${plain(body.capturedAt)}. Check it is when you took them.`);
  return lines;
}

// Flags belong to `claim` alone, so every other command reads its arguments
// exactly as it always has.
const claimFlagArgs = argv[0] === "claim" ? argv.slice(1).filter((a) => a.startsWith("--")) : [];
const [cmd, a1, a2, a3, ...rest] = argv[0] === "claim" ? argv.filter((a) => !a.startsWith("--")) : argv;

if (!cmd) {
  const start = await call("start_here", {});
  console.log(start.text);
  const work = await call("find_work", { limit: 5, ...(flagValue ? { flag: flagValue } : {}) });
  console.log(`\n${work.text}`);
  console.log("\nread-only preflight done — nothing signed, nothing sent. `earn --dry` lists the work you could take from anywhere; `vote <workId>` is the free first act.");
} else if (cmd === "earn") {
  await earn(argv.slice(1));
} else if (cmd === "vote") {
  if (!a1) { console.error("usage: vote <workId>"); process.exit(1); }
  requireSafeId(a1);
  const acct = account();
  const prep = await call("prepare_vote", { workId: a1, voterWallet: acct.address, stance: "for", voterKind: "agent" });
  // The vote that was asked for: a vote FOR this packet, from this wallet, as an agent's, and nothing more (no reason text).
  report(await signedSubmit(acct, prep, "submit_vote", {
    label: "vote", path: `/labor/work/${a1}/vote`, workId: a1, wallet: "voterWallet",
    fields: ["voterWallet", "stance", "nonce", "voterKind"],
    check: (body) => (body.stance !== "for" ? "The prepared vote is not a vote for this packet" : body.voterKind !== "agent" ? "The prepared vote is not marked as an agent's" : null),
  }));
} else if (cmd === "claim") {
  const unknownFlags = claimFlagArgs.filter((f) => !Object.hasOwn(CLAIM_FLAGS, f));
  if (!a1 || unknownFlags.length) {
    console.error(`usage: claim <workId> [httpsOriginYouControl] [--adult] [--safety-read]${unknownFlags.length ? `  (not a flag this client takes: ${unknownFlags.join(" ")})` : ""}`);
    process.exit(1);
  }
  const targetUrl = httpsOrigin(a2);
  const acct = account();
  await claim(acct, a1, targetUrl, new Set(claimFlagArgs));
} else if (cmd === "proof") {
  if (!a1 || !a2 || !a3) { console.error("usage: proof <workId> <claimId> <proofs.json>  (proofs.json = an array matching the packet's proof line)"); process.exit(1); }
  const { readFileSync } = await import("node:fs");
  const proofs = JSON.parse(readFileSync(a3, "utf8"));
  if (!Array.isArray(proofs) || !proofs.length) { console.error("proofs.json must be a non-empty JSON array of proof objects you actually captured."); process.exit(1); }
  requireSafeId(a1);
  const acct = account();
  const prep = await call("prepare_proof", { workId: a1, claimId: a2, workerWallet: acct.address, proofs });
  // The proof that was asked for: this claim, this wallet, and the proofs in YOUR file, item for item. No hours,
  // counts, location, crew or measurement you did not give.
  report(await signedSubmit(acct, prep, "submit_proof", {
    label: "proof", path: `/labor/work/${a1}/complete`, workId: a1, wallet: "workerWallet",
    fields: ["claimId", "workerWallet", "nonce", "proofs"],
    check: (body) => (body.claimId !== a2 ? "The prepared proof is for another claim than the one you named"
      : canonical(body.proofs) !== canonical(proofs) ? "The prepared proof is not the proofs in your file" : null),
  }));
} else if (cmd === "proof-photo") {
  if (!a1 || !a2 || !a3) { console.error("usage: proof-photo <workId> <claimId> <photo...>  (the photo files you took on site; each is uploaded from this machine, never through the assistant)"); process.exit(1); }
  const acct = account();
  await proofPhoto(acct, a1, a2, [a3, ...rest]);
} else if (cmd === "physical") {
  if (!a1 || !a2) { console.error("usage: physical <workId> <claimId> --gps <lat,lng> [capturedAtISO]  (after proof: records the photos the board holds for this claim for the human reviewer; --gps is the on-site location you captured, which the board never reads back to you)"); process.exit(1); }
  const pin = gpsValue === undefined ? null : parsePin(gpsValue);
  if (gpsValue !== undefined && !pin) { console.error("--gps must be the on-site numbers you captured as lat,lng, for example --gps 34.0501,-118.2401"); process.exit(1); }
  requireSafeId(a1);
  const acct = account();
  const prep = await call("prepare_physical_proof", { workId: a1, claimId: a2, workerWallet: acct.address, ...(pin ? { gps: pin } : {}), ...(a3 ? { capturedAt: a3 } : {}) });
  if (prep.isError) report(prep);
  report(await signedSubmit(acct, prep, "submit_physical_proof", {
    label: "physical proof", path: `/labor/work/${encodeURIComponent(a1)}/physical-proof`, workId: a1, wallet: "workerWallet",
    fields: ["workerWallet", "claimId", "photoHashes", "photoItems", "gps", "capturedAt", "nonce"],
    check: (body) => physicalBodyProblem(body, { claimId: a2, pin, capturedAt: a3 }),
    show: (body) => physicalLines(body, { typedTime: a3 }),
  }));
} else if (cmd === "status") {
  if (!a1) { console.error("usage: status <workId>"); process.exit(1); }
  report(await call("work_status", { workId: a1 }));
} else if (cmd === "mine") {
  const acct = account();
  report(await call("my_work", { wallet: acct.address }));
} else if (cmd === "spend-402") {
  if (!a1 || (payIdx !== -1 && payToValue === undefined)) { console.error("usage: spend-402 <https url> [bodyJson] [--pay-to <0x address the payment may go to>]"); process.exit(1); }
  const acct = account();
  await spend402(acct, a1, a2, payToValue);
} else {
  console.error(`unknown command: ${cmd}. Use earn | vote | claim | proof | proof-photo | physical | status | mine | spend-402, or no command for the read-only preflight.`);
  process.exit(1);
}
