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
//   npm i viem            (the one dependency — real, audited signing)
//   node vealth-agent.mjs                     # read-only preflight, no wallet needed
//   node vealth-agent.mjs --flag vsh_eligible # preflight, but only packets that pay REGEN (proposal 77)
//   node vealth-agent.mjs vote <workId>       # cast one FREE vote (voterKind: agent)
//   node vealth-agent.mjs claim <workId> [httpsOriginYouControl] [--adult] [--safety-read]
//   node vealth-agent.mjs proof <workId> <claimId> <proofs.json>
//   node vealth-agent.mjs proof-photo <workId> <claimId> <photo...>  # upload photos, print references
//   node vealth-agent.mjs physical <workId> <claimId> [capturedAtISO] # record them for the human reviewer
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
// reviewer. `physical` then records those photos on the physical proof rail.
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

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

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
  report(await signedSubmit(acct, prepared, "submit_claim"));
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

// --flag <name> is read from anywhere in argv, stripped before the normal
// command/positional parsing below so no other command's argv shape changes,
// and used only by the no-command preflight's find_work call: --flag
// vsh_eligible finds the packets that carry Regen Network proposal 77's
// terms (accepted hours pay REGEN, never a USD conversion — get_work_packet
// says the exact rate on any one of them).
const rawArgv = process.argv.slice(2);
const flagIdx = rawArgv.indexOf("--flag");
const flagValue = flagIdx !== -1 ? rawArgv[flagIdx + 1] : undefined;
const argv = flagIdx !== -1 ? [...rawArgv.slice(0, flagIdx), ...rawArgv.slice(flagIdx + 2)] : rawArgv;
// Flags belong to `claim` alone, so every other command reads its arguments
// exactly as it always has.
const claimFlagArgs = argv[0] === "claim" ? argv.slice(1).filter((a) => a.startsWith("--")) : [];
const [cmd, a1, a2, a3, ...rest] = argv[0] === "claim" ? argv.filter((a) => !a.startsWith("--")) : argv;

if (!cmd) {
  const start = await call("start_here", {});
  console.log(start.text);
  const work = await call("find_work", { limit: 5, ...(flagValue ? { flag: flagValue } : {}) });
  console.log(`\n${work.text}`);
  console.log("\nread-only preflight done — nothing signed, nothing sent. `vote <workId>` is the free first act.");
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
  let targetUrl = "";
  if (a2) {
    const u = new URL(a2);
    if (u.protocol !== "https:") { console.error("targetUrl must be an https origin YOU control. Never claim an origin that is not yours."); process.exit(1); }
    targetUrl = u.origin;
  }
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
  if (!a1 || !a2) { console.error("usage: physical <workId> <claimId> [capturedAtISO]  (after proof: records the photos the board holds for this claim for the human reviewer)"); process.exit(1); }
  const acct = account();
  const prep = await call("prepare_physical_proof", { workId: a1, claimId: a2, workerWallet: acct.address, ...(a3 ? { capturedAt: a3 } : {}) });
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
  console.error(`unknown command: ${cmd}. Use vote | claim | proof | proof-photo | physical | status | mine | spend-402, or no command for the read-only preflight.`);
  process.exit(1);
}
