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
//   node vealth-agent.mjs proof <workId> <claimId> <proofs.json>
//   node vealth-agent.mjs proof-photo <workId> <claimId> <photo...>  # upload photos, print references
//   node vealth-agent.mjs physical <workId> <claimId> --gps <lat,lng> [capturedAtISO] # record them for the human reviewer
//   node vealth-agent.mjs status <workId>     # packet state (free, keyless)
//   node vealth-agent.mjs mine                # everything your wallet has done
//   node vealth-agent.mjs spend-402 <url> [bodyJson]   # pay a 402 door in USDC-on-Base
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
// the prepared body is the hash of the text that was printed.
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
// mainnet only: USDC 0x8335…0291, chainId 8453. A door on another chain in
// accepts[] is skipped — this client speaks Base/USDC, nothing else, so it
// can never sign an authorization it cannot reason about.
const BASE_CHAIN_ID = 8453;
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
const MAX_SPEND_USDC = Number(process.env.VEALTH_AGENT_MAX_SPEND_USDC || 0.25);

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
  const json = await res.json();
  if (json.error) throw new Error(`${name}: ${JSON.stringify(json.error)}`);
  const text = (json.result?.content ?? []).map((c) => c.text ?? "").join("\n");
  return { text, structured: json.result?.structuredContent, isError: !!json.result?.isError };
}

// The structured envelope carries everything a signer needs: next_call.args is
// sent back verbatim, next_call.message_to_sign is the exact bytes to
// personal_sign. No prose parsing, no crypto authoring, no judgment.
async function signedSubmit(acct, prepared, submitTool) {
  const nc = prepared.structured?.next_call;
  if (!nc || nc.tool !== submitTool || typeof nc.message_to_sign !== "string") {
    throw new Error(`expected a ${submitTool} envelope with message_to_sign; got:\n${prepared.text.slice(0, 600)}`);
  }
  const signature = await acct.signMessage({ message: nc.message_to_sign });
  return call(submitTool, { ...nc.args, signature });
}

// ── proof-photo: upload photo bytes from THIS machine, hand back references ──

// The board's canonical body digest (canonicalizeForActorDigest in the labor
// API): object keys sorted, a key named `signature` and undefined values
// dropped, arrays in order. Both sides hash this form, never the wire bytes.
function canonical(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => k !== "signature" && value[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
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

async function claim(acct, workId, targetUrl, passed) {
  const { createHash } = await import("node:crypto");
  const base = { workId, workerWallet: acct.address, ...(targetUrl ? { targetUrl } : {}) };
  // Ask with nothing affirmed. The board answers with the statements this
  // packet needs, or, when it needs none, with a claim that is ready to sign.
  const first = await call("prepare_claim", base);
  const asked = first.isError ? statementsAsked(first.text) : null;
  if (first.isError && !asked) report(first);
  let prepared = first;
  if (asked) {
    // Printed BEFORE anything is prepared or signed, in the board's own words.
    console.log(asked.shown);
    console.log("");
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
  // The last look before the key is used: the message to sign is this body's
  // own digest, the body carries no statement the person did not pass, and the
  // safety hash in it is the hash of the text printed above.
  const body = JSON.parse(nc.args.bodyJson);
  const digest = createHash("sha256").update(canonical(body), "utf8").digest("hex");
  if (nc.message_to_sign !== `POST /labor/claim ${body.nonce} ${digest}`) {
    console.error("The message to sign is not this claim body's own digest, so nothing was signed.");
    process.exit(1);
  }
  const att = body.attestation;
  if (att && ((att.atLeast18 !== undefined && !passed.has("--adult")) || (att.safetyTextSha256 !== undefined && !passed.has("--safety-read")))) {
    console.error("The prepared claim carries a statement you did not pass on the command line, so nothing was signed.");
    process.exit(1);
  }
  if (att?.safetyTextSha256 !== undefined && att.safetyTextSha256 !== asked?.safetySha256) {
    console.error("The prepared claim acknowledges a different safety text than the one printed above, so nothing was signed.");
    process.exit(1);
  }
  const said = att ? ["--adult", ...(att.safetyTextSha256 ? ["--safety-read"] : [])] : [];
  console.log(`Signing the claim on ${workId} as ${acct.address}${said.length ? `, affirming ${said.join(" and ")} as you passed them` : ""}.`);
  const done = await signedSubmit(acct, prepared, "submit_claim");
  report(done);
  return done;
}

// ── spend-402: pay a paid door in USDC-on-Base (EIP-3009, self-settled) ─────

async function readBodyText(res) {
  const text = await res.text();
  try { return { text, json: JSON.parse(text) }; } catch { return { text, json: null }; }
}

/** Pick the exact-scheme, USDC-on-Base offer from a standard `accepts[]`
 * challenge. The fallback (USDC) entry carries no `role` field on the wire —
 * only non-fallback (NET/permit2/other-chain) entries are annotated — so
 * "no role, or role === fallback" IS the stablecoin-on-Base offer. */
function selectBaseUsdcRequirement(accepts) {
  if (!Array.isArray(accepts)) return null;
  const onBase = accepts.filter(
    (a) => a?.scheme === "exact" && String(a?.network ?? "").toLowerCase() === "base",
  );
  return onBase.find((a) => !a.role || a.role === "fallback") ?? null;
}

function describeOffers(accepts) {
  if (!Array.isArray(accepts) || !accepts.length) return "(none)";
  return accepts.map((a) => `${a?.scheme}/${a?.network}/${a?.assetSymbol || a?.asset || "?"}`).join(", ");
}

async function spend402(acct, url, bodyArg) {
  let body;
  try {
    body = bodyArg ? JSON.parse(bodyArg) : {};
  } catch {
    console.error(`bodyJson is not valid JSON: ${bodyArg}`);
    process.exit(1);
  }
  const headers = { "content-type": "application/json", accept: "application/json" };

  const first = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (first.status !== 402) {
    const { text } = await readBodyText(first);
    console.log(`${url} answered ${first.status} directly — no 402 challenge, nothing to pay.`);
    console.log(text.slice(0, 2000));
    process.exit(first.status >= 400 ? 1 : 0);
  }

  const { json: challenge, text: challengeText } = await readBodyText(first);
  const accepts = challenge?.accepts;
  const offer = selectBaseUsdcRequirement(accepts);
  if (!offer) {
    console.error(
      `unsupported scheme: no exact-scheme USDC-on-Base entry in this door's accepts[]. ` +
      `Offered: ${describeOffers(accepts)}. This client only speaks exact/base/USDC — refusing.`,
    );
    console.error(challengeText.slice(0, 1000));
    process.exit(1);
  }
  if (offer.settlement === "permit2") {
    // Should never happen for the fallback entry (extraForAsset only puts
    // permit2 fields on non-fallback assets) — fail loudly rather than sign
    // an authorization this client's EIP-3009 signer cannot actually produce.
    console.error("unsupported scheme: the selected USDC-on-Base offer names permit2 settlement — refusing.");
    process.exit(1);
  }

  const priceUsdc = Number(offer.maxAmountRequired) / 10 ** (offer.assetDecimals ?? 6);
  if (!Number.isFinite(priceUsdc) || priceUsdc > MAX_SPEND_USDC) {
    console.error(
      `price $${Number.isFinite(priceUsdc) ? priceUsdc.toFixed(6) : "?"} exceeds max spend ` +
      `$${MAX_SPEND_USDC} (VEALTH_AGENT_MAX_SPEND_USDC) — refusing to sign.`,
    );
    process.exit(1);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(offer.payTo ?? ""))) {
    console.error(`unsupported scheme: 402 challenge names no valid payTo address — refusing. Got: ${offer.payTo}`);
    process.exit(1);
  }

  const { randomBytes } = await import("node:crypto");
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: acct.address,
    to: offer.payTo,
    value: String(offer.maxAmountRequired),
    validAfter: 0,
    validBefore: now + (Number(offer.maxTimeoutSeconds) || 3600),
    nonce: `0x${randomBytes(32).toString("hex")}`,
  };
  const domain = {
    name: offer.extra?.name || "USD Coin",
    version: offer.extra?.version || "2",
    chainId: BASE_CHAIN_ID,
    verifyingContract: offer.asset,
  };
  const signature = await acct.signTypedData({
    domain,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: authorization,
  });

  console.log(
    `signed: pay $${priceUsdc.toFixed(6)} USDC on Base to ${offer.payTo} from ${acct.address}, ` +
    `nonce ${authorization.nonce.slice(0, 10)}… (unfunded wallets get refused on-chain — expected)`,
  );

  const xPayment = Buffer.from(
    JSON.stringify({ x402Version: 1, scheme: "exact", network: offer.network, asset: offer.asset, payload: { signature, authorization } }),
  ).toString("base64");

  const second = await fetch(url, { method: "POST", headers: { ...headers, "x-payment": xPayment }, body: JSON.stringify(body) });
  const { json: result, text: resultText } = await readBodyText(second);

  if (second.status === 402) {
    // The expected, honest outcome for an unfunded wallet: the signature was
    // valid, but the door's own settlement (broadcast + on-chain confirm)
    // refused it. Surface the door's own error verbatim — never paraphrase.
    // The real reason usually rides in `detail` (err402's shape) — `error`/
    // `code` alone is the generic wrapper ("payment_verification_failed"
    // covers everything from a bad signature to a guaranteed on-chain revert).
    const reason = result?.detail ?? result?.error ?? resultText.slice(0, 500);
    console.log(`door refused settlement (402): ${result?.error ?? "?"} — ${reason}`);
    if (result?.message) console.log(result.message);
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
  const pick = o.work ? (rows.find((m) => m.workId === o.work) ?? { workId: o.work, needsOrigin: false }) : rows.find((m) => !m.needsOrigin || targetUrl);
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
  const done = await claim(acct, pick.workId, targetUrl, o.passed);
  const claimId = done?.structured?.claimId;
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
const argv = gpsIdx !== -1 ? [...afterFlag.slice(0, gpsIdx), ...afterFlag.slice(gpsIdx + 2)] : afterFlag;
function parsePin(text) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(text ?? ""));
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
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
  const acct = account();
  const prep = await call("prepare_vote", { workId: a1, voterWallet: acct.address, stance: "for", voterKind: "agent" });
  report(await signedSubmit(acct, prep, "submit_vote"));
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
  const acct = account();
  const prep = await call("prepare_proof", { workId: a1, claimId: a2, workerWallet: acct.address, proofs });
  report(await signedSubmit(acct, prep, "submit_proof"));
} else if (cmd === "proof-photo") {
  if (!a1 || !a2 || !a3) { console.error("usage: proof-photo <workId> <claimId> <photo...>  (the photo files you took on site; each is uploaded from this machine, never through the assistant)"); process.exit(1); }
  const acct = account();
  await proofPhoto(acct, a1, a2, [a3, ...rest]);
} else if (cmd === "physical") {
  if (!a1 || !a2) { console.error("usage: physical <workId> <claimId> --gps <lat,lng> [capturedAtISO]  (after proof: records the photos the board holds for this claim for the human reviewer; --gps is the on-site location you captured, which the board never reads back to you)"); process.exit(1); }
  const pin = gpsValue === undefined ? null : parsePin(gpsValue);
  if (gpsValue !== undefined && !pin) { console.error("--gps must be the on-site numbers you captured as lat,lng, for example --gps 34.0501,-118.2401"); process.exit(1); }
  const acct = account();
  const prep = await call("prepare_physical_proof", { workId: a1, claimId: a2, workerWallet: acct.address, ...(pin ? { gps: pin } : {}), ...(a3 ? { capturedAt: a3 } : {}) });
  if (prep.isError) report(prep);
  report(await signedSubmit(acct, prep, "submit_physical_proof"));
} else if (cmd === "status") {
  if (!a1) { console.error("usage: status <workId>"); process.exit(1); }
  report(await call("work_status", { workId: a1 }));
} else if (cmd === "mine") {
  const acct = account();
  report(await call("my_work", { wallet: acct.address }));
} else if (cmd === "spend-402") {
  if (!a1) { console.error("usage: spend-402 <url> [bodyJson]"); process.exit(1); }
  const acct = account();
  await spend402(acct, a1, a2);
} else {
  console.error(`unknown command: ${cmd}. Use earn | vote | claim | proof | proof-photo | physical | status | mine | spend-402, or no command for the read-only preflight.`);
  process.exit(1);
}
