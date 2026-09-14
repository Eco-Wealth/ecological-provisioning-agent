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
//   node vealth-agent.mjs vote <workId>       # cast one FREE vote (voterKind: agent)
//   node vealth-agent.mjs claim <workId> [httpsOriginYouControl]
//   node vealth-agent.mjs proof <workId> <claimId> <proofs.json>
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
// Identity: set VEALTH_AGENT_KEY=0x… (a private key YOU generate and keep) so
// votes, claims, spends, and any credit accrue to one wallet across runs.
// Without it, a fresh ephemeral wallet is generated per run (address printed,
// key never) — spend-402 will then always be refused, since a fresh wallet
// holds no USDC.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const MCP = process.env.VEALTH_MCP_URL || "https://vealth.net/mcp";

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

function report(r) {
  console.log(r.text);
  const nc = r.structured?.next_call;
  if (nc) console.log(`\nnext: ${nc.tool} ${JSON.stringify(nc.args)}`);
  if (r.isError) process.exit(1);
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

const [cmd, a1, a2, a3] = process.argv.slice(2);

if (!cmd) {
  const start = await call("start_here", {});
  console.log(start.text);
  const work = await call("find_work", { limit: 5 });
  console.log(`\n${work.text}`);
  console.log("\nread-only preflight done — nothing signed, nothing sent. `vote <workId>` is the free first act.");
} else if (cmd === "vote") {
  if (!a1) { console.error("usage: vote <workId>"); process.exit(1); }
  const acct = account();
  const prep = await call("prepare_vote", { workId: a1, voterWallet: acct.address, stance: "for", voterKind: "agent" });
  report(await signedSubmit(acct, prep, "submit_vote"));
} else if (cmd === "claim") {
  if (!a1) { console.error("usage: claim <workId> [httpsOriginYouControl]"); process.exit(1); }
  const acct = account();
  const args = { workId: a1, workerWallet: acct.address };
  if (a2) {
    const u = new URL(a2);
    if (u.protocol !== "https:") { console.error("targetUrl must be an https origin YOU control. Never claim an origin that is not yours."); process.exit(1); }
    args.targetUrl = u.origin;
  }
  const prep = await call("prepare_claim", args);
  report(await signedSubmit(acct, prep, "submit_claim"));
} else if (cmd === "proof") {
  if (!a1 || !a2 || !a3) { console.error("usage: proof <workId> <claimId> <proofs.json>  (proofs.json = an array matching the packet's proof line)"); process.exit(1); }
  const { readFileSync } = await import("node:fs");
  const proofs = JSON.parse(readFileSync(a3, "utf8"));
  if (!Array.isArray(proofs) || !proofs.length) { console.error("proofs.json must be a non-empty JSON array of proof objects you actually captured."); process.exit(1); }
  const acct = account();
  const prep = await call("prepare_proof", { workId: a1, claimId: a2, workerWallet: acct.address, proofs });
  report(await signedSubmit(acct, prep, "submit_proof"));
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
  console.error(`unknown command: ${cmd} — use vote | claim | proof | status | mine | spend-402, or no command for the read-only preflight.`);
  process.exit(1);
}
