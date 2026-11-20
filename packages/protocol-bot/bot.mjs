#!/usr/bin/env node
// vealth protocol bot: ONE program that runs the whole loop, on your own machine, with your own key.
//
//   node bot.mjs once --address 0xYOU       a dry pass: what every leg would do right now. No key, nothing signed, nothing sent.
//   node bot.mjs wallet                     make the bot's own wallet (or point --key-file at a key file you already hold)
//   node bot.mjs run --live --eco-eth 0.0002 --regen-eth 0.0002 --circle-eth 0.0001
//                                           the loop, forever: every wake it walks the legs below, in order, and sends
//
// THE LOOP, in order, every wake (a leg with nothing to do says so in one line and the loop goes on):
//   hydrex   your veHYDX lock: claim last epoch's fees and bribes, then vote by the kit's plain rank:
//            last epoch's pay per vote, split equally. It is NOT a copy of any wallet's vote. Once per epoch.
//   klima    retire carbon on Klima with kVCM you hold (a lock that votes a kVCM pool earns kVCM): approve the exact amount,
//            retire, take the approval back. A sink: what it retires is gone for good, by design. EcoWealth holds a stake
//            in Klima and may gain if it rises.
//   regen-retire  retire Regen credits you hold on Regen Ledger: asks the kit for the exact retirement message and PRINTS it
//            ("DRY, would sign this Regen message: ..."). It never signs or sends, with or without --live: this program has no
//            Regen signer and no Regen key, so signing is a separate step you do with your own Regen wallet. A sink, by design.
//   regen    buy axlREGEN (Regen's token on Base) with a slice of ETH you set. EcoWealth holds REGEN and may gain if it rises.
//   eco      buy ECO, the coin EcoWealth made on Zora, with a slice of ETH you set. EcoWealth created ECO. As of 2026-11-18
//            it holds it and may gain if it rises; it both buys ECO and swaps ECO it holds for NET.
//   eco-buy  buy ECO by the NET circle kit's best route (the Zora coin pool, or through NET's pools) with a slice of ETH you set.
//            One way: you end up holding ECO. The kit prints its own holdings line with the buy.
//   net-buy  buy NET with a slice of ETH you set. One way: you end up holding NET (the buying in NET's pools is the house's own).
//   circle   one trip through NET's pools and back to ETH, sent only when the kit's floor says at least the input plus gas
//            comes back (the buying in NET's pools is the house's own).
//   gmx      one small GMX position on Arbitrum by YOUR rule: market, side, collateral, leverage and how long to hold. It
//            opens, holds, closes, and starts again. A liquidation can take all the collateral. EcoWealth holds a stake
//            in GMX and may gain if it rises.
//
// Never an offer or advice, no return promised. A loop is a path with its costs, never a profit: every leg has fees and
// gas and can return less than it took. EcoWealth takes no fee from this program and it never trades for EcoWealth.
//
// HOW IT STAYS SAFE WITH A KEY
//   - DRY by default. It sends only with --live.
//   - The two kits (skills/protocol-guide, skills/net-circle) run as SEPARATE programs and are never handed the key: it is
//     not in their command line or their environment. They read the chain and print one unsigned step; this file checks
//     that step against RULES below before it signs anything. They still run as you, on your machine, so that split
//     guards against a mistake, not against a kit someone has tampered with: run only the kits that ship beside this file.
//   - RULES is the whole list of contract calls this program can ever sign: the contract, the function and the most value
//     per leg. A step that is not on the list is refused. No plain token transfer is allowed; GMX collateral goes to its order vault.
//   - A swap is read inside before it is signed: only the swap steps the kits build are let through, nothing may be
//     pulled from your wallet, and what comes out goes to you. The most a swap leg can lose is the size you set.
//   - A leg that spends has no default size: no size flag, no spend. Day caps on fees and on ETH spent stop a loop. The
//     fee caps count the signed gas fee and the kit's Base data-fee bound when one is provided.
//   - One thing at a time: it waits for each transaction, and an unconfirmed one (or a send that got no answer) blocks every later send.
//   - The key file must be readable by you alone. The key is never printed, logged, put in a command line or sent anywhere.
//   - STOP is checked at the start of every pass and immediately before every send.
//   - The regen-retire leg signs nothing: it has no RULES list, no key path and no send, and the gate refuses any step named for it.
//
// One dependency, to sign and send: `npm ci` (viem, pinned). Node 22 or newer. No build step.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, decodeAbiParameters, decodeFunctionData, formatEther, formatUnits, http, isAddress, keccak256, parseAbi, parseAbiParameters, parseEther, parseTransaction, parseUnits, recoverTransactionAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base } from "viem/chains";
import { archiveJournal, verifyArchiveInventory, ARCHIVE_TRIGGER_BYTES } from "./journal-archive.mjs";

export const VERSION = "0.1.0";
export const STORAGE_SCHEMA_VERSION = 1;
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_KIT = path.resolve(HERE, "../../skills/protocol-guide/protocol-guide.mjs");
export const DEFAULT_CIRCLE_KIT = path.resolve(HERE, "../../skills/net-circle/net-circle.mjs");
/** Reviewed Git blobs of the exact sibling helpers. Any helper upgrade must be explicitly repinned. */
export const PINNED_KIT_GIT_SHA1 = Object.freeze({
  protocol: "dfbd0574389512bbd8692baa4ff5c669f9692aa9", // the kit as published 2026-11-19 (independently read at these bytes)
  circle: "15664af0d4d77501b06acf8995c1f30273b3b7b8",
});
/** Hash the exact file bytes as a Git blob, not a line-normalized string. */
export function gitBlobSha1(file) {
  const bytes = fs.readFileSync(file);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
/**
 * A same-UID helper can read a local key. This is a pin, not a sandbox:
 * refuse arbitrary paths or unreviewed helper changes before live key use.
 */
export function verifyBundledKits(protocolFile = DEFAULT_KIT, circleFile = DEFAULT_CIRCLE_KIT) {
  for (const [file, canonical, expected] of [
    [protocolFile, DEFAULT_KIT, PINNED_KIT_GIT_SHA1.protocol],
    [circleFile, DEFAULT_CIRCLE_KIT, PINNED_KIT_GIT_SHA1.circle],
  ]) {
    if (path.resolve(file) !== canonical) throw new GuardError("live helper path is not the bundled reviewed path");
    const st = fs.lstatSync(canonical);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
        (typeof process.getuid === "function" && st.uid !== process.getuid()))
      throw new GuardError("live helper must be an owner-held plain file");
    if (gitBlobSha1(canonical) !== expected)
      throw new GuardError("bundled helper code changed without a reviewed hash update; live signing is refused");
  }
  return true;
}
export const CHAINS = {
  base: { id: 8453, env: "BASE_RPC_URL", rpc: "https://mainnet.base.org", viem: base },
  arbitrum: { id: 42161, env: "ARBITRUM_RPC_URL", rpc: "https://arb1.arbitrum.io/rpc", viem: arbitrum },
};
export const LEG_ORDER = ["hydrex", "klima", "regen-retire", "regen", "eco", "eco-buy", "net-buy", "circle", "gmx"];
/** Legs that sign and send nothing. They have no RULES list on purpose, so the gate refuses any step named for them. */
export const UNSIGNED_LEGS = ["regen-retire"];
/** The Regen Ledger retirement message the kit prints, and the patterns its fields must match (a test holds them equal to the kit's). */
export const REGEN_RETIRE_TYPE_URL = "/regen.ecocredit.v1.MsgRetire";
export const REGEN_RETIRE_RE = {
  owner: /^regen1[02-9ac-hj-np-z]{38}$/,
  batch: /^[A-Z]{1,3}\d{2,3}-\d{3}-\d{8}-\d{8}-\d{3}$/,
  jurisdiction: /^[A-Z]{2}(-[A-Z0-9]{1,3}( [A-Za-z0-9]{1,64})?)?$/,
  amount: /^(0|[1-9]\d{0,17})(\.\d{1,6})?$/,
};

// ---- the contracts, pinned here on purpose (a test holds each one equal to the kit's own constant) -----------------
export const ADDR = {
  hydrexVoter: "0xc69E3eF39E3fFBcE2A1c570f8d3ADF76909ef17b",
  kvcm: "0x00fBAC94Fec8D4089d3fe979F39454F48c71A65d",
  klimaAggregator: "0xdA0A793D7C32AB80bcdab7F8c725c96DB22464f4",
  klimaAssetManager: "0x1C24239309398220883207681602BfF4D10fbde1",
  universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  gmxExchangeRouter: "0x7dE39FF2e232A2203196788d37e234cF8F1b83f1",
  gmxRouter: "0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6",
  gmxOrderVault: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
  arbitrumUsdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  net: "0xE37A9125B6b14D5e8Ec056C744a99F4deC975022",
  eco: "0x170dC0ca26F1247CED627D8aBcaFA90ecf1e1519",
  axlRegen: "0x2E6C05f1f7D1f4Eb9A088bf12257f1647682b754",
};
const ZERO = "0x0000000000000000000000000000000000000000";
/** Starter market addresses checked against GMX markets on 2026-11-18; explicit address also permitted. */
export const GMX_STARTER_MARKETS = {
  ETH: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
  BTC: "0x47c031236e19d024b42f8AE6780E44A573170703",
  ZORA: "0xac484106d935f0f20F1485b631fA6F65AeEff550",
};
const chosenGmxMarket = (market) => isAddress(String(market ?? "")) ? market : GMX_STARTER_MARKETS[String(market ?? "").toUpperCase()] ?? null;
const klimaRetireIntent = (opts) => ({
  credit: opts.klimaCredit, carbonClass: opts.klimaClass, tokenId: BigInt(opts.klimaTokenId ?? "0"),
  tonnes: parseUnits(opts.klimaTonnes, 18), name: clean(opts.klimaName, 64),
});
const gmxOrderIntent = (opts, action) => ({
  action, market: chosenGmxMarket(opts.gmxMarket), isLong: opts.gmxSide === "long",
  collateralUnits: parseUnits(opts.gmxCollateral, 6),
  leverageTenths: parseUnits(opts.gmxLeverage, 1),
});

// ---- the functions, by 4-byte selector (a test recomputes each from its signature) ---------------------------------
export const SIGNATURES = {
  claimFees: "function claimFees(address[] _fees, address[][] _tokens)",
  claimBribes: "function claimBribes(address[] _bribes, address[][] _tokens)",
  vote: "function vote(address[] _poolVote, uint256[] _voteProportions)",
  approve: "function approve(address spender, uint256 amount) returns (bool)",
  retireCreditViaKlima: "function retireCreditViaKlima(address creditToken, uint256 tokenId, uint256 batchId, uint256 amount, address inputToken, address carbonClass, uint256 maxInputTokenIn, uint256 couponTonnes, (address retiringAddress, string retiringEntityString, address beneficiaryAddress, string beneficiaryString, string retirementMessage, string beneficiaryLocation, string consumptionCountryCode, uint256 consumptionPeriodStart, uint256 consumptionPeriodEnd) details)",
  execute: "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  multicall: "function multicall(bytes[] data) payable returns (bytes[] results)",
  sendWnt: "function sendWnt(address receiver, uint256 amount) payable",
  sendTokens: "function sendTokens(address token, address receiver, uint256 amount) payable",
  createOrder: "function createOrder(((address receiver,address cancellationReceiver,address callbackContract,address uiFeeReceiver,address market,address initialCollateralToken,address[] swapPath) addresses,(uint256 sizeDeltaUsd,uint256 initialCollateralDeltaAmount,uint256 triggerPrice,uint256 acceptablePrice,uint256 executionFee,uint256 callbackGasLimit,uint256 minOutputAmount,uint256 validFromTime) numbers,uint8 orderType,uint8 decreasePositionSwapType,bool isLong,bool shouldUnwrapNativeToken,bool autoCancel,bytes32 referralCode,bytes32[] dataList) params) payable returns (bytes32)",
};
export const SEL = {
  claimFees: "0xc991866d", claimBribes: "0xc2b79e98", vote: "0x6f816a20", approve: "0x095ea7b3", retireCreditViaKlima: "0xa50aa92d",
  execute: "0x3593564c", multicall: "0xac9650d8", sendWnt: "0x7d39aaf1", sendTokens: "0xe6d66ac8", createOrder: "0xf59c48eb",
};
const ERC20 = parseAbi([SIGNATURES.approve]);
const VOTER_VOTE_ABI = parseAbi([SIGNATURES.vote]);
const KLIMA_ABI = parseAbi([SIGNATURES.retireCreditViaKlima]);
const GMX_ABI = parseAbi([SIGNATURES.multicall, SIGNATURES.sendWnt, SIGNATURES.sendTokens, SIGNATURES.createOrder]);
const ROUTER_ABI = parseAbi([SIGNATURES.execute]);
/**
 * The Universal Router commands and the v4 actions a swap may hold: exactly the ones the two kits build, by their exact byte
 * (so a command with the allow-revert flag set is refused too). Read on 2026-11-18 from Uniswap's own Commands.sol
 * (universal-router) and Actions.sol (v4-periphery). Anything else is refused: no Permit2 pull, no transfer, no pay-portion.
 */
export const ROUTER_CMD = { V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 };
export const V4_ACT = { SWAP_EXACT_IN: 0x07, SETTLE: 0x0b, TAKE: 0x0e };
/** The router's two stand-in addresses: "whoever sent this transaction" and "the router itself". */
export const MSG_SENDER = "0x0000000000000000000000000000000000000001";
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
/** The router's "spend its whole balance" amount (1 << 255): what each later hop of a buy spends. */
export const CONTRACT_BALANCE = 1n << 255n;

// ---- caps ----------------------------------------------------------------------------------------------------------
/** The most kVCM one approval may cover and the most USDC one GMX approval may cover: the kits' own starter caps. */
export const MAX_KVCM_APPROVE = 100n * 10n ** 18n;
export const MAX_GMX_USDC = 5n * 1_000_000n;
/** The most ETH a GMX order may carry as its execution fee (GMX refunds the unused part). */
export const MAX_GMX_EXECUTION_FEE_WEI = parseEther("0.005");
/** The most ETH one swap leg may carry, whatever size you ask for: the kits' own cap for a swap is 0.05 ETH. */
export const MAX_LEG_ETH_WEI = parseEther("0.05");
export const DEFAULTS = { everyMinutes: 60, buyEveryHours: 24, dayFeeEth: "0.001", daySpendEth: "0.02", maxTxFeeEth: "0.0005", hydrexTop: 10, gmxHoldHours: 24 };
export const HARD_MAX = { dayFeeWei: parseEther("0.05"), daySpendWei: parseEther("1"), maxTxFeeWei: parseEther("0.01") };
const KIT_TIMEOUT_MS = 180_000;
const RECEIPT_TIMEOUT_MS = 180_000;
const DAY_MS = 24 * 3600_000;
const MAX_WALL_CLOCK_DRIFT_MS = 120_000;
const MAX_CHAIN_TIME_DRIFT_MS = 300_000;
/** Independent chain-time guard used by the real live IO, never kit prose. */
export async function assertChainClock(ctx, chain) {
  if (!ctx.live || typeof ctx.io.chainTime !== "function") return;
  const chainMs = await ctx.io.chainTime(chain);
  const wallMs = ctx.safeNow ? ctx.safeNow() : ctx.now();
  if (!Number.isSafeInteger(chainMs) || Math.abs(chainMs - wallMs) > MAX_CHAIN_TIME_DRIFT_MS)
    throw new GuardError(`the ${chain} node time disagrees with the bot clock by more than 5 minutes; no signing or broadcast is allowed`);
}

/**
 * Verify an explicitly UTC, calendar-real timestamp. Do not let ambiguous
 * locale formats or rolled-over calendar dates affect budget accounting.
 */
export function recordedTime(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))
    throw new GuardError("transaction timestamp must be an explicit UTC ISO-8601 instant");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19))
    throw new GuardError("transaction timestamp has an invalid calendar date");
  return parsed;
}

/**
 * Detect clock leaps while this bot process is running, even if the system
 * wall clock changes sharply during an RPC call. A restart creates a new
 * baseline; this is not an independent source of trusted chain time.
 */
export function makeClockGuard(wall = () => Date.now(), monotonic = () => process.hrtime.bigint(), toleranceMs = MAX_WALL_CLOCK_DRIFT_MS) {
  const wall0 = wall(), mono0 = monotonic();
  if (!Number.isSafeInteger(wall0) || typeof mono0 !== "bigint" || wall0 < 0)
    throw new GuardError("cannot establish a valid monotonic clock baseline");
  return () => {
    const w = wall(), m = monotonic();
    if (!Number.isSafeInteger(w) || typeof m !== "bigint" || m < mono0 ||
        Math.abs(w - wall0 - Number((m - mono0) / 1_000_000n)) > toleranceMs)
      throw new GuardError("system wall clock disagrees with monotonic time; refusing to trade until the clock is repaired and the bot is restarted");
    return w;
  };
}

/**
 * RULES: every contract call this program can sign, per leg. `value` is "zero" (no ETH may ride along), "size" (at most the
 * size you set for that leg) or "fee" (at most the GMX execution-fee cap). An approval also names its one spender and its cap.
 */
export const RULES = {
  hydrex: [
    { chain: "base", to: ADDR.hydrexVoter, fn: "claimFees", value: "zero" },
    { chain: "base", to: ADDR.hydrexVoter, fn: "claimBribes", value: "zero" },
    { chain: "base", to: ADDR.hydrexVoter, fn: "vote", value: "zero" },
  ],
  klima: [
    { chain: "base", to: ADDR.kvcm, fn: "approve", value: "zero", spender: ADDR.klimaAssetManager, maxAmount: MAX_KVCM_APPROVE },
    { chain: "base", to: ADDR.klimaAggregator, fn: "retireCreditViaKlima", value: "zero" },
  ],
  regen: [{ chain: "base", to: ADDR.universalRouter, fn: "execute", value: "size", router: "buy" }],
  eco: [{ chain: "base", to: ADDR.universalRouter, fn: "execute", value: "size", router: "buy" }],
  "eco-buy": [{ chain: "base", to: ADDR.universalRouter, fn: "execute", value: "size", router: "netbuy", token: ADDR.eco }],
  "net-buy": [{ chain: "base", to: ADDR.universalRouter, fn: "execute", value: "size", router: "netbuy", token: ADDR.net }],
  circle: [{ chain: "base", to: ADDR.universalRouter, fn: "execute", value: "size", router: "trip" }],
  gmx: [
    { chain: "arbitrum", to: ADDR.arbitrumUsdc, fn: "approve", value: "zero", spender: ADDR.gmxRouter, maxAmount: MAX_GMX_USDC },
    { chain: "arbitrum", to: ADDR.gmxExchangeRouter, fn: "multicall", value: "fee", gmx: true },
  ],
};

export class ArgError extends Error {}
/** A step the rules refuse. Nothing was sent; the leg stops and is never retried unchanged. */
export class GuardError extends Error {}

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
/** Words from a kit or a node, safe on a terminal: printable ASCII, one line, capped. */
export const clean = (s, max = 240) => String(s ?? "").replace(/[^\x20-\x7E]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const big = (v) => { try { return BigInt(v); } catch { return null; } };
const eth = (wei) => `${formatEther(wei)} ETH`;
/**
 * Decimals of the tokens a send names, pinned here on purpose (a test holds each equal to the kit's own pool constant). The
 * circle kit prints a buy's floor in RAW units of an 18 decimal token; the protocol kit prints it already in token units.
 */
export const TOKEN_DECIMALS = Object.freeze({ ETH: 18, axlREGEN: 6, ECO: 18, NET: 18, kVCM: 18, USDC: 6 });
/**
 * An amount in a token's own terms: { token, amount, amountRaw }, both as strings. `amount` is the decimal in token units and
 * `amountRaw` the integer in the token's smallest unit. `raw` is a bigint or an integer string; `decimal` is a decimal string
 * in token units (exactly one of the two). Returns null when the symbol is unknown or the figure is not a plain number.
 */
export function tokenAmount(token, { raw, decimal } = {}) {
  const decimals = TOKEN_DECIMALS[token];
  if (decimals === undefined) return null;
  try {
    if (decimal !== undefined) {
      const d = String(decimal);
      if (!/^\d+(\.\d+)?$/.test(d) || (d.split(".")[1] ?? "").length > decimals) return null;
      raw = parseUnits(d, decimals);
    } else if (typeof raw !== "bigint") {
      if (!/^(0|[1-9]\d*)$/.test(String(raw))) return null;
      raw = BigInt(raw);
    }
    if (raw < 0n) return null;
    return { token, amount: formatUnits(raw, decimals), amountRaw: raw.toString() };
  } catch { return null; }
}
/** Say in plain words what an amount is (the least you get, the most it may spend, an approval), or keep null. */
const as = (amount, is) => (amount ? { ...amount, is } : null);

/**
 * The gate every step passes before it is signed. Returns null when the step is on the list, or the reason it is refused.
 * Pure: no network, no key. `sizeWei` is the size you set for that leg (only read by "size" rules).
 */
export function checkTx(leg, tx, { from, sizeWei = 0n, maxTxFeeWei, gmxIntent = null, hydrexVote = null, klimaIntent = null }) {
  const rules = RULES[leg];
  if (!rules) return `no rules for a leg named ${clean(leg, 20)}`;
  if (!tx || typeof tx !== "object") return "the kit printed no step";
  if (!isAddress(String(tx.to ?? "")) || typeof tx.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(tx.data) || tx.data.length < 10) return "the step is not a well formed contract call";
  const value = big(tx.value ?? 0), gas = big(tx.gas), feePer = big(tx.maxFeePerGas), tip = big(tx.maxPriorityFeePerGas);
  if (value === null || value < 0n) return "the step's value is not a number";
  if (gas === null || gas <= 0n || feePer === null || feePer <= 0n || tip === null || tip < 0n || tip > feePer) return "the step's gas or fee fields are missing or wrong";
  const selector = tx.data.slice(0, 10).toLowerCase();
  const rule = rules.find((r) => same(r.to, tx.to) && SEL[r.fn] === selector);
  if (!rule) return `not on the list for ${leg}: a call to ${clean(tx.to, 42)} with function ${selector}`;
  if (Number(tx.chainId) !== CHAINS[rule.chain].id) return `the step is for chain ${clean(tx.chainId, 12)}, and ${leg} runs on ${rule.chain} (${CHAINS[rule.chain].id})`;
  if (rule.value === "zero" && value !== 0n) return `${rule.fn} may carry no ETH, and this step carries ${eth(value)}`;
  if (rule.value === "size") {
    if (!(sizeWei > 0n)) return `${leg} has no size set, so it may spend nothing`;
    if (value > sizeWei || value > MAX_LEG_ETH_WEI) return `the step spends ${eth(value)}, above the ${eth(sizeWei < MAX_LEG_ETH_WEI ? sizeWei : MAX_LEG_ETH_WEI)} this leg may spend`;
  }
  if (rule.value === "fee" && value > MAX_GMX_EXECUTION_FEE_WEI) return `the execution fee ${eth(value)} is above the cap ${eth(MAX_GMX_EXECUTION_FEE_WEI)}`;
  const l1 = big(tx.l1FeeBoundWei ?? 0);
  if (l1 === null || l1 < 0n) return "the Base data-fee bound is malformed or negative; refusing to underestimate gas";
  const feeBound = gas * feePer + l1;
  if (feeBound > maxTxFeeWei) return `the step could cost ${eth(feeBound)} in fees, above your cap of ${eth(maxTxFeeWei)} for one transaction`;
  if (rule.fn === "approve") {
    let args; try { args = decodeFunctionData({ abi: ERC20, data: tx.data }).args; } catch { return "the approval does not decode"; }
    if (!same(args[0], rule.spender)) return `the approval names ${clean(args[0], 42)} as spender, not ${rule.spender}`;
    if (args[1] > rule.maxAmount) return `the approval covers ${args[1]} units, above the cap ${rule.maxAmount}`;
    if (leg === "gmx" && gmxIntent && typeof gmxIntent === "object" && gmxIntent.action === "open" && args[1] !== gmxIntent.collateralUnits)
      return "the GMX USDC approval must match the owner's exact collateral size";
  }
  if (rule.fn === "vote") {
    if (!validVote(hydrexVote)) return "the Hydrex vote has no valid, explicit owner intent";
    let args;
    try { args = decodeFunctionData({ abi: VOTER_VOTE_ABI, data: tx.data }).args; }
    catch { return "the Hydrex vote calldata does not decode"; }
    const expected = hydrexVote.split(",").map((part) => {
      const [pool, weight] = part.split(":");
      return { pool, weight: BigInt(weight) };
    });
    if (args[0].length !== expected.length || args[1].length !== expected.length ||
        expected.some((v, i) => !same(args[0][i], v.pool) || args[1][i] !== v.weight))
      return "the Hydrex vote pools or weights differ from the exact selected vote";
  }
  if (rule.fn === "retireCreditViaKlima") {
    let args; try { args = decodeFunctionData({ abi: KLIMA_ABI, data: tx.data }).args; } catch { return "the Klima retirement does not decode"; }
    if (!same(args[4], ADDR.kvcm)) return "the Klima retirement must spend kVCM, not a different input token";
    if (args[6] <= 0n || args[6] > MAX_KVCM_APPROVE) return `the Klima retirement may spend ${args[6]} kVCM units, outside the cap of ${MAX_KVCM_APPROVE}`;
    if (!klimaIntent) return "a Klima retirement needs an explicit owner-selected credit, class, quantity and beneficiary";
    if (!same(args[0], klimaIntent.credit) || args[1] !== klimaIntent.tokenId || args[2] !== 0n ||
        args[3] !== klimaIntent.tonnes || !same(args[5], klimaIntent.carbonClass) || args[7] !== 0n)
      return "the Klima retirement credit, class, token ID or tonnes differs from the selected intent";
    const details = args[8];
    if (!details || !same(details.retiringAddress, from) || !same(details.beneficiaryAddress, from) ||
        details.retiringEntityString !== klimaIntent.name || details.beneficiaryString !== klimaIntent.name ||
        details.retirementMessage !== "" || details.beneficiaryLocation !== "" || details.consumptionCountryCode !== "" ||
        details.consumptionPeriodStart !== 0n || details.consumptionPeriodEnd !== 0n)
      return "the Klima retirement beneficiary or public onchain details differ from the selected owner";
  }
  if (rule.gmx) {
    const why = checkGmxMulticall(tx.data, { from, value, gmxIntent });
    if (why) return why;
  }
  if (rule.router === "netbuy") {
    const why = checkNetBuy(tx.data, { from, value, token: rule.token });
    if (why) return why;
  } else if (rule.router) {
    const why = checkRouterExecute(tx.data, { from, value, shape: rule.router, feeBound });
    if (why) return why;
    if (rule.router === "buy") {
      const expected = leg === "regen" ? ADDR.axlRegen : leg === "eco" ? ADDR.eco : null;
      if (!expected) return "this buy leg has no independently pinned output token";
      const pinned = checkPinnedOneWayBuy(tx.data, { from, value, expected });
      if (pinned) return pinned;
    }
  }
  return null;
}

const dec = (types, data) => decodeAbiParameters(parseAbiParameters(types), data);
const bytesOf = (hex) => (typeof hex === "string" && hex.length > 2 ? hex.slice(2).match(/../g).map((b) => parseInt(b, 16)) : []);
const hex2 = (n) => `0x${n.toString(16).padStart(2, "0")}`;

/**
 * A swap is one Universal Router call that holds a list of commands. This reads every one. Only the commands and v4 actions
 * the kits build pass; nothing may be paid by pulling from your wallet (the swap spends only the ETH the step carries); and
 * every place tokens come out is you, or the router on the way to you. A "buy" is exactly one v4 swap that settles the ETH it
 * carries and takes the token straight to you. A "trip" must end by sweeping ETH back to you.
 */
function checkRouterExecute(data, { from, value, shape, feeBound = 0n }) {
  let commands, inputs;
  try { [commands, inputs] = decodeFunctionData({ abi: ROUTER_ABI, data }).args; } catch { return "the swap does not decode"; }
  const cmds = bytesOf(commands);
  if (!cmds.length || cmds.length !== inputs.length || cmds.length > 12) return "the swap's commands and inputs do not line up";
  if (shape === "buy" && (cmds.length !== 1 || cmds[0] !== ROUTER_CMD.V4_SWAP)) return "a buy must be one v4 swap and nothing else";
  const you = (a) => same(a, from) || same(a, MSG_SENDER);
  const youOrRouter = (a) => you(a) || same(a, ADDRESS_THIS);
  try {
    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i], input = inputs[i];
      if (c === ROUTER_CMD.V4_SWAP) {
        const [actions, params] = dec("bytes, bytes[]", input);
        const acts = bytesOf(actions);
        if (!acts.length || acts.length !== params.length || acts.length > 12) return "the v4 swap's actions and inputs do not line up";
        for (let j = 0; j < acts.length; j++) {
          const a = acts[j];
          if (a === V4_ACT.SWAP_EXACT_IN) continue; // a swap moves balances inside the pool manager only; settle and take are what move tokens
          if (a === V4_ACT.SETTLE) {
            const [currency, amount, payerIsUser] = dec("address, uint256, bool", params[j]);
            if (payerIsUser) return "the swap would pull a token from your wallet";
            if (shape === "buy" && (!same(currency, ZERO) || amount !== value)) return "a buy must spend exactly the ETH the step carries";
          } else if (a === V4_ACT.TAKE) {
            const [, recipient] = dec("address, address, uint256", params[j]);
            if (shape === "buy" ? !you(recipient) : !youOrRouter(recipient)) return "the swap pays out to an address that is not yours";
          } else return `the v4 swap holds an action that is not on the list (${hex2(a)})`;
        }
      } else if (c === ROUTER_CMD.V3_SWAP_EXACT_IN) {
        const [recipient, , , , payerIsUser] = dec("address, uint256, uint256, bytes, bool", input);
        if (payerIsUser) return "the swap would pull a token from your wallet";
        if (!youOrRouter(recipient)) return "the swap pays out to an address that is not yours";
      } else if (c === ROUTER_CMD.SWEEP) {
        const [, recipient] = dec("address, address, uint256", input);
        if (!you(recipient)) return "the swap sweeps to an address that is not yours";
      } else if (c === ROUTER_CMD.WRAP_ETH) {
        const [recipient, amount] = dec("address, uint256", input);
        if (!youOrRouter(recipient)) return "the swap wraps ETH for an address that is not yours";
        if (amount > value) return "the swap wraps more ETH than the step carries";
      } else if (c === ROUTER_CMD.UNWRAP_WETH) {
        const [recipient] = dec("address, uint256", input);
        if (!you(recipient)) return "the swap unwraps to an address that is not yours";
      } else return `the swap holds a command that is not on the list (${hex2(c)})`;
    }
    if (shape === "trip") {
      // A kit's free-text claim of "profit after gas" is not an authorization.
      // The signed calldata itself must enforce input + worst-case signed gas.
      const last = cmds.length - 1;
      if (cmds[last] !== ROUTER_CMD.SWEEP) return "a trip must end by sweeping ETH back to you";
      const [token, recipient, sweepFloor] = dec("address, address, uint256", inputs[last]);
      if (!same(token, ZERO) || !you(recipient)) return "a trip must end by sweeping ETH back to you";
      if (value <= 0n) return "a trip must carry positive ETH into the route";
      const wraps = cmds.map((c, i) => c === ROUTER_CMD.WRAP_ETH ? i : -1).filter((i) => i >= 0);
      const unwraps = cmds.map((c, i) => c === ROUTER_CMD.UNWRAP_WETH ? i : -1).filter((i) => i >= 0);
      const wrapped = wraps.length === 1 && wraps[0] === 0;
      if (wraps.length > (wrapped ? 1 : 0)) return "a trip may wrap ETH exactly once at its start";
      if (!cmds.some((c) => c === ROUTER_CMD.V3_SWAP_EXACT_IN || c === ROUTER_CMD.V4_SWAP)) return "a trip must include a real swap, not only a refund";
      if (wrapped) {
        const [r, amount] = dec("address, uint256", inputs[0]);
        if (!same(r, ADDRESS_THIS) || amount !== value) return "a trip must wrap exactly its ETH for the router";
        // This is the kit's sole early SWEEP: refund any ETH that was not wrapped.
        if (cmds[1] !== ROUTER_CMD.SWEEP) return "a wrapped trip must carry the kit's one ETH refund immediately after wrapping";
        const [refundToken, refundTo, refundFloor] = dec("address, address, uint256", inputs[1]);
        if (!same(refundToken, ZERO) || !you(refundTo) || refundFloor !== 0n) return "the wrapped trip's early refund has unexpected currency, recipient or floor";
      } else {
        if (cmds[0] !== ROUTER_CMD.V4_SWAP) return "a native-ETH trip must begin with a v4 swap";
        const [actions, params] = dec("bytes, bytes[]", inputs[0]);
        const acts = bytesOf(actions), ix = acts.indexOf(V4_ACT.SETTLE);
        if (ix < 0) return "a native-ETH trip has no initial ETH settlement";
        const [currency, amount, payer] = dec("address, uint256, bool", params[ix]);
        if (!same(currency, ZERO) || amount !== value || payer) return "a native-ETH trip must settle exactly its ETH without pulling from the wallet";
      }
      if (unwraps.length > 1 || (unwraps.length === 1 && unwraps[0] !== last - 1)) return "a trip's ETH unwrap must be immediately before its final refund";
      for (let i = 0; i < last; i++) {
        if (cmds[i] === ROUTER_CMD.SWEEP && !(wrapped && i === 1)) return "a trip contains an extra early sweep";
      }
      const floor = unwraps.length
        ? dec("address, uint256", inputs[last - 1])[1]
        : sweepFloor;
      if (unwraps.length && sweepFloor !== 0n) return "a WETH-ending trip's last ETH refund must have zero floor";
      if (floor < value + feeBound) return "the trip's onchain minimum ETH return does not cover the input and signed gas fee";
    }
  } catch { return "the swap holds an input that does not decode"; }
  return null;
}

/** Authorize the exact single-pool direct ETH buy, independently of the kit response text. */
function checkPinnedOneWayBuy(data, { from, value, expected }) {
  let args;
  try { args = decodeFunctionData({ abi: ROUTER_ABI, data }).args; }
  catch { return "the direct buy router calldata does not decode"; }
  const [commands, inputs] = args;
  if (cmdsKey(bytesOf(commands)) !== cmdsKey([ROUTER_CMD.V4_SWAP]) || inputs.length !== 1)
    return "the direct buy must contain exactly one v4 swap";
  try {
    const [actions, params] = dec("bytes, bytes[]", inputs[0]);
    if (cmdsKey(bytesOf(actions)) !== cmdsKey([V4_ACT.SETTLE, V4_ACT.SWAP_EXACT_IN, V4_ACT.TAKE]) || params.length !== 3)
      return "the direct buy action sequence is not the pinned kit shape";
    const [settleCurrency, amount, payer] = dec("address, uint256, bool", params[0]);
    const [currency, hops, amountIn, minOut] = dec("(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", params[1])[0];
    const [takeCurrency, recipient, takeAmount] = dec("address, address, uint256", params[2]);
    if (!same(settleCurrency, ZERO) || !same(currency, ZERO) || amount !== value || payer || amountIn !== 0n)
      return "the direct buy must use exactly its native ETH and no wallet token";
    if (!Array.isArray(hops) || hops.length !== 1)
      return "the direct buy must use exactly one pinned pool";
    const [tokenOut, fee, spacing, hook, hookData] = hops[0];
    if (!same(tokenOut, expected) || Number(fee) !== 10000 || Number(spacing) !== 200 ||
        !same(hook, ZERO) || hookData !== "0x")
      return "the direct buy pool or output token differs from its pinned route";
    if (!same(takeCurrency, expected) || !(same(recipient, from) || same(recipient, MSG_SENDER)) || takeAmount !== 0n)
      return "the direct buy take does not pay its exact output token to the owner";
    if (minOut <= 0n) return "the direct buy must enforce a positive onchain minimum output";
  } catch { return "the direct buy has malformed inner calldata"; }
  return null;
}
/**
 * The gate for the NET circle kit's one-way BUY (`net-circle buy`): ETH in, one named token out, to you. The call is an optional
 * WRAP_ETH, then one or more swaps (v4 or v3), then ONE sweep of that token to you with a floor above zero, last. The first
 * swap spends exactly the ETH the step carries (a wrap of exactly that and a settle of exactly that, or a native settle of
 * exactly that); every later hop spends the router's balance; every intermediate output stays in the router; nothing is
 * pulled from your wallet. So the step either leaves you holding at least the floor of the leg's token, or reverts.
 */
function checkNetBuy(data, { from, value, token }) {
  let commands, inputs;
  try { [commands, inputs] = decodeFunctionData({ abi: ROUTER_ABI, data }).args; } catch { return "the buy does not decode"; }
  const cmds = bytesOf(commands);
  if (cmds.length < 2 || cmds.length !== inputs.length || cmds.length > 8) return "the buy's commands and inputs do not line up";
  const last = cmds.length - 1;
  try {
    if (cmds[last] !== ROUTER_CMD.SWEEP) return "a buy must end by sweeping the token to you";
    const [sweepToken, sweepTo, floor] = dec("address, address, uint256", inputs[last]);
    if (!same(sweepToken, token)) return "the buy must end in the token this leg buys";
    if (!same(sweepTo, from) && !same(sweepTo, MSG_SENDER)) return "the buy sweeps to an address that is not yours";
    if (!(floor > 0n)) return "the buy has no floor: it must revert unless some of the token arrives";
    let wrapped = false, swaps = 0;
    for (let i = 0; i < last; i++) {
      const c = cmds[i], input = inputs[i];
      if (c === ROUTER_CMD.WRAP_ETH) {
        if (i !== 0) return "a buy wraps ETH only at its start";
        const [recipient, amount] = dec("address, uint256", input);
        if (!same(recipient, ADDRESS_THIS)) return "the buy wraps ETH for an address that is not the router";
        if (amount !== value) return "a buy must wrap exactly the ETH the step carries";
        wrapped = true;
      } else if (c === ROUTER_CMD.V4_SWAP) {
        const first = swaps === 0;
        swaps += 1;
        const [actions, params] = dec("bytes, bytes[]", input);
        if (cmdsKey(bytesOf(actions)) !== cmdsKey([V4_ACT.SETTLE, V4_ACT.SWAP_EXACT_IN, V4_ACT.TAKE]) || params.length !== 3) return "a buy's v4 swap must be exactly settle, swap, take";
        const [currency, amount, payerIsUser] = dec("address, uint256, bool", params[0]);
        if (payerIsUser) return "the swap would pull a token from your wallet";
        if (first) {
          if (wrapped === same(currency, ZERO)) return "the first swap of a buy must spend what the step started with (the wrapped ETH, or the native ETH when nothing is wrapped)";
          if (amount !== value) return "a buy must spend exactly the ETH the step carries";
        } else if (amount !== CONTRACT_BALANCE) return "a later hop of a buy must spend the router's balance, nothing else";
        const [, recipient] = dec("address, address, uint256", params[2]);
        if (!same(recipient, ADDRESS_THIS)) return "a buy's hop must pay out to the router, so the one sweep at the end is the only payout";
      } else if (c === ROUTER_CMD.V3_SWAP_EXACT_IN) {
        const first = swaps === 0;
        swaps += 1;
        const [recipient, amount, , , payerIsUser] = dec("address, uint256, uint256, bytes, bool", input);
        if (payerIsUser) return "the swap would pull a token from your wallet";
        if (!same(recipient, ADDRESS_THIS)) return "a buy's hop must pay out to the router, so the one sweep at the end is the only payout";
        if (first) {
          if (!wrapped) return "a v3 swap cannot spend native ETH: a buy that starts with one must wrap first";
          if (amount !== value) return "a buy must spend exactly the ETH the step carries";
        } else if (amount !== CONTRACT_BALANCE) return "a later hop of a buy must spend the router's balance, nothing else";
      } else return `the buy holds a command that is not on the list (${hex2(c)})`;
    }
    if (swaps === 0) return "a buy must hold a swap that spends the ETH";
    // Do not trust a kit's route label or the final SWEEP alone. Decode the actual swap
    // currencies, pool fees and hook addresses, and require a known ETH-to-token route.
    const routeWhy = checkNetBuyRoute(cmds, inputs, { wrapped, token });
    if (routeWhy) return routeWhy;
  } catch { return "the buy holds an input that does not decode"; }
  return null;
}
const cmdsKey = (list) => list.join(",");

/**
 * Independently validate what each swap really trades, not merely what its final
 * SWEEP asks to withdraw. The coin pool key is pinned to ECO's registered Zora
 * pool; an arbitrary hook or fee is NOT a permitted replacement.
 */
const BUY_WETH = "0x4200000000000000000000000000000000000006";
const BUY_ZORA = "0x1111111111166b7FE7bd91427724B487980aFc69";
const BUY_ZORA_HOOK = "0xd61A675F8a0c67A73DC3B54FB7318B4D91409040";
const BUY_EDGES = [
  { from: ZERO, to: ADDR.net, v: 4, fee: 100, tick: 1, hook: ZERO },
  { from: BUY_WETH, to: ADDR.net, v: 4, fee: 100, tick: 1, hook: ZERO },
  { from: ZERO, to: ADDR.eco, v: 4, fee: 10000, tick: 200, hook: ZERO },
  { from: ADDR.net, to: ADDR.eco, v: 4, fee: 100, tick: 1, hook: ZERO },
  { from: BUY_WETH, to: BUY_ZORA, v: 3, fee: 3000 },
  { from: BUY_ZORA, to: ADDR.eco, v: 4, fee: 30000, tick: 200, hook: BUY_ZORA_HOOK },
];
const buyPath = (...a) => a.map((v) => v.toLowerCase()).join(">");
const BUY_PATHS = {
  [ADDR.net.toLowerCase()]: [
    buyPath(ZERO, ADDR.net), buyPath(BUY_WETH, ADDR.net),
  ],
  [ADDR.eco.toLowerCase()]: [
    buyPath(ZERO, ADDR.eco), buyPath(ZERO, ADDR.net, ADDR.eco),
    buyPath(BUY_WETH, ADDR.net, ADDR.eco), buyPath(BUY_WETH, BUY_ZORA, ADDR.eco),
  ],
};
const buyEdge = (v, from, to, fee, tick, hook) => BUY_EDGES.some((e) =>
  e.v === v && same(e.from, from) && same(e.to, to) && e.fee === Number(fee)
  && (v === 3 || (e.tick === Number(tick) && same(e.hook, hook))));

/** A v3 path is 20-byte token, then (3-byte fee + 20-byte token) per hop. */
function decodeBuyV3Path(packed) {
  if (typeof packed !== "string" || !/^0x[0-9a-fA-F]+$/.test(packed)) return null;
  const h = packed.slice(2);
  if (h.length < 86 || (h.length - 40) % 46 !== 0) return null;
  const tokens = [`0x${h.slice(0, 40)}`], fees = [];
  for (let i = 40; i < h.length; i += 46) {
    fees.push(parseInt(h.slice(i, i + 6), 16));
    tokens.push(`0x${h.slice(i + 6, i + 46)}`);
  }
  return { tokens, fees };
}

function checkNetBuyRoute(cmds, inputs, { wrapped, token }) {
  const path = [wrapped ? BUY_WETH : ZERO];
  let current = path[0];
  for (let i = wrapped ? 1 : 0; i < cmds.length - 1; i++) {
    if (cmds[i] === ROUTER_CMD.V4_SWAP) {
      const [actions, params] = dec("bytes, bytes[]", inputs[i]);
      if (cmdsKey(bytesOf(actions)) !== cmdsKey([V4_ACT.SETTLE, V4_ACT.SWAP_EXACT_IN, V4_ACT.TAKE]) || params.length !== 3) return "the buy's v4 actions changed";
      const [settled] = dec("address, uint256, bool", params[0]);
      const [exactIn, hops, amountIn, minOut] = dec("(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", params[1])[0];
      const [taken, , takeAmount] = dec("address, address, uint256", params[2]);
      if (!same(settled, current) || !same(exactIn, current)) return "the buy's swap spends a different input token than the preceding hop produced";
      if (!Array.isArray(hops) || !hops.length || hops.length > 2 || amountIn !== 0n || minOut !== 0n) return "the buy's v4 swap is not the kit's exact-input shape";
      for (const [out, fee, tick, hook, hookData] of hops) {
        if (hookData !== "0x" || !buyEdge(4, current, out, fee, tick, hook)) return "the buy's v4 pool, fee or hook is not on the permitted routes";
        current = out;
        path.push(current);
      }
      if (!same(taken, current) || takeAmount !== 0n) return "the buy's v4 take currency or amount does not match its swap output";
    } else if (cmds[i] === ROUTER_CMD.V3_SWAP_EXACT_IN) {
      const [, , minOut, packed] = dec("address, uint256, uint256, bytes, bool", inputs[i]);
      const p = decodeBuyV3Path(packed);
      if (!p || !same(p.tokens[0], current) || minOut !== 0n) return "the buy's v3 path does not begin in the token it holds";
      for (let j = 0; j < p.fees.length; j++) {
        if (!buyEdge(3, current, p.tokens[j + 1], p.fees[j])) return "the buy's v3 pool or fee is not on the permitted routes";
        current = p.tokens[j + 1];
        path.push(current);
      }
    } else return "the buy has an unexpected command in its route";
  }
  if (!same(current, token) || !BUY_PATHS[token.toLowerCase()]?.includes(buyPath(...path))) return "the buy's decoded token path is not one of the permitted routes for this token";
  return null;
}

/**
 * An exact GMX starter order: the wallet chooses a market and direction, but the
 * unsigned kit must not change a market order into another order type, add a
 * withdrawal/receiver, silently increase leverage or spend more collateral.
 * This checks calldata, not the kit's free-text summary.
 */
function checkGmxMulticall(data, { from, value, gmxIntent }) {
  let calls; try { calls = decodeFunctionData({ abi: GMX_ABI, data }).args[0]; } catch { return "the GMX multicall does not decode"; }
  let fee = 0n, collateral = 0n, order = null;
  const names = [];
  for (const inner of calls) {
    let d; try { d = decodeFunctionData({ abi: GMX_ABI, data: inner }); } catch { return "the GMX multicall holds a call that is not on the list"; }
    names.push(d.functionName);
    if (d.functionName === "sendWnt") {
      if (!same(d.args[0], ADDR.gmxOrderVault)) return "the execution fee goes somewhere other than GMX's order vault";
      fee += d.args[1];
    } else if (d.functionName === "sendTokens") {
      if (!same(d.args[0], ADDR.arbitrumUsdc) || !same(d.args[1], ADDR.gmxOrderVault)) return "the collateral is not USDC to GMX's order vault";
      collateral += d.args[2];
      if (collateral > MAX_GMX_USDC) return `the total collateral ${collateral} units is above the cap ${MAX_GMX_USDC}`;
    } else if (d.functionName === "createOrder") {
      if (order) return "the GMX multicall must hold exactly one order";
      order = d.args[0];
      const a = order.addresses;
      if (!same(a.receiver, from)) return "the order pays out to an address that is not yours";
      if (!same(a.cancellationReceiver, ZERO) && !same(a.cancellationReceiver, from)) return "the order's cancellation refund goes to an address that is not yours";
      if (!same(a.callbackContract, ZERO) || !same(a.uiFeeReceiver, ZERO)) return "the order names a callback or a fee receiver";
      if (!same(a.initialCollateralToken, ADDR.arbitrumUsdc) || a.swapPath.length !== 0) return "the order's collateral is not plain USDC";
      if (!isAddress(a.market) || same(a.market, ZERO)) return "the GMX order has no valid market address";
    } else return "the GMX multicall holds a call that is not on the list";
  }
  if (!order) return "the GMX multicall must hold exactly one order";
  if (calls.length < 2 || calls.length > 3) return "the GMX multicall must hold one exact market order";
  // Every wei the step carries must go to the order vault as the fee; no fee can sit in the router.
  if (fee !== value || fee !== order.numbers.executionFee || fee <= 0n) return "the execution fee inside the order is not exactly the ETH the step carries";
  const isOpen = order.orderType === 2; // GMX MarketIncrease
  const isClose = order.orderType === 4; // GMX MarketDecrease
  if (!isOpen && !isClose) return "the GMX order type must be market increase or market decrease";
  if (gmxIntent) {
    const intentAction = typeof gmxIntent === "string" ? gmxIntent : gmxIntent.action;
    if (intentAction !== (isOpen ? "open" : "close")) return "the GMX order type does not match the bot's open or close action";
    if (typeof gmxIntent === "object") {
      if (!gmxIntent.market || !same(order.addresses.market, gmxIntent.market)) return "the GMX order market does not match the owner's selected market";
      if (order.isLong !== gmxIntent.isLong) return "the GMX order direction does not match the owner's selected side";
    }
  }
  if (names.join(",") !== (isOpen ? "sendWnt,sendTokens,createOrder" : "sendWnt,createOrder")) return "the GMX order calls are not in the kit's exact fee, collateral, order sequence";
  const n = order.numbers;
  if (n.triggerPrice !== 0n || n.acceptablePrice <= 0n || n.callbackGasLimit !== 0n || n.minOutputAmount !== 0n || n.validFromTime !== 0n) return "the GMX order has unexpected trigger, price or callback settings";
  if (order.shouldUnwrapNativeToken || order.autoCancel || order.referralCode !== `0x${"00".repeat(32)}` || order.dataList.length !== 0) return "the GMX order has non-starter flags, referral or data";
  if (order.decreasePositionSwapType !== (isOpen ? 0 : 1)) return "the GMX order has an unexpected decrease swap setting";
  if (!(n.sizeDeltaUsd > 0n)) return "the GMX order size must be positive";
  if (isOpen) {
    if (collateral <= 0n || n.initialCollateralDeltaAmount !== collateral) return "the GMX open order's USDC collateral does not match what was sent to the vault";
    // The kit's exact scale: USDC 6 decimals * leverage tenths * 1e23 => GMX USD 30 decimals.
    const baseUsd = collateral * 10n ** 23n;
    if (n.sizeDeltaUsd < baseUsd * 10n || n.sizeDeltaUsd > baseUsd * 100n) return "the GMX open order's size implies leverage outside 1x to 10x";
    if (gmxIntent && typeof gmxIntent === "object") {
      if (collateral !== gmxIntent.collateralUnits) return "the GMX order collateral does not match the owner's selected USDC";
      if (n.sizeDeltaUsd !== collateral * gmxIntent.leverageTenths * 10n ** 23n) return "the GMX order leverage does not match the owner's selected leverage";
    }
  } else {
    if (collateral !== 0n || n.initialCollateralDeltaAmount !== 0n) return "the GMX close order must send no new USDC collateral";
    if (gmxIntent && typeof gmxIntent === "object" && n.sizeDeltaUsd !== gmxIntent.closeSizeUsd) return "the GMX close order size does not match the owner's live position";
  }
  return null;
}

// ---- the key: read on this machine only, never printed ---------------------------------------------------------------
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const validKey = (k) => KEY_RE.test(k) && BigInt(k) > 0n && BigInt(k) < CURVE_N;

/** Read a key file. Refused unless it is a plain file that only its owner can read. The key never leaves this function's caller. */
export function loadAccount(keyFile) {
  let st; try { st = fs.lstatSync(keyFile); } catch { throw new ArgError(`no key file at ${keyFile}: run \`node bot.mjs wallet\` to make one, or pass --key-file`); }
  if (!st.isFile() || st.nlink !== 1 || (typeof process.getuid === "function" && st.uid !== process.getuid()))
    throw new ArgError(`${keyFile} must be an owner-held regular file with exactly one hardlink`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new ArgError(`${keyFile} can be read by other users of this machine: run chmod 600 on it first`);
  const key = fs.readFileSync(keyFile, "utf8").trim();
  if (!validKey(key)) throw new ArgError(`${keyFile} does not hold one private key (0x and 64 hex characters)`);
  return privateKeyToAccount(key);
}
/** Make the bot's own wallet. Never overwrites a key file. Returns the address only. */
export function makeWallet(keyFile) {
  if (fs.existsSync(keyFile)) return { address: loadAccount(keyFile).address, made: false };
  const keyDir = path.dirname(keyFile);
  const previouslyExisted = fs.existsSync(keyDir);
  fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(keyDir);
  if (!st.isDirectory() || st.isSymbolicLink() ||
      (process.platform !== "win32" && (st.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && st.uid !== process.getuid()))
    throw new ArgError("key directory must be a private, owner-held real directory (mode 700)");
  if (!previouslyExisted) syncDirectory(path.dirname(keyDir));
  let key; do { key = `0x${randomBytes(32).toString("hex")}`; } while (!validKey(key));
  const fd = fs.openSync(keyFile, "wx", 0o600);
  try { fs.writeFileSync(fd, `${key}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  // Report the new wallet address only after the key filename is durable.
  syncDirectory(keyDir);
  return { address: privateKeyToAccount(key).address, made: true };
}

// ---- the kits: separate programs, no shell, an environment with nothing in it but what they read --------------------
/** The only environment a kit gets: where programs live, and the node addresses you chose. A test holds this list. */
export function kitEnv(rpcs, env = process.env) {
  const out = { PATH: env.PATH ?? "", HOME: env.HOME ?? "" };
  if (rpcs.base) out.BASE_RPC_URL = rpcs.base;
  if (rpcs.arbitrum) out.ARBITRUM_RPC_URL = rpcs.arbitrum;
  return out;
}
/** Run one kit command with --json. Resolves { code, out } where out is the parsed answer, or null when it printed none. */
export function runKit(file, args, rpcs) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, ...args, "--json"], { env: kitEnv(rpcs), timeout: KIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      let out = null; try { out = JSON.parse(stdout); } catch { out = null; }
      resolve({ code, out, err: clean(stderr, 300) });
    });
  });
}

// ---- sending: your key, your node, one transaction at a time ---------------------------------------------------------
/**
 * Only a finalized receipt of the EXACT hash we sent can free the durable
 * pending barrier. RPC disagreement, a replacement, missing finalized block,
 * or a reorg leaves it unresolved. Never infer success from a 1-block receipt.
 */
export async function finalizedReceiptStatus(pub, receipt, expectedHash) {
  if (!receipt || !same(receipt.transactionHash, expectedHash) ||
      typeof receipt.blockNumber !== "bigint" || !isAddressHash(receipt.blockHash)) return null;
  if (receipt.status !== "success" && receipt.status !== "reverted") return null;
  const finalized = await pub.getBlock({ blockTag: "finalized" });
  if (!finalized || typeof finalized.number !== "bigint" || finalized.number < receipt.blockNumber) return null;
  const canonical = await pub.getBlock({ blockNumber: receipt.blockNumber });
  if (!canonical || !same(canonical.hash, receipt.blockHash)) return null;
  return receipt.status === "success";
}
/**
 * A second RPC must independently attest the EXACT same transaction, receipt,
 * canonical block and finalized head. Any disagreement or read failure remains
 * UNKNOWN. Never use an optimistic single-node answer to clear a live pending
 * transaction. Two differently named URLs alone cannot guarantee independent
 * infrastructure; choose providers operated separately.
 */
export async function agreedFinalizedReceiptStatus(primary, witness, hash, primaryReceipt = null, expectedChainId = null) {
  if (!witness) return null;
  try {
    if (expectedChainId !== null) {
      const [a, b] = await Promise.all([primary.getChainId(), witness.getChainId()]);
      if (a !== expectedChainId || b !== expectedChainId) return null;
    }
    const [receiptA, receiptB] = await Promise.all([
      primaryReceipt ? Promise.resolve(primaryReceipt) : primary.getTransactionReceipt({ hash }),
      witness.getTransactionReceipt({ hash }),
    ]);
    if (!receiptA || !receiptB || receiptA.blockNumber !== receiptB.blockNumber ||
        receiptA.status !== receiptB.status || !same(receiptA.blockHash, receiptB.blockHash) ||
        !same(receiptA.transactionHash, receiptB.transactionHash)) return null;
    const [resultA, resultB] = await Promise.all([
      finalizedReceiptStatus(primary, receiptA, hash),
      finalizedReceiptStatus(witness, receiptB, hash),
    ]);
    return resultA !== null && resultA === resultB ? resultA : null;
  } catch { return null; }
}
const isAddressHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
/** Reject a nonce already occupied by another in-flight transaction. */
export function assertUncontendedNonce(confirmed, pending, expected = null) {
  if (!Number.isSafeInteger(confirmed) || confirmed < 0 ||
      !Number.isSafeInteger(pending) || pending < 0 || pending !== confirmed)
    throw new GuardError("wallet has an unconfirmed transaction or inconsistent nonce responses; stop rather than replace it");
  if (expected !== null && (!Number.isSafeInteger(expected) || expected !== pending))
    throw new GuardError("wallet nonce changed since local signing; do not broadcast an outdated transaction");
  return pending;
}
/**
 * Live signing needs two independently operated HTTPS RPC hosts for every
 * active signing chain. This is a conservative configuration guard, not a
 * cryptographic proof of operator independence.
 */
export function assertWitnessRpcConfiguration(primaryUrl, witnessUrl, chain) {
  let a, b;
  try { a = new URL(primaryUrl); b = new URL(witnessUrl); }
  catch { throw new ArgError(`live ${chain} requires --${chain}-witness-rpc (a separate HTTPS RPC provider)`); }
  for (const u of [a, b]) {
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.hash)
      throw new ArgError(`live ${chain} primary and witness RPCs must be HTTPS URLs without embedded credentials or fragments`);
  }
  if (a.hostname.toLowerCase() === b.hostname.toLowerCase())
    throw new ArgError(`live ${chain} witness RPC must use a different provider host, not the primary host`);
  return true;
}
export function makeChainIo(account, rpcs, witnessRpcs = {}) {
  const made = {};
  const of = (chain) => (made[chain] ??= {
    pub: createPublicClient({ chain: CHAINS[chain].viem, transport: http(rpcs[chain]) }),
    witness: witnessRpcs[chain] ? createPublicClient({ chain: CHAINS[chain].viem, transport: http(witnessRpcs[chain]) }) : null,
  });
  /**
   * A bot that holds a signing account never acts on one node's word. With no witness for the chain, prepare and broadcast
   * refuse and wait and seen answer unknown (null), so nothing is signed, sent or settled. parseArgs refuses the same setup on
   * the command line; this is the same refusal for code that imports makeChainIo and makeContext directly.
   */
  const witnessOrRefuse = (chain) => {
    const witness = of(chain).witness;
    if (!witness) throw new GuardError(`no ${chain} witness RPC is set (--${chain}-witness-rpc); a signing bot never signs or sends on one node's word`);
    return witness;
  };
  return {
    async chainTime(chain) {
      const c = of(chain);
      const [primaryId, witnessId] = await Promise.all([
        c.pub.getChainId(), c.witness ? c.witness.getChainId() : Promise.resolve(CHAINS[chain].id),
      ]);
      if (primaryId !== CHAINS[chain].id || witnessId !== CHAINS[chain].id)
        throw new GuardError(`the ${chain} primary and witness nodes must agree on the chain id`);
      const [block, witnessBlock] = await Promise.all([
        c.pub.getBlock({ blockTag: "latest" }),
        c.witness ? c.witness.getBlock({ blockTag: "latest" }) : Promise.resolve(null),
      ]);
      if (typeof block?.timestamp !== "bigint" || block.timestamp <= 0n)
        throw new GuardError(`the ${chain} node returned an invalid block timestamp`);
      if (c.witness && (typeof witnessBlock?.timestamp !== "bigint" || witnessBlock.timestamp <= 0n ||
          (block.timestamp > witnessBlock.timestamp ? block.timestamp - witnessBlock.timestamp : witnessBlock.timestamp - block.timestamp) > 300n))
        throw new GuardError(`the ${chain} witness chain time disagrees with the primary by more than 5 minutes`);
      const ms = block.timestamp * 1000n;
      if (ms > BigInt(Number.MAX_SAFE_INTEGER)) throw new GuardError("chain timestamp exceeds safe JavaScript time");
      return Number(ms);
    },
    /** Sign a fixed EIP-1559 transaction LOCALLY. Do not contact a broadcast RPC. */
    async prepare(chain, tx) {
      if (!account?.signTransaction) throw new GuardError("a local account is required to prepare a raw transaction");
      const witness = witnessOrRefuse(chain);
      const pub = of(chain).pub;
      if ((await pub.getChainId()) !== CHAINS[chain].id) throw new GuardError(`your ${chain} node is on another chain`);
      const [confirmed, pending] = await Promise.all([
        pub.getTransactionCount({ address: account.address, blockTag: "latest" }),
        pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
      ]);
      const [id, wc, wp] = await Promise.all([
        witness.getChainId(),
        witness.getTransactionCount({ address: account.address, blockTag: "latest" }),
        witness.getTransactionCount({ address: account.address, blockTag: "pending" }),
      ]);
      if (id !== CHAINS[chain].id || wc !== confirmed || wp !== pending)
        throw new GuardError(`the ${chain} RPCs disagree about chain or wallet nonce; do not sign`);
      const nonce = assertUncontendedNonce(confirmed, pending);
      const raw = await account.signTransaction({
        type: "eip1559", chainId: CHAINS[chain].id, nonce, to: tx.to, data: tx.data,
        value: BigInt(tx.value ?? 0), gas: BigInt(tx.gas),
        maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
      });
      if (typeof raw !== "string" || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(raw) || raw.length > 262_146)
        throw new GuardError("the local signer returned an invalid or oversized EIP-1559 transaction");
      return { hash: keccak256(raw), raw, nonce };
    },
    /** Broadcast EXACTLY the signed bytes already fsynced in pending state. */
    async broadcast(chain, serializedTransaction) {
      const witness = witnessOrRefuse(chain);
      const pub = of(chain).pub;
      if ((await pub.getChainId()) !== CHAINS[chain].id) throw new GuardError(`your ${chain} node is on another chain`);
      const intent = parseTransaction(serializedTransaction);
      if (intent.type !== "eip1559" || intent.chainId !== CHAINS[chain].id ||
          !Number.isSafeInteger(intent.nonce) || !account)
        throw new GuardError("cannot broadcast a malformed or foreign-chain signed transaction");
      const [confirmed, pending] = await Promise.all([
        pub.getTransactionCount({ address: account.address, blockTag: "latest" }),
        pub.getTransactionCount({ address: account.address, blockTag: "pending" }),
      ]);
      const [id, wc, wp] = await Promise.all([
        witness.getChainId(),
        witness.getTransactionCount({ address: account.address, blockTag: "latest" }),
        witness.getTransactionCount({ address: account.address, blockTag: "pending" }),
      ]);
      if (id !== CHAINS[chain].id || wc !== confirmed || wp !== pending)
        throw new GuardError(`the ${chain} RPCs disagree about chain or wallet nonce; do not broadcast`);
      assertUncontendedNonce(confirmed, pending, intent.nonce);
      return pub.sendRawTransaction({ serializedTransaction });
    },
    async send() { throw new GuardError("direct send is disabled; prepare, journal, then broadcast signed bytes"); },
    /**
     * true / false: the exact hash is in a FINALIZED canonical block and succeeded / reverted.
     * null: it is included but not final yet (a chain's finalized block trails the first receipt by minutes),
     * or it was replaced or cannot be confirmed, or a signing bot has no witness for this chain. That is not a failure
     * and not a rule refusal: pending stays locked, nothing more is sent, and the next pass asks again through `seen`.
     */
    async wait(chain, hash) {
      const witness = of(chain).witness;
      if (account && !witness) return null;
      const pub = of(chain).pub;
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      return witness
        ? agreedFinalizedReceiptStatus(pub, witness, hash, receipt, CHAINS[chain].id)
        : finalizedReceiptStatus(pub, receipt, hash);
    },
    /** Finalized success/revert only. A witness disagreement, or no witness on a signing bot, is UNKNOWN, so pending remains. */
    async seen(chain, hash) {
      try {
        const { pub, witness } = of(chain);
        if (account && !witness) return null;
        if (witness) return await agreedFinalizedReceiptStatus(pub, witness, hash, null, CHAINS[chain].id);
        const receipt = await pub.getTransactionReceipt({ hash });
        return await finalizedReceiptStatus(pub, receipt, hash);
      } catch { return null; }
    },
  };
}

// ---- the home folder: state, the ledger of everything sent, the stop file -------------------------------------------
const readJson = (file, fallback) => {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (e?.code === "ENOENT") return fallback;
    throw new GuardError(`cannot read bot state at ${file}; refusing to reset risk records`);
  }
  try { return JSON.parse(raw); }
  catch { throw new GuardError(`bot state at ${file} is malformed; refusing to reset risk records`); }
};
/** A filename is not durable until the containing directory is flushed. */
/** A read-only stable digest for exporting audit evidence without exposing saved signed bytes. */
export async function hashLocalFile(file) {
  const digest = createHash("sha256");
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest("hex");
}
export function syncDirectory(directory) {
  if (process.platform === "win32")
    throw new GuardError("this local-file durability implementation requires POSIX directory fsync; live use on Windows is not supported");
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    fs.fsyncSync(fd);
  } catch (e) {
    throw new GuardError(`cannot durably sync directory ${directory}: ${clean(e?.message ?? e, 120)}`);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
/** Keep a corrupt or years-long ledger from exhausting memory during validation. */
export const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_JOURNAL_ROW_BYTES = 64 * 1024;
export function scanJournalFile(file, consume) {
  const fd = fs.openSync(file, "r");
  const block = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0), total = 0, rowNumber = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, block, 0, block.length, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_LEDGER_BYTES) throw new GuardError("ledger exceeds bounded validation capacity; audited archival is required before further trading");
      let from = 0;
      for (let i = 0; i < read; i++) {
        if (block[i] !== 10) continue;
        const piece = block.subarray(from, i);
        if (pending.length + piece.length > MAX_JOURNAL_ROW_BYTES)
          throw new GuardError("an oversized journal row cannot be verified safely");
        const row = pending.length ? Buffer.concat([pending, piece]) : piece;
        if (row.length) consume(row.toString("utf8"), rowNumber);
        rowNumber++;
        pending = Buffer.alloc(0);
        from = i + 1;
      }
      const rest = block.subarray(from, read);
      if (pending.length + rest.length > MAX_JOURNAL_ROW_BYTES)
        throw new GuardError("an oversized journal row cannot be verified safely");
      pending = pending.length ? Buffer.concat([pending, rest]) : Buffer.from(rest);
    }
    if (pending.length) consume(pending.toString("utf8"), rowNumber);
  } finally { fs.closeSync(fd); }
}
/** Reject redirected special files before they reach a signer or spending ledger. */
function assertLocalRegularFile(file) {
  let st;
  try { st = fs.lstatSync(file); }
  catch (e) { if (e?.code === "ENOENT") return; throw e; }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 ||
      (typeof process.getuid === "function" && st.uid !== process.getuid()))
    throw new GuardError(`bot state or ledger is not a private regular file: ${file}`);
}
/**
 * Open the bot's home folder. With `readOnly` (what a dry pass uses) nothing is created, locked or written: a home that does
 * not exist yet is simply empty, and every write refuses. A dry pass can therefore run beside a live bot that holds the lock,
 * and it changes no file in the home.
 */
export function openHome(home, { readOnly = false } = {}) {
  const alreadyExists = fs.existsSync(home);
  if (!readOnly || alreadyExists) {
    if (!readOnly) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const homeStat = fs.lstatSync(home);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink() ||
        (process.platform !== "win32" && (homeStat.mode & 0o077) !== 0) ||
        (typeof process.getuid === "function" && homeStat.uid !== process.getuid()))
      throw new GuardError("bot home must be a private real directory owned by the running user (chmod 700; no symlinks)");
    if (!readOnly && !alreadyExists) syncDirectory(path.dirname(home));
  }
  const files = { state: path.join(home, "state.json"), ledger: path.join(home, "ledger.jsonl"), stop: path.join(home, "STOP"), lock: path.join(home, "lock") };
  const lockNonce = randomBytes(16).toString("hex");
  let ownsLock = false;
  const opened = {
    files,
    stopped: () => fs.existsSync(files.stop),
    state() {
      assertLocalRegularFile(files.state);
      assertLocalRegularFile(files.ledger);
      if (!fs.existsSync(files.state) && fs.existsSync(files.ledger) && fs.statSync(files.ledger).size > 0)
        throw new GuardError("bot state is missing but a transaction ledger exists; restore or reconcile before sending");
      const state = readJson(files.state, {});
      if (state && state.schemaVersion !== undefined && state.schemaVersion !== STORAGE_SCHEMA_VERSION)
        throw new GuardError("unknown bot state format version; explicit reviewed migration is required");
      if (!state || typeof state !== "object" || Array.isArray(state))
        throw new GuardError("bot state is not an object; refusing to forget pending transactions");
      if (state.compaction)
        throw new GuardError("journal rotation was interrupted; no trading until the archive is recovered under the exclusive lock");
      if (state.ledgerExpected === true && !fs.existsSync(files.ledger))
        throw new GuardError("the bot's transaction ledger is missing (lost, or its first reservation write failed); refusing to reset previously reserved spending. Nothing is sent until the owner reconciles it");
      if (state.pending?.signedRaw) {
        const pending = state.pending;
        if (typeof pending.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(pending.hash) ||
            typeof pending.signedRaw !== "string" ||
            !/^0x02(?:[0-9a-fA-F]{2})+$/.test(pending.signedRaw) ||
            keccak256(pending.signedRaw).toLowerCase() !== pending.hash.toLowerCase() ||
            typeof pending.nonce !== "string" || !/^(0|[1-9]\d*)$/.test(pending.nonce))
          throw new GuardError("the pending signed transaction no longer matches its exact hash and nonce");
      }
      return state;
    },
    save(state) {
      if (!state || typeof state !== "object" || Array.isArray(state) ||
          (state.schemaVersion !== undefined && state.schemaVersion !== STORAGE_SCHEMA_VERSION))
        throw new GuardError("cannot save an unknown bot state schema");
      const versioned = { ...state, schemaVersion: STORAGE_SCHEMA_VERSION };
      // A unique exclusive tmp avoids following a pre-planted state.tmp symlink.
      const tmp = `${files.state}.${randomBytes(16).toString("hex")}.tmp`;
      const fd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(versioned, null, 2)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, files.state);
      syncDirectory(home); // the renamed state file must survive a power loss before any send
    },
    /**
     * The accounting home is permanently paired to one signer. A historic
     * journal with no identity metadata is untrusted until manually migrated.
     */
    bindWallet(address) {
      if (!isAddress(String(address ?? ""))) throw new GuardError("a live bot needs one valid wallet address");
      const state = this.state();
      if (state.walletAddress) {
        if (!same(state.walletAddress, address))
          throw new GuardError("the bot home is bound to a different wallet; use the original signer or a fresh home");
        return;
      }
      if (fs.existsSync(files.ledger) && fs.statSync(files.ledger).size > 0)
        throw new GuardError("a legacy ledger exists without a wallet identity; reconcile it before signing");
      state.walletAddress = address;
      this.save(state);
    },
    record(row) {
      assertLocalRegularFile(files.ledger);
      const newFile = !fs.existsSync(files.ledger);
      const fd = fs.openSync(files.ledger, "a", 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify({ ...row, schemaVersion: STORAGE_SCHEMA_VERSION })}\n`); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      if (newFile) syncDirectory(home); // creation of ledger.jsonl is part of the durable reservation
    },
    /** Fees (upper bound) and ETH sent in the last 24 hours, from the ledger. */
    day(now) {
      assertLocalRegularFile(files.ledger);
      if (!fs.existsSync(files.ledger)) {
        if (!this.state().ledgerExpected) return { feeWei: 0n, spendWei: 0n, kvcmUnits: 0n, usdcUnits: 0n };
        throw new GuardError("transaction ledger is missing; refusing to reset daily risk caps");
      }
      let feeWei = 0n, spendWei = 0n, kvcmUnits = 0n, usdcUnits = 0n;
      const journal = new Map();
      scanJournalFile(files.ledger, (line, index) => {
        let r; try { r = JSON.parse(line); }
        catch { throw new GuardError(`invalid transaction ledger row ${index + 1}: refusing to drop a previous spend`); }
        if (r && r.schemaVersion !== undefined && r.schemaVersion !== STORAGE_SCHEMA_VERSION)
          throw new GuardError(`unknown journal format at row ${index + 1}; explicit reviewed migration is required`);
        if (typeof r?.at !== "string" || typeof r?.feeBoundWei !== "string" || typeof r?.valueWei !== "string" ||
            !/^(0|[1-9]\d*)$/.test(r.feeBoundWei) || !/^(0|[1-9]\d*)$/.test(r.valueWei))
          throw new GuardError(`ledger row ${index + 1} lacks canonical nonnegative decimal amounts; refusing to reset limits`);
        const at = recordedTime(r.at);
        const fee = BigInt(r.feeBoundWei), value = BigInt(r.valueWei);
        for (const field of ["kvcmUnits", "usdcUnits"]) {
          const units = r[field];
          if (units === undefined) {
            const relevant = (r.leg === "klima" && /^retire\b/i.test(String(r.name ?? ""))) ||
              (r.leg === "gmx" && /^open\b/i.test(String(r.name ?? "")));
            if (relevant && (!r.phase || r.phase === "reserved") && now - at < DAY_MS)
              throw new GuardError(`unaccounted ${r.leg} asset spend in ledger row ${index + 1}; reconcile before trading`);
          } else if (typeof units !== "string" || !/^(0|[1-9]\d*)$/.test(units)) {
            throw new GuardError(`ledger row ${index + 1} has invalid ${field}`);
          }
        }
        const kvcm = BigInt(r.kvcmUnits ?? "0"), usdc = BigInt(r.usdcUnits ?? "0");
        if (at > now + MAX_WALL_CLOCK_DRIFT_MS)
          throw new GuardError(`future transaction timestamp in ledger row ${index + 1}; the clock or accounting history is not trustworthy`);
        if (r.phase !== undefined) {
          if (!["reserved", "broadcast", "receipt", "reconciled"].includes(r.phase) || !/^[0-9a-f]{32}$/.test(r.id ?? ""))
            throw new GuardError(`invalid transaction journal event at row ${index + 1}`);
          if (r.phase !== "reserved" && (fee !== 0n || value !== 0n || kvcm !== 0n || usdc !== 0n))
            throw new GuardError(`a non-reservation ledger event carries money at row ${index + 1}`);
          const existing = journal.get(r.id);
          if (r.phase === "reserved") {
            if (existing) throw new GuardError(`duplicate journal reservation ${r.id}`);
            if (r.hash !== null && r.hash !== undefined &&
                (typeof r.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.hash)))
              throw new GuardError(`invalid reserved transaction hash at row ${index + 1}`);
            if (r.nonce !== undefined &&
                (typeof r.nonce !== "string" || !/^(0|[1-9]\d*)$/.test(r.nonce) || !r.hash))
              throw new GuardError(`invalid reserved transaction nonce at row ${index + 1}`);
            journal.set(r.id, { stage: "reserved", hash: r.hash ?? null, nonce: r.nonce ?? null });
          } else {
            if (!existing) throw new GuardError(`journal event without a reservation at row ${index + 1}`);
            if (typeof r.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r.hash))
              throw new GuardError(`journal event missing a transaction hash at row ${index + 1}`);
            if (existing.hash && !same(existing.hash, r.hash))
              throw new GuardError(`journal has conflicting hashes for reservation ${r.id}`);
            if (r.phase === "broadcast" && existing.stage !== "reserved")
              throw new GuardError(`journal broadcast event out of order at row ${index + 1}`);
            if (r.phase === "receipt" && existing.stage !== "broadcast")
              throw new GuardError(`journal receipt event out of order at row ${index + 1}`);
            if (r.phase === "reconciled" && existing.stage !== "reserved" && existing.stage !== "broadcast" && existing.stage !== "receipt")
              throw new GuardError(`journal reconciliation out of order at row ${index + 1}`);
            journal.set(r.id, { ...existing, stage: r.phase, hash: r.hash });
          }
        }
        if (!(now - at < DAY_MS)) return;
        feeWei += fee; spendWei += value; kvcmUnits += kvcm; usdcUnits += usdc;
      });
      const state = this.state(), active = state.pending;
      const unfinished = [...journal.entries()].filter(([, event]) => event.stage === "reserved" || event.stage === "broadcast");
      if (unfinished.length > 1 || (unfinished.length === 1 && unfinished[0][0] !== active?.id))
        throw new GuardError("journal has an unresolved send without its matching pending state; manual reconciliation is required");
      if (active?.id && (!journal.has(active.id) ||
          !["reserved", "broadcast", "receipt", "reconciled"].includes(journal.get(active.id).stage)))
        throw new GuardError("pending transaction has no matching durable journal entry");
      if (active?.id) {
        const event = journal.get(active.id);
        if ((event.hash && !same(active.hash, event.hash)) ||
            (active.signedRaw && (!event.hash || active.nonce !== event.nonce)))
          throw new GuardError("pending transaction hash or nonce conflicts with the durable journal reservation");
      }
      return { feeWei, spendWei, kvcmUnits, usdcUnits };
    },
    /** Validate the whole journal before returning an ID\'s last durable stage. */
    journalStage(id, now) {
      this.day(now);
      let stage = null;
      scanJournalFile(files.ledger, (line) => {
        const row = JSON.parse(line);
        if (row.id === id) stage = row.phase;
      });
      return stage;
    },
    /**
     * One bot per home folder, acquired atomically by the OS. A stale lock
     * requires explicit human recovery: never remove it automatically,
     * since an in-flight send can outlive a crashed or restarted process.
     */
    lock() {
      assertLocalRegularFile(files.lock);
      if (ownsLock) return false;
      let fd;
      try { fd = fs.openSync(files.lock, "wx", 0o600); }
      catch (e) { if (e?.code === "EEXIST") return false; throw e; }
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: lockNonce, at: new Date().toISOString() }));
        fs.fsyncSync(fd);
        syncDirectory(home);
        ownsLock = true;
        return true;
      } finally { fs.closeSync(fd); }
    },
    unlock() {
      if (!ownsLock) return;
      const held = readJson(files.lock, null);
      if (held?.pid === process.pid && held.nonce === lockNonce) {
        fs.rmSync(files.lock, { force: true });
        syncDirectory(home);
      }
      ownsLock = false;
    },
  };
  if (readOnly) {
    const refuse = (what) => () => { throw new GuardError(`a dry pass writes nothing into the home (${what})`); };
    Object.assign(opened, { save: refuse("state"), record: refuse("ledger"), bindWallet: refuse("wallet binding"), lock: refuse("lock"), unlock() {} });
  }
  return opened;
}

// ---- one step: check it, count it against the day, then (only with --live) sign, send and wait ---------------------
/**
 * Verify a locally signed transaction against every owner-authorized field.
 * A matching hash alone is not permission for a different recipient, amount,
 * selector, nonce, fee or signer. This validates the exact bytes before they
 * can be recorded as a transaction intended for broadcast.
 */
export async function verifySignedIntent(signed, tx, chain, address) {
  if (typeof signed?.raw !== "string" || !/^0x02(?:[0-9a-fA-F]{2})+$/.test(signed.raw) ||
      signed.raw.length > 262_146 || typeof signed.hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(signed.hash) ||
      !Number.isSafeInteger(signed.nonce) || signed.nonce < 0 ||
      keccak256(signed.raw).toLowerCase() !== signed.hash.toLowerCase())
    throw new GuardError("invalid locally signed transaction hash or nonce");
  let parsed, signer;
  try {
    parsed = parseTransaction(signed.raw);
    signer = await recoverTransactionAddress({ serializedTransaction: signed.raw });
  } catch { throw new GuardError("the proposed signed transaction is invalid or cannot be authenticated"); }
  if (parsed.type !== "eip1559" || parsed.chainId !== CHAINS[chain]?.id ||
      parsed.nonce !== signed.nonce || !same(parsed.to, tx.to) ||
      (parsed.data ?? "0x").toLowerCase() !== String(tx.data ?? "0x").toLowerCase() ||
      parsed.value !== BigInt(tx.value ?? 0) || parsed.gas !== BigInt(tx.gas) ||
      parsed.maxFeePerGas !== BigInt(tx.maxFeePerGas) ||
      parsed.maxPriorityFeePerGas !== BigInt(tx.maxPriorityFeePerGas) ||
      (parsed.accessList?.length ?? 0) !== 0 || !same(signer, address))
    throw new GuardError("locally signed transaction differs from the exact guarded intent, chain or wallet");
  return true;
}
/** Persisted completion intents are applied atomically with clearing a confirmed pending send. */
function applyCompletion(state, completion) {
  if (!completion) return;
  if (!["hydrex", "klima", "regen", "eco", "eco-buy", "net-buy", "gmx"].includes(completion.bucket) ||
      !completion.value || typeof completion.value !== "object" || Array.isArray(completion.value))
    throw new GuardError("pending receipt has an invalid completion checkpoint");
  state[completion.bucket] = completion.value;
}

/** Sends of one leg that reverted in a row, and how many stop the leg. The count lives in state.sendFailures, so it holds across passes and restarts. */
export const SEND_FAILURE_LIMIT = 3;
/** The steps of the Klima leg, by the names its ledger rows and pending sends carry. A name picks the count a send belongs to. */
export const KLIMA_APPROVE_STEP = "the exact kVCM approval";
export const KLIMA_TAKE_BACK_STEP = "take the kVCM approval back";
/**
 * The Klima leg keeps TWO counts under sendFailures. "klima" counts its approvals and retirements: a revert adds one, an approve
 * that goes final does nothing, and only a retirement that goes final resets it. "klima:take-back" counts the take-backs on their
 * own. A take-back that works is not the retirement's success: without that split, approve ok, retire reverts, take-back ok would
 * reset the count every cycle and the leg would never stop.
 */
export const KLIMA_TAKE_BACK_COUNT = "klima:take-back";
/** Which count a send belongs to, and whether a send that goes final resets it. Pure: the same answer when a pending send is reconciled. */
function countFor(leg, name) {
  if (leg !== "klima") return { key: leg, resets: true };
  if (name === KLIMA_TAKE_BACK_STEP) return { key: KLIMA_TAKE_BACK_COUNT, resets: true };
  if (name === KLIMA_APPROVE_STEP) return { key: "klima", resets: false };
  return { key: "klima", resets: true }; // the retirement
}
/** A count of reverted sends in a row. A damaged entry reads as the limit: the leg stays stopped until the owner looks at it. */
function revertedInARow(state, key) {
  const counts = state?.sendFailures;
  if (counts === undefined) return 0;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) return SEND_FAILURE_LIMIT;
  const n = counts[key];
  if (n === undefined) return 0;
  return Number.isSafeInteger(n) && n >= 0 ? n : SEND_FAILURE_LIMIT;
}
/**
 * Write a send's final outcome into `state` (the caller saves it in the same write that clears pending, so a crash cannot lose
 * or double it): a revert adds one to its count, a success resets it when `resets` says it does. Returns the count now.
 */
function countSendOutcome(state, key, ok, resets = true) {
  if (ok && !resets) return revertedInARow(state, key);
  const counts = state.sendFailures && typeof state.sendFailures === "object" && !Array.isArray(state.sendFailures) ? { ...state.sendFailures } : {};
  const next = ok ? 0 : revertedInARow(state, key) + 1;
  if (next > 0) counts[key] = next; else delete counts[key];
  if (Object.keys(counts).length) state.sendFailures = counts; else delete state.sendFailures;
  return next;
}
const revertStopReason = (key, n) => `its last ${n} sends reverted in a row${key === "klima" ? ", and the kVCM approval was taken back first" : ""}; to clear it, stop the bot and delete "${key}" under sendFailures in state.json`;
/** The take-back's own stop. Short on purpose: a leg's stop reason is cut at 240 characters, and this one must keep its instruction. */
const takeBackStopReason = (n) => `its last ${n} take-backs reverted in a row, so a kVCM approval to Klima's asset manager may still be open on your wallet. Check and clear it by hand: the kit's \`klima prepare revoke --from 0xYOU\``;
/**
 * The one case the bot cannot close an approval itself: its take-backs keep reverting. Say so plainly, in the output and in the
 * pass report (--json), and say how the owner checks it and clears it by hand with the kit's own revoke command. Then stop the leg.
 */
function haltTakeBackStopped(ctx, n) {
  const check = `klima prepare revoke --from ${ctx.address}`;
  ctx.approvalMayBeOpen = {
    token: "kVCM", spender: ADDR.klimaAssetManager, check,
    how: "the kit's revoke command prints the exact approval of zero for you to sign with your own wallet, or says there is nothing to revoke; the bot cannot close this one",
  };
  ctx.say(`klima: A kVCM APPROVAL MAY STILL BE OPEN on your wallet (spender: Klima's asset manager). The bot's last ${n} take-backs reverted and it will not send another. To check it, run the kit's \`${check}\` (from this folder: node ../../skills/protocol-guide/protocol-guide.mjs ${check}). It prints the exact approval of zero, which you sign yourself with your own wallet, or says there is nothing to revoke. When it is cleared, stop the bot, delete "${KLIMA_TAKE_BACK_COUNT}" under sendFailures in state.json, and start it again.`);
  ctx.halt("klima", takeBackStopReason(n));
}
/**
 * A reverted send that reaches its count's limit stops its leg, except on the Klima leg: its approve and retirement count stops
 * the leg only AFTER the approval has been taken back (klimaTurn), so a stopped leg leaves a zero allowance.
 */
function stopOnReverts(ctx, leg, key, n) {
  if (n < SEND_FAILURE_LIMIT) return;
  if (key === KLIMA_TAKE_BACK_COUNT) return haltTakeBackStopped(ctx, n);
  if (leg === "klima") return;
  ctx.halt(leg, revertStopReason(key, n));
}

const PENDING_WITHOUT_JOURNAL = "pending transaction has no matching durable journal entry";
/** How long a dry pass waits before it reads the home a second time (see readDay). */
export const DRY_REREAD_MS = 300;
/**
 * The day's totals from the home. A DRY pass reads a home a live bot may be writing: the bot saves state.json with the pending
 * send first and appends its ledger row a moment later, and a read between the two sees a pending send with no journal row.
 * That one mismatch is read once more after a short wait. If the home is consistent then, the pass carries on; if not, it says a
 * live bot may be mid-send or the home is damaged, and still refuses. A live pass reads once and refuses at once, as before.
 */
async function readDay(ctx) {
  try { return ctx.home.day(ctx.now()); }
  catch (e) {
    if (ctx.live || !(e instanceof GuardError) || e.message !== PENDING_WITHOUT_JOURNAL) throw e;
    await (ctx.pause ?? sleep)(DRY_REREAD_MS);
    try { return ctx.home.day(ctx.now()); }
    catch (again) {
      if (again instanceof GuardError && again.message === PENDING_WITHOUT_JOURNAL)
        throw new GuardError(`${PENDING_WITHOUT_JOURNAL}: a live bot may be mid-send beside this dry pass, or the home is damaged (read twice, ${DRY_REREAD_MS} ms apart)`);
      throw again;
    }
  }
}
/**
 * Returns "dry" | "sent" | "reverted" | "pending" | "budget". "pending": it went out but is not final yet. STOP and pending transactions return "budget" without sending. Throws GuardError for a refused rule.
 * `reserve(state)` writes whatever this send makes the bot owe into the SAME state save that records the send as pending, before it is broadcast.
 */
export async function step(ctx, leg, name, tx, { sizeWei = 0n, gmxIntent = null, hydrexVote = null, klimaIntent = null, completion = null, amount = null, reserve = null } = {}) {
  // An unrecognized kit step must not bypass the owner's market/side/leverage selection.
  if (leg === "gmx" && typeof tx?.data === "string" && tx.data.slice(0, 10).toLowerCase() === SEL.multicall &&
      (!gmxIntent || typeof gmxIntent !== "object" || !["open", "close"].includes(gmxIntent.action)))
    throw new GuardError("gmx: GMX order has no explicit owner intent; refusing to sign");
  const why = checkTx(leg, tx, { from: ctx.address, sizeWei, maxTxFeeWei: ctx.caps.maxTxFeeWei, gmxIntent, hydrexVote, klimaIntent });
  if (why) throw new GuardError(`${leg}: refused ${name}: ${why}`);
  const chain = RULES[leg][0].chain;
  const value = BigInt(tx.value ?? 0);
  const l1 = BigInt(tx.l1FeeBoundWei ?? 0);
  const feeBound = BigInt(tx.gas) * BigInt(tx.maxFeePerGas) + l1;
  const selector = tx.data.slice(0, 10).toLowerCase();
  const kvcmUnits = leg === "klima" && selector === SEL.retireCreditViaKlima
    ? decodeFunctionData({ abi: KLIMA_ABI, data: tx.data }).args[6] : 0n;
  const usdcUnits = leg === "gmx" && selector === SEL.multicall && gmxIntent?.action === "open"
    ? gmxIntent.collateralUnits : 0n;
  // What this send moves, for the pass report: the token amount the leg names, else the ETH it carries.
  const moved = amount ?? (value > 0n ? as(tokenAmount("ETH", { raw: value }), "the ETH it spends") : null);
  const outcome = (result, hash = null) => {
    ctx.recordSend?.(leg, { step: clean(name, 200), outcome: result, chain, token: moved?.token ?? null, amount: moved?.amount ?? null, amountRaw: moved?.amountRaw ?? null,
      amountIs: moved?.is ?? null, valueEth: formatEther(value), valueWei: value.toString(), hash });
    return result;
  };
  if (ctx.live) { ctx.safeNow?.(); ctx.home.bindWallet(ctx.address); }
  const day = await readDay(ctx);
  if (day.feeWei + feeBound > ctx.caps.dayFeeWei) { ctx.say(`${leg}: ${name} waits: the day's fee cap (${eth(ctx.caps.dayFeeWei)}) is reached`, "held"); return outcome("budget"); }
  if (value > 0n && day.spendWei + value > ctx.caps.daySpendWei) { ctx.say(`${leg}: ${name} waits: the day's spend cap (${eth(ctx.caps.daySpendWei)}) is reached`, "held"); return outcome("budget"); }
  if ((day.kvcmUnits ?? 0n) + kvcmUnits > (ctx.caps.dayKvcmUnits ?? MAX_KVCM_APPROVE)) { ctx.say(`${leg}: ${name} waits: the day\'s kVCM cap is reached`, "held"); return outcome("budget"); }
  if ((day.usdcUnits ?? 0n) + usdcUnits > (ctx.caps.dayUsdcUnits ?? MAX_GMX_USDC)) { ctx.say(`${leg}: ${name} waits: the day\'s GMX USDC cap is reached`, "held"); return outcome("budget"); }
  if (!ctx.live) { ctx.say(`${leg}: DRY, would send ${name}${value > 0n ? ` with ${eth(value)}` : ""} (fee at most ${eth(feeBound)})`, "dry"); return outcome("dry"); }
  await assertChainClock(ctx, chain);
  // These checks must happen for every send, not only at the start of a pass: a prior receipt may have timed out.
  if (ctx.home.stopped()) { ctx.say(`${leg}: ${name} waits: STOP is set, nothing sent`, "held"); return outcome("budget"); }
  if (ctx.home.state().pending) { ctx.say(`${leg}: ${name} waits: a transaction is still pending, nothing sent`, "held"); return outcome("budget"); }
  // Write-ahead protocol: commit the unknown-broadcast barrier and reserve the
  // entire possible spend before invoking any remote RPC. A crash at *any*
  // boundary is conservative: it may strand capital, but never replays blindly.
  const signed = typeof ctx.io.prepare === "function" ? await ctx.io.prepare(chain, tx) : null;
  if (signed) {
    if (typeof ctx.io.broadcast !== "function")
      throw new GuardError("signed transaction broadcaster is unavailable");
    await verifySignedIntent(signed, tx, chain, ctx.address);
  }
  const at = new Date(ctx.now()).toISOString();
  const id = randomBytes(16).toString("hex");
  const pending = { id, chain, hash: signed?.hash ?? null,
    ...(signed ? { nonce: String(signed.nonce), signedRaw: signed.raw } : {}),
    leg, name, at, ...(completion ? { completion } : {}) };
  const stateBeforeSend = ctx.home.state();
  if (stateBeforeSend.pending) { ctx.say(`${leg}: ${name} waits: a transaction is still pending, nothing sent`, "held"); return outcome("budget"); }
  stateBeforeSend.pending = pending;
  stateBeforeSend.ledgerExpected = true;
  reserve?.(stateBeforeSend); // a debt this send creates is on disk with the send itself, never a later write
  ctx.home.save(stateBeforeSend);
  const row = (phase, fields = {}) => ({
    id, phase, at: new Date(ctx.now()).toISOString(), leg, name, chain,
    to: tx.to, valueWei: phase === "reserved" ? value.toString() : "0",
    feeBoundWei: phase === "reserved" ? feeBound.toString() : "0",
    kvcmUnits: phase === "reserved" ? kvcmUnits.toString() : "0",
    usdcUnits: phase === "reserved" ? usdcUnits.toString() : "0", ...fields,
  });
  ctx.home.record(row("reserved", { hash: pending.hash, ...(signed ? { nonce: pending.nonce } : {}) }));
  // STOP may arrive while the durable writes are made. Leave the reservation
  // intact for manual reconciliation rather than race the kill switch.
  if (ctx.home.stopped()) { ctx.say(`${leg}: ${name} waits: STOP arrived after the send was reserved, nothing was broadcast`, "held"); return outcome("budget", pending.hash); }
  if (ctx.live) ctx.safeNow?.();
  let hash;
  try { hash = signed ? await ctx.io.broadcast(chain, signed.raw) : await ctx.io.send(chain, tx); }
  catch (e) {
    // A node can broadcast and then lose its response. With local signing
    // the exact hash and nonce were committed BEFORE contacting that node.
    throw e;
  }
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
      (signed && hash.toLowerCase() !== signed.hash.toLowerCase()))
    throw new GuardError("broadcast node returned a missing or different transaction hash; the original pending hash remains reserved");
  const submitted = ctx.home.state();
  if (submitted.pending?.id !== id || submitted.pending.hash !== pending.hash)
    throw new GuardError("the bot's pending send changed unexpectedly after broadcast; refusing to clear it");
  submitted.pending = { ...pending, hash };
  ctx.home.save(submitted);
  ctx.home.record(row("broadcast", { hash }));
  const ok = await ctx.io.wait(chain, hash);
  if (ok === null) {
    ctx.say(`${leg}: ${name} ${hash} is in a block that is not final yet, or cannot be confirmed. It stays pending and nothing more is sent; the next pass checks it again`, "pending");
    return outcome("pending", hash);
  }
  ctx.home.record(row("receipt", { hash, status: ok ? "success" : "reverted" }));
  const settled = ctx.home.state();
  if (settled.pending?.id !== id || settled.pending.hash !== hash)
    throw new GuardError("pending transaction changed before confirmation; refusing to clear it");
  if (ok) applyCompletion(settled, pending.completion);
  const count = countFor(leg, name);
  const revertedInRow = countSendOutcome(settled, count.key, ok, count.resets); // saved in the same write that clears pending
  delete settled.pending;
  ctx.home.save(settled);
  ctx.say(`${leg}: ${ok ? "sent" : "REVERTED"} ${name} ${hash}`, ok ? "sent" : "failed");
  if (!ok) stopOnReverts(ctx, leg, count.key, revertedInRow);
  return outcome(ok ? "sent" : "reverted", hash);
}

/** A kit answer, read the way the recipes say: 0 go on, 10 nothing now, 1 a read failed, 2/3/4 stop the leg. */
function settle(ctx, leg, what, r) {
  if (r.code === 0 && r.out) return "ok";
  if (r.code === 10) { ctx.say(`${leg}: ${what}: nothing to do now${r.out?.prepared?.reason || r.out?.reason ? ` (${clean(r.out?.prepared?.reason ?? r.out?.reason)})` : ""}`, "held"); return "nothing"; }
  if (r.code === 1 || r.code === 0) { ctx.fail(leg, `${what}: a read failed, nothing was decided${r.err ? ` (${r.err})` : ""}`); return "failed"; }
  ctx.halt(leg, `${what} stopped with exit ${r.code}${r.err ? ` (${r.err})` : ""}`);
  return "halted";
}
const kit = (ctx, args) => ctx.kit(ctx.kitFile, args, ctx.rpcs);
const due = (last, hours, now) => {
  if (last === undefined || last === null) return true;
  const at = recordedTime(last);
  if (at > now + MAX_WALL_CLOCK_DRIFT_MS)
    throw new GuardError("saved leg completion time is in the future; refusing to repeat an operation with an invalid clock");
  return now - at >= hours * 3600_000;
};
const VOTE_RE = /^0x[0-9a-fA-F]{40}:\d{1,5}(,0x[0-9a-fA-F]{40}:\d{1,5}){0,9}$/;
/** A vote string is pools and basis points that sum to exactly 10000. */
export const validVote = (v) => {
  if (typeof v !== "string" || !VOTE_RE.test(v)) return false;
  const pairs = v.split(",").map((p) => { const [pool, bps] = p.split(":"); return { pool: pool.toLowerCase(), bps: Number(bps) }; });
  return pairs.every((p) => p.bps > 0) && new Set(pairs.map((p) => p.pool)).size === pairs.length &&
    pairs.reduce((total, p) => total + p.bps, 0) === 10000;
};

/**
 * The gate for the one thing the regen-retire leg prints. Returns null when the kit's message is exactly the retirement the
 * flags name (the retirement type, your owner address, that one batch and amount, that jurisdiction and reason, and no other
 * field), or the reason it is refused. Pure: no network, no key. What you would sign in your own wallet is checked here first.
 */
export function checkRegenRetire(message, o) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "the kit printed no message";
  if (message.typeUrl !== REGEN_RETIRE_TYPE_URL) return "the message is not a retirement";
  const keys = (x) => Object.keys(x).sort().join(",");
  const v = message.value;
  if (keys(message) !== "typeUrl,value" || !v || typeof v !== "object" || keys(v) !== "credits,jurisdiction,owner,reason") return "the message has an unexpected field, or is missing one";
  if (v.owner !== o.regenRetireOwner) return "the message names a different owner than --regen-retire-owner";
  if (v.jurisdiction !== o.regenRetireJurisdiction) return "the message names a different jurisdiction than --regen-retire-jurisdiction";
  if (v.reason !== clean(o.regenRetireReason, 200)) return "the message carries a different reason than --regen-retire-reason";
  const c = v.credits;
  if (!Array.isArray(c) || c.length !== 1 || !c[0] || typeof c[0] !== "object" || keys(c[0]) !== "amount,batch_denom" || c[0].batch_denom !== o.regenRetireBatch || c[0].amount !== o.regenRetireAmount) return "the message must retire exactly the one batch and amount you named (credits)";
  return null;
}

/**
 * The kit's own words for "this address has no kVCM approval to Klima's asset manager" (`klima prepare revoke`, exit 10). The kit
 * exits 10 for that AND for "the revoke reverts in simulation", and prints no code that tells them apart, so the bot reads the
 * reason. Only this exact text means nothing is open; every other exit-10 answer leaves the take-back owed. A test holds it to the kit.
 */
export const KIT_NO_KVCM_APPROVAL = "this address has no kVCM approval to Klima's asset manager, so there is nothing to revoke";
/**
 * A take-back is owed when the record says so, and also when it is a record an older bot left: the retirement's completion was
 * { at } then, with no revokeOwed key at all. That bot never wrote the debt down, so the new one asks the kit once; the kit's
 * no-approval answer clears it, anything else keeps it owed.
 */
const klimaTakeBackOwed = (k) => k?.revokeOwed === true || (k?.at !== undefined && k?.revokeOwed === undefined);
/**
 * An approve that is sent for a retirement is owed back from the moment it is sent (`revokeOwed`), and `retireNext` says that
 * retirement has not had its turn yet: the next pass that runs the leg sends it, and only then, and the take-back follows its
 * finality. A pass that ends without sending it (STOP, a cap, a refusal, the leg off, not due, or dropped from --legs) clears
 * `retireNext`: the approve is STRANDED, and the take-back is settled before anything else. Without this flag a lagging chain,
 * where the approve is never final in its own pass, could not tell "the retirement comes next" from "it never will".
 */
const klimaRetireNext = (k) => k?.retireNext === true;
const withoutRetireNext = (k) => { const { retireNext, ...rest } = k ?? {}; return rest; };
/** Written in the same save as the send that creates the debt: an approve or a retirement sent means a take-back is owed. */
function markKlimaOwed(state, retireFollows) {
  state.klima = { ...withoutRetireNext(state.klima), revokeOwed: true, ...(retireFollows ? { retireNext: true } : {}) };
}
/** Strand the approve: its retirement had its turn (or STOP, or the leg was dropped) and did not go out. Live only; the take-back stays owed. */
function strandKlimaRetire(ctx) {
  if (!ctx.live) return;
  const s = ctx.home.state();
  if (!klimaRetireNext(s.klima)) return;
  s.klima = withoutRetireNext(s.klima);
  ctx.home.save(s);
}
/**
 * The leg stops for three approves or retirements that reverted in a row, but only once nothing is owed: the approval is taken
 * back first, so a stopped leg leaves a zero allowance. Returns true when it stopped the leg.
 */
function stopKlimaIfSettled(ctx) {
  const s = ctx.home.state();
  if (klimaTakeBackOwed(s.klima)) return false;
  const n = revertedInARow(s, "klima");
  if (n < SEND_FAILURE_LIMIT) return false;
  ctx.halt("klima", revertStopReason("klima", n));
  return true;
}
/**
 * Take the kVCM approval back: ask the kit for the zero approval, check it, send it. The same path serves the end of a Klima
 * cycle and an owed take-back found on a later pass. A revoke can never become a positive allowance: the step must be an
 * approve of exactly zero to the one pinned spender. Its completion clears the owed flag only once the send is final, so a
 * take-back that is still pending keeps the leg from retiring again. Returns the step's outcome, or "none" / "held" / "failed".
 * "none" is the kit's no-approval answer and nothing else; "held" is any other exit-10 answer, and the debt stays as it was.
 */
async function takeKlimaApprovalBack(ctx) {
  const leg = "klima";
  const r = await kit(ctx, ["klima", "prepare", "revoke", "--from", ctx.address]);
  if (r.code === 10) {
    const reason = r.out?.prepared?.reason ?? r.out?.reason;
    if (reason !== KIT_NO_KVCM_APPROVAL) {
      // The kit cannot prepare the revoke right now (its simulation reverts, or it gave no reason): an approval may still be open.
      // Whatever was owed stays owed, and the leg approves and retires nothing until it is settled.
      ctx.say(`klima: the take-back cannot be prepared now (${clean(reason ?? "the kit gave no reason")}); if one is owed it stays owed, and nothing new is approved or retired`, "held");
      return "held";
    }
    // The kit says no approval is open: the debt, if one was owed, is paid. A dry pass never writes it down.
    const kept = ctx.home.state().klima;
    if (ctx.live && klimaTakeBackOwed(kept)) { const s = ctx.home.state(); s.klima = { ...withoutRetireNext(kept), revokeOwed: false }; ctx.home.save(s); }
    ctx.say("klima: the kit reports no allowance left to revoke", "not_due");
    return "none";
  }
  if (settle(ctx, leg, "revoke", r) !== "ok") return "failed";
  const revoke = r.out?.prepared;
  if (revoke?.step !== "revoke" || !same(revoke.tx?.to, ADDR.kvcm) ||
      revoke.tx.data?.slice(0, 10).toLowerCase() !== SEL.approve)
    throw new GuardError("klima: revoke kit returned an unknown step or a different transaction");
  let revokeArgs;
  try { revokeArgs = decodeFunctionData({ abi: ERC20, data: revoke.tx.data }).args; }
  catch { throw new GuardError("klima: revoke approval calldata does not decode"); }
  if (!same(revokeArgs[0], ADDR.klimaAssetManager) || revokeArgs[1] !== 0n)
    throw new GuardError("klima: revoke must set exactly zero kVCM allowance for the pinned asset manager");
  return step(ctx, leg, KLIMA_TAKE_BACK_STEP, revoke.tx,
    { amount: as(tokenAmount("kVCM", { raw: 0n }), "the approval it sets"), completion: { bucket: "klima", value: { ...withoutRetireNext(ctx.home.state().klima), revokeOwed: false } } });
}
/** The token amount a step's calldata names at argument `index`, or null when it does not decode: the gate still judges the step. */
function decodedAmount(token, abi, data, index) {
  try { return tokenAmount(token, { raw: decodeFunctionData({ abi, data }).args[index] }); } catch { return null; }
}

// ---- the legs ------------------------------------------------------------------------------------------------------
export const LEGS = {
  /** Claim, then vote by the plain kit rank (NOT any wallet's vote), once per epoch. */
  async hydrex(ctx) {
    const leg = "hydrex";
    const e = await kit(ctx, ["hydrex", "epoch"]);
    if (settle(ctx, leg, "epoch", e) !== "ok") return;
    const epoch = String(e.out.epochStart);
    if (ctx.home.state().hydrex?.votedEpoch === epoch) return ctx.say(`${leg}: already voted this epoch`, "not_due");
    const locks = await kit(ctx, ["hydrex", "locks", "--address", ctx.address]);
    if (settle(ctx, leg, "locks", locks) !== "ok") return;
    if (!locks.out.nfts?.length) return ctx.say(`${leg}: this wallet holds no veHYDX lock, so there is nothing to claim or vote (the Hydrex guide says how a lock is made)`, "off");
    const claim = await kit(ctx, ["hydrex", "prepare", "claim", "--from", ctx.address]);
    const claimed = settle(ctx, leg, "claim", claim);
    if (claimed === "failed" || claimed === "halted") return;
    if (claimed === "ok") for (const s of claim.out.prepared?.steps ?? []) {
      const got = await step(ctx, leg, `claim ${clean(s.kind, 8)} ${(s.tokens ?? []).map((t) => `${clean(t.earned, 24)} ${clean(t.symbol, 12)}`).join(", ")}`, s.tx);
      if (got === "budget" || got === "pending") return;
    }
    let vote = ctx.opts.hydrexVote;
    if (!vote) {
      const rank = await kit(ctx, ["hydrex", "rank", "--top", String(ctx.opts.hydrexTop)]);
      if (rank.code === 2) return ctx.halt(leg, "this copy of the kit has no `hydrex rank` yet: update skills/protocol-guide, or pass your own --hydrex-vote 0xPOOL:10000");
      if (settle(ctx, leg, "rank", rank) !== "ok") return;
      vote = rank.out.vote;
    }
    if (!validVote(vote)) return ctx.halt(leg, "the vote is not pools and basis points that sum to 10000");
    const v = await kit(ctx, ["hydrex", "prepare", "vote", "--from", ctx.address, "--vote", vote]);
    if (settle(ctx, leg, "vote", v) !== "ok") return;
    await step(ctx, leg, `vote ${vote}`, v.out.prepared.tx, { hydrexVote: vote, completion: { bucket: "hydrex", value: { votedEpoch: epoch, vote, at: new Date(ctx.now()).toISOString() } } });
  },

  /**
   * Approve the exact amount, retire, take the approval back. THE INVARIANT: every kVCM approval the bot sends is owed back from
   * the moment the approve is SENT (state.klima.revokeOwed, written in the same save that records the send as pending), and it is
   * taken back as soon as the retirement it was made for is final, whether that retirement succeeded or reverted, and also when
   * the retirement was never sent (see klimaTurn, which settles the debt before this cycle runs, on every pass, selected or not).
   * Finality takes minutes (about 18 on Base), so the approve is usually final only on a later pass: `retireNext` gives it that
   * one pass to be followed by its retirement. This is the cycle itself; it runs only when nothing is owed, or when the retirement
   * is the next thing owed. A retirement that is still pending keeps the take-back waiting, here and in `step`.
   */
  async klima(ctx) {
    const leg = "klima", o = ctx.opts;
    // The approve had its pass: if this pass does not send the retirement (off, not due, a failed read, a cap, STOP, a refusal),
    // it is stranded, and the next pass takes it back first. Cleared BEFORE anything can end the pass.
    strandKlimaRetire(ctx);
    if (!o.klimaClass || !o.klimaCredit || !o.klimaTonnes) return ctx.say(`${leg}: off (set --klima-class, --klima-credit and --klima-tonnes to turn it on; \`klima classes\` and \`klima credits\` in the kit list them)`, "off");
    if (!due(ctx.home.state().klima?.at, o.buyEveryHours, ctx.now())) return ctx.say(`${leg}: not due yet`, "not_due");
    ctx.say(`${leg}: As of 2026-11-18 EcoWealth holds a stake in Klima and may gain if it rises`);
    const args = ["klima", "prepare", "retire", "--from", ctx.address, "--class", o.klimaClass, "--credit", o.klimaCredit, "--tonnes", o.klimaTonnes, "--beneficiary-name", o.klimaName, ...(o.klimaTokenId ? ["--token-id", o.klimaTokenId] : [])];
    let last = null, failure = null;
    try {
      for (let turn = 0; turn < 2; turn++) {
        const p = await kit(ctx, args);
        if (settle(ctx, leg, "retire", p) !== "ok") return;
        const kind = p.out.prepared.step, tx = p.out.prepared.tx;
        if (kind !== "approve" && kind !== "retire")
          throw new GuardError("klima: the kit returned an unrecognized retirement step");
        if (kind === "approve" ? (!same(tx?.to, ADDR.kvcm) || tx.data?.slice(0, 10).toLowerCase() !== SEL.approve) :
            (!same(tx?.to, ADDR.klimaAggregator) || tx.data?.slice(0, 10).toLowerCase() !== SEL.retireCreditViaKlima))
          throw new GuardError("klima: the kit step label does not match its onchain transaction");
        // Either send makes a take-back owed, written with the send itself; the retirement's completion keeps it owed and sets the pace.
        const got = last = await step(ctx, leg, kind === "approve" ? KLIMA_APPROVE_STEP : `retire ${o.klimaTonnes} tonnes`, tx,
          { klimaIntent: klimaRetireIntent(o), amount: as(decodedAmount("kVCM", kind === "approve" ? ERC20 : KLIMA_ABI, tx.data, kind === "approve" ? 1 : 6), kind === "approve" ? "the approval it sets" : "the most it may spend"),
            reserve: (state) => markKlimaOwed(state, kind === "approve"),
            ...(kind === "retire" ? { completion: { bucket: "klima", value: { at: new Date(ctx.now()).toISOString(), revokeOwed: true } } } : {}) });
        if (got === "dry" && kind === "approve") return ctx.say(`${leg}: DRY, then the retirement, then the approval is taken back`);
        if (got !== "sent") break;
        if (kind === "retire") break;
      }
    } catch (e) { failure = e; }
    // A send that is waiting for finality blocks every later one. The next pass finds the retirement final and settles the take-back.
    if (!failure && last === "pending") return;
    if (failure) {
      // A send that went out and is not answered stays pending and nothing can follow it; otherwise, a refused or failed retirement
      // after an approve that went out leaves that approve open: strand it and take it back now, then say what went wrong.
      if (!ctx.live || ctx.home.state().pending || !klimaTakeBackOwed(ctx.home.state().klima)) throw failure;
    }
    // The cycle is over for this pass and no retirement is pending (it went final, reverted, or was never sent): the approve is stranded.
    strandKlimaRetire(ctx);
    try { await takeKlimaApprovalBack(ctx); } catch (e) { failure ??= e; }
    if (failure) throw failure;
    stopKlimaIfSettled(ctx);
  },

  /**
   * Regen Ledger retirement, prepared and printed, never signed. It asks the kit for the exact message and says what you would
   * sign. There is no Regen signer in this program, so there is nothing to send, with or without --live.
   */
  async "regen-retire"(ctx) {
    const leg = "regen-retire", o = ctx.opts;
    const missing = [["owner", o.regenRetireOwner], ["batch", o.regenRetireBatch], ["amount", o.regenRetireAmount], ["jurisdiction", o.regenRetireJurisdiction], ["reason", o.regenRetireReason]].filter(([, v]) => !v).map(([n]) => `--regen-retire-${n}`);
    if (missing.length) return ctx.say(`${leg}: off (set ${missing.join(", ")} to turn it on; it prepares and prints a Regen Ledger message and never signs it)`, "off");
    if (ctx.home.stopped()) return ctx.say(`${leg}: STOP is set, so the kit was not asked`, "held");
    const p = await kit(ctx, ["regen", "prepare", "retire", "--owner", o.regenRetireOwner, "--batch", o.regenRetireBatch, "--amount", o.regenRetireAmount, "--jurisdiction", o.regenRetireJurisdiction, "--reason", o.regenRetireReason, ...(o.regenLcd ? ["--lcd", o.regenLcd] : [])]);
    if (settle(ctx, leg, "prepare", p) !== "ok") return;
    const message = p.out.prepared?.message;
    if (p.out.sendable !== true || !message) return ctx.fail(leg, "prepare: the kit printed no retirement message, nothing was decided");
    const why = checkRegenRetire(message, o);
    if (why) throw new GuardError(`${leg}: refused the kit's message: ${why}`);
    ctx.say(`${leg}: retire ${o.regenRetireAmount} of batch ${o.regenRetireBatch} for ${o.regenRetireJurisdiction}. A sink: what it retires is gone for good, by design, and no return promised. The reason is written onchain, public and permanent.`);
    ctx.say(`${leg}: As of 2026-11-18 EcoWealth holds REGEN and may gain if it rises`);
    ctx.say(`${leg}: DRY, would sign this Regen message: ${clean(JSON.stringify(message), 800)}`, "dry");
    ctx.say(`${leg}: this bot signs no Regen message, with or without --live, and sends nothing. Signing it is a separate step you do with your own Regen wallet.`);
  },

  /** ETH to axlREGEN, a slice you set. */
  async regen(ctx) { return buy(ctx, "regen", ctx.opts.regenWei, ["regen", "prepare", "buy-regen"], "axlREGEN"); },
  /** ETH to ECO, a slice you set. */
  async eco(ctx) { return buy(ctx, "eco", ctx.opts.ecoWei, ["uniswap", "prepare", "swap", "--pool", "eth-eco"], "ECO"); },
  /** ETH to ECO by the NET circle kit's best route (the Zora coin pool or NET's pools), a slice you set. One way: you end up holding ECO. */
  async "eco-buy"(ctx) { return buyViaCircle(ctx, "eco-buy", ctx.opts.ecoBuyWei, "ECO", "eco-buy-eth"); },
  /** ETH to NET, a slice you set. One way: you end up holding NET. */
  async "net-buy"(ctx) { return buyViaCircle(ctx, "net-buy", ctx.opts.netWei, "NET", "net-eth"); },

  /** The NET circle, only when the kit's floor passes. */
  async circle(ctx) {
    const leg = "circle", size = ctx.opts.circleWei;
    if (!(size > 0n)) return ctx.say(`${leg}: off (set --circle-eth to turn it on)`, "off");
    const p = await ctx.kit(ctx.circleKitFile, ["prepare", "--from", ctx.address, "--size", formatEther(size)], ctx.rpcs);
    if (settle(ctx, leg, "prepare", p) !== "ok") return;
    const t = p.out.prepared;
    if (!(Number(t.deadline) * 1000 > ctx.now() + 3000)) return ctx.say(`${leg}: the prepared trip is past its deadline, skipped`, "held");
    await step(ctx, leg, `one trip through NET's pools (${clean(t.loop, 40)})`, t.tx, { sizeWei: size });
  },

  /** One small position by your rule: open, hold, close, start again. */
  async gmx(ctx) {
    const leg = "gmx", o = ctx.opts;
    if (!o.gmxMarket || !o.gmxSide || !o.gmxCollateral || !o.gmxLeverage) return ctx.say(`${leg}: off (set --gmx-market, --gmx-side, --gmx-collateral and --gmx-leverage to turn it on)`, "off");
    ctx.say(`${leg}: As of 2026-11-18 EcoWealth holds a stake in GMX and may gain if it rises`);
    const expectedMarket = chosenGmxMarket(o.gmxMarket);
    if (!expectedMarket) return ctx.halt(leg, "unknown GMX market: use ETH, BTC, ZORA or an explicit market token address");
    const mine = ctx.home.state().gmx ?? {};
    const orders = await kit(ctx, ["gmx", "orders", "--address", ctx.address]);
    if (settle(ctx, leg, "orders", orders) !== "ok") return;
    if (orders.out.length) return ctx.say(`${leg}: an order is waiting for GMX's keeper`, "held");
    const pos = await kit(ctx, ["gmx", "positions", "--address", ctx.address]);
    if (settle(ctx, leg, "positions", pos) !== "ok") return;
    if (mine.openedAt) {
      const ownPosition = pos.out.find((p) => same(p.market, expectedMarket) && p.isLong === (o.gmxSide === "long") && same(p.collateralToken ?? ADDR.arbitrumUsdc, ADDR.arbitrumUsdc));
      // A dry pass writes nothing into the home, so it says what a live pass would record and records none of it.
      if (!ownPosition) {
        if (ctx.live) { const s = ctx.home.state(); s.gmx = { closedAt: new Date(ctx.now()).toISOString() }; ctx.home.save(s); }
        return ctx.say(`${leg}: the position is gone (closed elsewhere, or liquidated)${ctx.live ? "" : "; a dry pass records nothing"}`, "not_due");
      }
      if (mine.closeRequestedAt) {
        // A leveraged position that may be stranded is a guard stop (exit 4), not a transient read failure (exit 1).
        throw new GuardError("the GMX close order is no longer queued but the position is still open. A keeper may have cancelled or rejected it; verify the position and order onchain before any new operation");
      }
      if (!mine.positionObservedAt) {
        if (ctx.live) {
          const state = ctx.home.state();
          state.gmx = { ...mine, positionObservedAt: new Date(ctx.now()).toISOString() };
          ctx.home.save(state);
        }
        return ctx.say(`${leg}: keeper execution confirmed by the position read; holding period begins now${ctx.live ? "" : " (a dry pass records nothing)"}`, "not_due");
      }
      if (!due(mine.positionObservedAt, o.gmxHoldHours, ctx.now())) return ctx.say(`${leg}: holding`, "not_due");
      const c = await kit(ctx, ["gmx", "prepare", "close", "--from", ctx.address, "--market", o.gmxMarket, "--side", o.gmxSide]);
      if (settle(ctx, leg, "close", c) !== "ok") return;
      if (!same(c.out.prepared?.tx?.to, ADDR.gmxExchangeRouter) || c.out.prepared.tx.data?.slice(0, 10).toLowerCase() !== SEL.multicall)
        throw new GuardError("gmx: close kit did not prepare a GMX market-order multicall");
      await step(ctx, leg, "submit the GMX position close order", c.out.prepared.tx, { gmxIntent: { ...gmxOrderIntent(o, "close"), closeSizeUsd: BigInt(ownPosition.sizeInUsd) }, completion: { bucket: "gmx", value: { ...mine, closeRequestedAt: new Date(ctx.now()).toISOString() } } });
      return;
    }
    if (pos.out.length) return ctx.say(`${leg}: this wallet already holds a GMX position this bot did not open, so it is left alone`, "held");
    if (!due(mine.closedAt, o.buyEveryHours, ctx.now())) return ctx.say(`${leg}: not due yet`, "not_due");
    const args = ["gmx", "prepare", "open", "--from", ctx.address, "--market", o.gmxMarket, "--side", o.gmxSide, "--collateral", o.gmxCollateral, "--leverage", o.gmxLeverage];
    for (let turn = 0; turn < 2; turn++) {
      const p = await kit(ctx, args);
      if (settle(ctx, leg, "open", p) !== "ok") return;
      const kind = p.out.prepared.step, tx = p.out.prepared.tx;
      if (kind !== "approve" && kind !== "order")
        throw new GuardError("gmx: the kit returned an unrecognized open step");
      if (kind === "approve" ? (!same(tx?.to, ADDR.arbitrumUsdc) || tx.data?.slice(0, 10).toLowerCase() !== SEL.approve)
          : (!same(tx?.to, ADDR.gmxExchangeRouter) || tx.data?.slice(0, 10).toLowerCase() !== SEL.multicall))
        throw new GuardError("gmx: the kit's step name does not match the transaction it prepared");
      const intent = gmxOrderIntent(o, "open");
      const got = await step(ctx, leg, kind === "approve" ? "the exact USDC approval" : `open ${o.gmxSide} ${o.gmxMarket}, ${o.gmxCollateral} USDC at ${o.gmxLeverage}x`, tx,
        { gmxIntent: intent, amount: as(kind === "approve" ? decodedAmount("USDC", ERC20, tx.data, 1) : tokenAmount("USDC", { raw: intent.collateralUnits }), kind === "approve" ? "the approval it sets" : "the collateral it posts"),
          ...(kind === "order" ? { completion: { bucket: "gmx", value: { openedAt: new Date(ctx.now()).toISOString() } } } : {}) });
      if (got === "dry" && kind === "approve") return ctx.say(`${leg}: DRY, then the order`);
      if (got !== "sent") return;
      if (kind === "order") return;
    }
  },
};

async function buy(ctx, leg, size, act, symbol) {
  if (!(size > 0n)) return ctx.say(`${leg}: off (set --${leg}-eth to turn it on)`, "off");
  if (!due(ctx.home.state()[leg]?.at, ctx.opts.buyEveryHours, ctx.now())) return ctx.say(`${leg}: not due yet`, "not_due");
  const p = await kit(ctx, [...act, "--from", ctx.address, "--size", formatEther(size)]);
  if (settle(ctx, leg, "buy", p) !== "ok") return;
  const t = p.out.prepared;
  if (t.disclosure) ctx.say(`${leg}: ${clean(t.disclosure)}`);
  if (leg === "eco") ctx.say("eco: As of 2026-11-18 EcoWealth both buys ECO and swaps ECO it holds for NET; the house can gain if ECO rises");
  if (leg === "regen") ctx.say("regen: As of 2026-11-18 EcoWealth holds REGEN and may gain if it rises");
  // The protocol kit prints the floor in token units already.
  const floor = tokenAmount(symbol, { decimal: t.minOut });
  await step(ctx, leg, `buy at least ${floor?.amount ?? clean(t.minOut, 40)} ${symbol}`, t.tx, { sizeWei: size, amount: as(floor, "the least you receive"), completion: { bucket: leg, value: { at: new Date(ctx.now()).toISOString() } } });
}

/** The NET circle kit's one-way buy: it prints the kit's own disclosure, and the step goes through the same gate and caps as every other. */
async function buyViaCircle(ctx, leg, size, symbol, flag) {
  if (!(size > 0n)) return ctx.say(`${leg}: off (set --${flag} to turn it on)`, "off");
  if (!due(ctx.home.state()[leg]?.at, ctx.opts.buyEveryHours, ctx.now())) return ctx.say(`${leg}: not due yet`, "not_due");
  const p = await ctx.kit(ctx.circleKitFile, ["buy", "--token", symbol, "--from", ctx.address, "--size", formatEther(size)], ctx.rpcs);
  if (settle(ctx, leg, "buy", p) !== "ok") return;
  const t = p.out.prepared;
  if (t.disclosure) ctx.say(`${leg}: ${clean(t.disclosure, 700)}`);
  // The circle kit prints the floor in RAW units of an 18 decimal token: say it in token units, with its symbol.
  const floor = tokenAmount(symbol, { raw: t.minOut });
  await step(ctx, leg, floor ? `buy at least ${floor.amount} ${symbol} by ${clean(t.route, 30)}` : `buy at least ${clean(t.minOut, 40)} units of ${symbol} by ${clean(t.route, 30)}`, t.tx,
    { sizeWei: size, amount: as(floor, "the least you receive"), completion: { bucket: leg, value: { at: new Date(ctx.now()).toISOString() } } });
}

// ---- one pass over the loop ------------------------------------------------------------------------------------------
/** The exit code of a pass that ended with one or more legs failed (a read failed, an error, a reverted send) and no stop or refusal. */
export const EXIT_LEG_FAILED = 5;
/** The states a leg can end a pass in, least to most to tell the owner. A leg keeps the highest state it reached. */
export const LEG_STATES = Object.freeze(["off", "not_due", "dry", "sent", "pending", "held", "failed", "refused"]);
const STATE_RANK = Object.fromEntries(LEG_STATES.map((s, i) => [s, i]));
/** Plain words for a report: one line, printable, and no web address (a kit's error text can carry the node address you chose). */
const reportText = (s, max = 400) => clean(s, max).replace(/\bhttps?:\/\/\S+/gi, "[url]");
const newReport = () => ({ legs: new Map() });

/**
 * What one pass did, as plain data for a machine to read. Every selected leg is there, with its state and the plain reason line.
 * A send carries its chain, its token symbol, its amount as a decimal in token units and as the raw integer (both strings), the
 * ETH it carried and its transaction hash once it has one. There is no key, no node address and no file path in it.
 */
export function passReport(ctx, exitCode) {
  const legs = LEG_ORDER.filter((name) => inReport(ctx, name)).map((name) => {
    const entry = ctx.report.legs.get(name);
    return {
      name, state: entry?.state ?? "held", reason: entry?.reason ?? "this leg did not run in this pass",
      sends: (entry?.sends ?? []).map((s) => ({ ...s, step: reportText(s.step, 200) })),
    };
  });
  return {
    bot: "protocol-bot", version: VERSION, mode: ctx.live ? "live" : "dry", address: ctx.address, exitCode,
    failedLegs: legs.filter((l) => l.state === "failed").map((l) => l.name),
    // null, or the one thing the bot cannot close itself: its take-backs kept reverting, so a kVCM approval may still be open
    // (token, spender, the kit command that checks it, and what it does). Set only by the take-back's own stop.
    approvalMayBeOpen: ctx.approvalMayBeOpen ?? null, legs,
  };
}

/** A leg is in a pass's report when it was selected, and also when the Klima leg was not but still settled a take-back it owed. */
const inReport = (ctx, leg) => ctx.opts.legs.includes(leg) || (leg === "klima" && ctx.report.legs.has(leg));
/**
 * The Klima leg's turn in a pass, selected or not. Order of business: (1) an owed take-back is settled FIRST, before 'off', before
 * 'not due yet', before the leg's stop, before any new approve or retire, and even when the leg was dropped from --legs or was
 * stopped earlier in this process; the one exception is an approve that is final and whose retirement has its turn now
 * (`retireNext`). (2) Only once nothing is owed does the leg stop for its reverts, and only then does its cycle run.
 * Returns the exit code the leg adds: 0, 1 (stopped) or 4 (a rule refused a step).
 */
async function klimaTurn(ctx, selected) {
  const leg = "klima", o = ctx.opts;
  try {
    const state = ctx.home.state();
    const owed = klimaTakeBackOwed(state.klima);
    if (!selected && !owed) return 0;
    const takeBackReverts = revertedInARow(state, KLIMA_TAKE_BACK_COUNT);
    if (owed && takeBackReverts >= SEND_FAILURE_LIMIT) { haltTakeBackStopped(ctx, takeBackReverts); return 1; }
    const stopped = revertedInARow(state, leg) >= SEND_FAILURE_LIMIT;
    const retireMayFollow = selected && !ctx.halted[leg] && !stopped && Boolean(o.klimaClass && o.klimaCredit && o.klimaTonnes) && klimaRetireNext(state.klima);
    if (owed && !retireMayFollow) {
      await takeKlimaApprovalBack(ctx);
      // A dry pass never clears the debt. A live pass moves on only when the take-back is final (or the kit says nothing was left open).
      if (!ctx.live || klimaTakeBackOwed(ctx.home.state().klima)) return ctx.halted[leg] ? 1 : 0;
    }
    if (!selected) return 0;
    if (ctx.halted[leg]) { ctx.say(`${leg}: stopped earlier (${ctx.halted[leg]})`, "refused"); return 1; }
    // Three reverted approves or retirements in a row, counted across passes and restarts, stop the leg: now that nothing is owed.
    if (stopKlimaIfSettled(ctx)) return 1;
    await LEGS.klima(ctx);
    return ctx.halted[leg] ? 1 : 0;
  } catch (e) {
    if (e instanceof GuardError) { ctx.halt(leg, e.message); return 4; }
    ctx.fail(leg, `stopped this pass: ${clean(e?.shortMessage || e?.message || e)}`);
    return ctx.halted[leg] ? 1 : 0;
  }
}

/** Walk the legs in order once. Returns the exit code: 0 the pass ran, 1 a leg was stopped, 4 a rule refused a step, 5 a leg failed (a failed read, an error or a reverted send; a leg that is off, not due or held is not a failure). */
export async function pass(ctx) {
  ctx.report = newReport(); // each pass reports on its own, so a long `run` never carries one pass's states into the next
  if (ctx.home.stopped()) {
    ctx.say(`stopped by the STOP file at ${ctx.home.files.stop}`); ctx.holdAll("stopped by the STOP file, nothing was asked or sent");
    // STOP is the owner's word that no retirement follows: an approve still waiting for its retirement is stranded, so the take-back
    // comes first when STOP is removed. A note in the state, nothing asked and nothing sent; if the home cannot be read, STOP still holds.
    try { strandKlimaRetire(ctx); } catch { /* the next pass that reads the home refuses it in plain words */ }
    return 0;
  }
  if (ctx.live) ctx.safeNow?.();
  const pending = ctx.home.state().pending;
  if (pending && ctx.live) {
    if (!pending.hash) { ctx.say(`a send got no answer (${clean(pending.leg, 20)}: ${clean(pending.name, 80)} on ${clean(pending.chain, 10)}): it may or may not have gone out. Nothing more will be sent. Verify the original nonce and chain history with independent RPCs; do NOT delete pending without an audited reconciliation.`); ctx.holdAll("an earlier send got no answer and may be out; nothing more is sent until the owner reconciles it"); return 0; }
    const seen = await ctx.io.seen(pending.chain, pending.hash);
    if (seen === null) { ctx.say(`the transaction ${clean(pending.hash, 66)} on ${clean(pending.chain, 10)} is not yet final, or its finality cannot be verified. No transactions will be sent; do NOT erase pending or resend by hand without independently reconciling its nonce and outcome.`); ctx.holdAll(`an earlier send on ${clean(pending.chain, 10)} is not final yet; nothing more is sent until it is`); return 0; }
    const s = ctx.home.state();
    if (s.pending?.hash !== pending.hash) throw new GuardError("pending transaction changed during recovery");
    if (pending.id) {
      const stage = ctx.home.journalStage(pending.id, ctx.now());
      if (stage === "reserved" || stage === "broadcast") ctx.home.record({
        id: pending.id, phase: "reconciled", at: new Date(ctx.now()).toISOString(),
        leg: pending.leg, name: pending.name, chain: pending.chain,
        to: pending.to ?? "", hash: pending.hash,
        valueWei: "0", feeBoundWei: "0", kvcmUnits: "0", usdcUnits: "0", status: seen ? "success" : "reverted",
      });
      else if (stage !== "receipt" && stage !== "reconciled")
        throw new GuardError("pending transaction has an invalid journal stage during reconciliation");
    }
    if (seen) applyCompletion(s, pending.completion);
    // A send found final here is counted like one seen final in its own pass: a revert is a failure of its leg (exit 5, and three
    // in a row stop it, across passes), a success resets the count. The count is saved in the same write that clears pending.
    const named = LEG_ORDER.includes(pending.leg);
    if (named) { const count = countFor(pending.leg, pending.name); countSendOutcome(s, count.key, Boolean(seen), count.resets); }
    delete s.pending; ctx.home.save(s);
    ctx.say(`reconciled ${seen ? "confirmed" : "reverted"} transaction ${clean(pending.hash, 66)}; its original budget reservation remains in the ledger`);
    if (!seen && named) ctx.say(`${pending.leg}: ${clean(pending.name, 80)} ${clean(pending.hash, 66)} was final and REVERTED, so it did not happen`, "failed");
  }
  let code = 0;
  for (const leg of LEG_ORDER) {
    if (leg === "klima") {
      // The Klima leg owes a take-back whether or not it is selected, and whether or not it was stopped: see klimaTurn.
      const c = await klimaTurn(ctx, ctx.opts.legs.includes(leg));
      if (c === 4) code = 4; else if (c) code = code || c;
      continue;
    }
    if (!ctx.opts.legs.includes(leg)) continue;
    if (ctx.halted[leg]) { ctx.say(`${leg}: stopped earlier (${ctx.halted[leg]})`, "refused"); code = code || 1; continue; }
    try {
      // Three reverted sends of one leg in a row (counted in state.sendFailures, across passes and restarts) stop the leg.
      const revertedInRow = revertedInARow(ctx.home.state(), leg);
      if (revertedInRow >= SEND_FAILURE_LIMIT) ctx.halt(leg, revertStopReason(leg, revertedInRow));
      else await LEGS[leg](ctx);
    } catch (e) {
      if (e instanceof GuardError) { ctx.halt(leg, e.message); code = 4; }
      else ctx.fail(leg, `stopped this pass: ${clean(e?.shortMessage || e?.message || e)}`);
    }
    if (ctx.halted[leg]) code = code || 1;
  }
  // A leg that failed is not a leg that was off, not due or held by a rule: say which ones, and do not exit 0.
  const failed = LEG_ORDER.filter((leg) => inReport(ctx, leg) && ctx.report.legs.get(leg)?.state === "failed");
  if (failed.length) {
    const them = failed.length === 1 ? "it" : "them";
    ctx.say(`this pass failed for ${failed.join(", ")}: a read failed or an error stopped ${them}, and nothing was decided for ${them} (exit ${EXIT_LEG_FAILED})`);
    code = code || EXIT_LEG_FAILED;
  }
  return code;
}

/** Everything a pass needs. `kit` and `io` can be swapped by a test; nothing else reaches the network or the key. */
export function makeContext({ opts, home, address, io, kit = runKit, say = (line) => console.log(line), now = () => Date.now(), sleep: pause = sleep }) {
  const safeNow = makeClockGuard(now);
  const checkedKit = (...args) => {
    if (opts.live && kit === runKit) verifyBundledKits(opts.kit, opts.circleKit);
    return kit(...args);
  };
  const ctx = {
    opts, home, address, io, kit: checkedKit, now, pause, safeNow, live: Boolean(opts.live), kitFile: opts.kit, circleKitFile: opts.circleKit, rpcs: opts.rpcs,
    caps: { maxTxFeeWei: opts.maxTxFeeWei, dayFeeWei: opts.dayFeeWei, daySpendWei: opts.daySpendWei, dayKvcmUnits: MAX_KVCM_APPROVE, dayUsdcUnits: MAX_GMX_USDC },
    halted: {}, fails: {}, report: newReport(), approvalMayBeOpen: null,
    /**
     * Say a line. With a state ("off", "not_due", "dry", "sent", "pending", "held", "failed", "refused") the line is also the
     * leg's reason in the pass report; the leg is the line's own "leg: " prefix. A leg keeps the highest state it reached.
     */
    say(line, state) {
      say(line);
      const named = state ? /^([a-z-]+): /.exec(line) : null;
      if (named) ctx.mark(named[1], state, line.slice(named[0].length));
    },
    mark(leg, state, reason) {
      if (!LEG_ORDER.includes(leg) || STATE_RANK[state] === undefined) return;
      let entry = ctx.report.legs.get(leg);
      if (!entry) { entry = { state, rank: -1, reason: "", sends: [] }; ctx.report.legs.set(leg, entry); }
      if (STATE_RANK[state] >= entry.rank) { entry.state = state; entry.rank = STATE_RANK[state]; entry.reason = reportText(reason); }
    },
    /** A leg that never ran this pass (STOP, an unsettled send) is held, with the pass's reason. */
    holdAll(reason) { for (const leg of ctx.opts.legs) if (!ctx.report.legs.has(leg)) ctx.mark(leg, "held", reason); },
    recordSend(leg, send) {
      if (!ctx.report.legs.has(leg)) ctx.report.legs.set(leg, { state: "off", rank: -1, reason: "", sends: [] });
      ctx.report.legs.get(leg).sends.push(send);
    },
    /** A read failed: three in a row stops the leg until the bot is started again. */
    fail(leg, why) { ctx.fails[leg] = (ctx.fails[leg] ?? 0) + 1; say(`${leg}: ${why}`); ctx.mark(leg, "failed", why); if (ctx.fails[leg] >= 3) ctx.halt(leg, "three failures in a row"); },
    halt(leg, why) { ctx.halted[leg] = clean(why); say(`${leg}: STOPPED: ${clean(why)}. Fix it and start the bot again.`); ctx.mark(leg, "refused", `STOPPED: ${clean(why)}`); },
  };
  return ctx;
}

// ---- the command line ------------------------------------------------------------------------------------------------
const FLAGS = new Set(["live", "json", "home","key-file", "address", "every", "legs", "buy-every-hours", "hydrex-top", "hydrex-vote", "klima-class", "klima-credit", "klima-tonnes", "klima-token-id", "klima-name", "regen-retire-owner", "regen-retire-batch", "regen-retire-amount", "regen-retire-jurisdiction", "regen-retire-reason", "regen-lcd", "regen-eth", "eco-eth", "eco-buy-eth", "net-eth", "circle-eth", "gmx-market", "gmx-side", "gmx-collateral", "gmx-leverage", "gmx-hold-hours", "day-fee-eth", "day-spend-eth", "max-tx-fee-eth", "kit", "circle-kit", "base-rpc", "arbitrum-rpc", "base-witness-rpc", "arbitrum-witness-rpc", "expect-commitment", "to", "from"]);
const BOOL = new Set(["live", "json"]);
const ethFlag = (name, v, max) => {
  if (v === undefined) return 0n;
  if (!/^\d+(\.\d{1,18})?$/.test(v)) throw new ArgError(`--${name} is an amount of ETH, like 0.0002`);
  const wei = parseEther(v);
  if (wei > max) throw new ArgError(`--${name} is at most ${formatEther(max)} ETH`);
  return wei;
};
const whole = (name, v, fallback, min, max) => {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ArgError(`--${name} is a whole number from ${min} to ${max}`);
  return n;
};
const addrFlag = (name, v) => { if (v !== undefined && !isAddress(v)) throw new ArgError(`--${name} is an address (0x and 40 hex characters)`); return v; };

export function parseArgs(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  if (!["run", "once", "wallet", "list", "audit", "compact", "backup", "restore", "help", undefined].includes(cmd)) throw new ArgError(`no command named ${clean(cmd, 20)}: use run, once, wallet, list, audit, compact, backup or restore`);
  const f = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--") || !FLAGS.has(a.slice(2))) throw new ArgError(`no flag named ${clean(a, 30)}`);
    const name = a.slice(2);
    if (BOOL.has(name)) { f[name] = true; continue; }
    if (rest[i + 1] === undefined) throw new ArgError(`${a} needs a value`);
    f[name] = rest[++i];
  }
  const home = path.resolve(f.home ?? path.join(os.homedir(), ".vealth-bot"));
  const legs = (f.legs ?? LEG_ORDER.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  for (const l of legs) if (!LEG_ORDER.includes(l)) throw new ArgError(`no leg named ${clean(l, 20)}: the legs are ${LEG_ORDER.join(", ")}`);
  if (f["hydrex-vote"] !== undefined && !validVote(f["hydrex-vote"])) throw new ArgError("--hydrex-vote is 0xPOOL:BPS pairs, comma separated, that sum to exactly 10000");
  if (f["gmx-side"] !== undefined && !["long", "short"].includes(f["gmx-side"])) throw new ArgError("--gmx-side is long or short");
  if (f["gmx-market"] !== undefined && !(/^[A-Za-z0-9.]{1,12}$/.test(f["gmx-market"]) || isAddress(f["gmx-market"]))) throw new ArgError("--gmx-market must be a market symbol like ETH or a 0x GMX market token address");
  for (const n of ["gmx-collateral", "gmx-leverage", "klima-tonnes"]) if (f[n] !== undefined && !/^\d+(\.\d+)?$/.test(f[n])) throw new ArgError(`--${n} is a number`);
  if (f["gmx-market"] !== undefined && !chosenGmxMarket(f["gmx-market"])) throw new ArgError("--gmx-market must be ETH, BTC, ZORA, or a GMX market token address");
  if (f["gmx-collateral"] !== undefined) {
    if (!/^\d+(\.\d{1,6})?$/.test(f["gmx-collateral"])) throw new ArgError("--gmx-collateral must have at most 6 decimal places");
    if (parseUnits(f["gmx-collateral"], 6) <= 0n || parseUnits(f["gmx-collateral"], 6) > MAX_GMX_USDC) throw new ArgError("--gmx-collateral must be above zero and at most 5 USDC");
  }
  if (f["gmx-leverage"] !== undefined && (!/^\d+(\.\d)?$/.test(f["gmx-leverage"]) || Number(f["gmx-leverage"]) < 1 || Number(f["gmx-leverage"]) > 10)) throw new ArgError("--gmx-leverage must be from 1x to 10x, in tenths");
  if (f["klima-token-id"] !== undefined && !/^\d{1,78}$/.test(f["klima-token-id"])) throw new ArgError("--klima-token-id is a whole number");
  const name = f["klima-name"] ?? "my bot";
  if (!/^[\x20-\x7E]{1,64}$/.test(name) || name.startsWith("-")) throw new ArgError("--klima-name is 1 to 64 plain characters and is public for good");
  for (const [n, re, what] of [["owner", REGEN_RETIRE_RE.owner, "a regen1... address (your own Regen wallet)"], ["batch", REGEN_RETIRE_RE.batch, "a credit batch denom such as C01-001-20150101-20151231-001"], ["jurisdiction", REGEN_RETIRE_RE.jurisdiction, "a jurisdiction like US, US-CA or US-CA 90001"]]) {
    if (f[`regen-retire-${n}`] !== undefined && !re.test(f[`regen-retire-${n}`])) throw new ArgError(`--regen-retire-${n} is ${what}`);
  }
  const retireAmount = f["regen-retire-amount"], retireReason = f["regen-retire-reason"], regenLcd = f["regen-lcd"];
  if (retireAmount !== undefined && (!REGEN_RETIRE_RE.amount.test(retireAmount) || !(Number(retireAmount) > 0))) throw new ArgError("--regen-retire-amount is a positive number of credits with at most 6 decimal places");
  if (retireReason !== undefined && (!/^[\x20-\x7E]{1,200}$/.test(retireReason) || retireReason.startsWith("-") || clean(retireReason, 200) !== retireReason)) throw new ArgError("--regen-retire-reason is 1 to 200 plain characters, single spaced, not starting with a dash; it is written onchain, public and permanent");
  if (regenLcd !== undefined) { let u = null; try { u = new URL(regenLcd); } catch { u = null; } if (!u || u.protocol !== "https:" || u.username || u.password) throw new ArgError("--regen-lcd is an https address with no login in it"); }
  if (f["expect-commitment"] !== undefined && (!["audit", "restore"].includes(cmd) || !/^[a-f0-9]{64}$/.test(f["expect-commitment"])))
    throw new ArgError("--expect-commitment belongs to `audit` and `restore` and is the 64 hex characters an earlier audit or backup printed as auditCommitment");
  if (f.json && cmd !== "once") throw new ArgError("--json belongs to `once`: it prints one JSON object on stdout when the pass ends");
  if (f.to !== undefined && cmd !== "backup") throw new ArgError("--to belongs to `backup`");
  if (f.from !== undefined && cmd !== "restore") throw new ArgError("--from belongs to `restore`");
  if (cmd === "restore" && f.home === undefined) throw new ArgError("restore needs --home PATH: the NEW folder to build (it must not exist yet)");
  const parsed = {
    cmd: cmd ?? "help", live: Boolean(f.live), json: Boolean(f.json), home, expectCommitment: f["expect-commitment"],
    to: f.to === undefined ? undefined : path.resolve(f.to), from: f.from === undefined ? undefined : path.resolve(f.from), keyFile: path.resolve(f["key-file"] ?? path.join(home, "wallet.key")), address: addrFlag("address", f.address), legs,
    everyMinutes: whole("every", f.every, DEFAULTS.everyMinutes, 1, 10_080), buyEveryHours: whole("buy-every-hours", f["buy-every-hours"], DEFAULTS.buyEveryHours, 1, 8_760),
    hydrexTop: whole("hydrex-top", f["hydrex-top"], DEFAULTS.hydrexTop, 1, 10), hydrexVote: f["hydrex-vote"],
    klimaClass: addrFlag("klima-class", f["klima-class"]), klimaCredit: addrFlag("klima-credit", f["klima-credit"]), klimaTonnes: f["klima-tonnes"], klimaTokenId: f["klima-token-id"], klimaName: name,
    regenRetireOwner: f["regen-retire-owner"], regenRetireBatch: f["regen-retire-batch"], regenRetireAmount: retireAmount, regenRetireJurisdiction: f["regen-retire-jurisdiction"], regenRetireReason: retireReason, regenLcd,
    regenWei: ethFlag("regen-eth", f["regen-eth"], MAX_LEG_ETH_WEI), ecoWei: ethFlag("eco-eth", f["eco-eth"], MAX_LEG_ETH_WEI), ecoBuyWei: ethFlag("eco-buy-eth", f["eco-buy-eth"], MAX_LEG_ETH_WEI), netWei: ethFlag("net-eth", f["net-eth"], MAX_LEG_ETH_WEI), circleWei: ethFlag("circle-eth", f["circle-eth"], MAX_LEG_ETH_WEI),
    gmxMarket: f["gmx-market"], gmxSide: f["gmx-side"], gmxCollateral: f["gmx-collateral"], gmxLeverage: f["gmx-leverage"], gmxHoldHours: whole("gmx-hold-hours", f["gmx-hold-hours"], DEFAULTS.gmxHoldHours, 1, 8_760),
    dayFeeWei: ethFlag("day-fee-eth", f["day-fee-eth"] ?? DEFAULTS.dayFeeEth, HARD_MAX.dayFeeWei), daySpendWei: ethFlag("day-spend-eth", f["day-spend-eth"] ?? DEFAULTS.daySpendEth, HARD_MAX.daySpendWei),
    maxTxFeeWei: ethFlag("max-tx-fee-eth", f["max-tx-fee-eth"] ?? DEFAULTS.maxTxFeeEth, HARD_MAX.maxTxFeeWei),
    kit: path.resolve(f.kit ?? DEFAULT_KIT), circleKit: path.resolve(f["circle-kit"] ?? DEFAULT_CIRCLE_KIT),
    rpcs: { base: f["base-rpc"] ?? env.BASE_RPC_URL ?? CHAINS.base.rpc, arbitrum: f["arbitrum-rpc"] ?? env.ARBITRUM_RPC_URL ?? CHAINS.arbitrum.rpc },
    witnessRpcs: { base: f["base-witness-rpc"] ?? env.BASE_WITNESS_RPC_URL, arbitrum: f["arbitrum-witness-rpc"] ?? env.ARBITRUM_WITNESS_RPC_URL },
  };
  if (parsed.live) {
    // Every chain ANY of a leg's rules signs on, not only the first rule's: a leg that later gains a step on a second
    // chain must not sign there on one node's word.
    const signingChains = new Set(parsed.legs.flatMap((leg) => (RULES[leg] ?? []).map((r) => r.chain)).filter(Boolean));
    for (const chain of signingChains)
      assertWitnessRpcConfiguration(parsed.rpcs[chain], parsed.witnessRpcs[chain], chain);
  }
  return parsed;
}

export const HELP = `vealth protocol bot ${VERSION}: one loop over Hydrex, Klima, Regen, ECO (the Zora coin), NET's circle and GMX, with your own key.
Never an offer or advice, no return promised. DRY unless you pass --live.

  node bot.mjs once --address 0xYOU        a dry pass for any address: no key, nothing signed, nothing sent, nothing written, no lock taken
  node bot.mjs once --json ...             one JSON object on stdout when the pass ends (dry or live); the human lines go to stderr
  node bot.mjs wallet                      make the bot's wallet in <home>/wallet.key (never overwrites one)
  node bot.mjs once --live ...             one pass that sends (for cron or launchd)
  node bot.mjs audit --home PATH            verify the stopped journal and all archived hashes (no key or RPC)
           [--expect-commitment HEX]        exit 3 unless the home matches the commitment you saved (restore check)
  node bot.mjs backup --home PATH --to NEW  copy the stopped home's memory (never the key) into a new private folder and prove the copy
  node bot.mjs restore --from BACKUP --home NEW [--expect-commitment HEX]   build a NEW home from a backup, verified file by file; never overwrites
  node bot.mjs compact --home PATH          archive finalized rows older than 48h; recover interrupted rotation (no key or RPC)
  node bot.mjs run --live ...              the loop, forever, one pass every --every minutes (default ${DEFAULTS.everyMinutes})
  node bot.mjs list                        every contract call this program can sign, and nothing else

Legs (--legs hydrex,klima,regen-retire,regen,eco,eco-buy,net-buy,circle,gmx; default all, each one off until it has what it needs):
  hydrex   needs a veHYDX lock in the wallet. [--hydrex-top ${DEFAULTS.hydrexTop}] [--hydrex-vote 0xPOOL:10000 to use your own vote]
  klima    --klima-class 0x.. --klima-credit 0x.. --klima-tonnes 0.01 [--klima-token-id n] [--klima-name "my bot"]
  regen-retire  --regen-retire-owner regen1.. --regen-retire-batch C01-.. --regen-retire-amount 1 --regen-retire-jurisdiction US-CA
           --regen-retire-reason "text" [--regen-lcd https://..]   prepares the Regen Ledger retirement message and prints it.
           It never signs or sends, with or without --live: you sign the message with your own Regen wallet.
  regen    --regen-eth 0.0002        eco   --eco-eth 0.0002        circle   --circle-eth 0.0001
  eco-buy  --eco-buy-eth 0.0002      net-buy  --net-eth 0.0002   one-way buys by the NET circle kit's best route: you end up holding ECO or NET
  gmx      --gmx-market ETH --gmx-side long --gmx-collateral 5 --gmx-leverage 2 [--gmx-hold-hours ${DEFAULTS.gmxHoldHours}]
Pace and caps:
  --buy-every-hours ${DEFAULTS.buyEveryHours}   --day-fee-eth ${DEFAULTS.dayFeeEth}   --day-spend-eth ${DEFAULTS.daySpendEth}   --max-tx-fee-eth ${DEFAULTS.maxTxFeeEth}
Where things are:
  --home ~/.vealth-bot   --key-file <home>/wallet.key   --base-rpc / --arbitrum-rpc (or BASE_RPC_URL / ARBITRUM_RPC_URL)
  LIVE must also set --base-witness-rpc and --arbitrum-witness-rpc (or BASE_WITNESS_RPC_URL / ARBITRUM_WITNESS_RPC_URL)
  for each active signing chain. Use genuinely separate HTTPS providers; RPC disagreement leaves sends pending.
Stop it: touch <home>/STOP. Everything it sent is in <home>/ledger.jsonl. A stale <home>/lock needs manual recovery after checking the previous bot is stopped.
Exit codes: 0 the pass ran clean | 1 a leg was stopped | 2 bad arguments | 3 the audit did not match your saved commitment | 4 a rule refused a step (nothing was sent) | ${EXIT_LEG_FAILED} a leg failed (a failed read, an error or a reverted send)
A leg that is off, not due or held by a rule is not a failure: it does not change the exit code.`;

export function listText() {
  const lines = ["Every contract call this program can sign. A step that is not here is refused.", ""];
  for (const leg of LEG_ORDER) for (const r of RULES[leg] ?? []) {
    const value = r.value === "zero" ? "no ETH" : r.value === "size" ? "at most the size you set" : `at most ${eth(MAX_GMX_EXECUTION_FEE_WEI)} as GMX's execution fee`;
    lines.push(`${leg.padEnd(7)} ${r.chain.padEnd(9)} ${r.to}  ${r.fn}  (${value}${r.spender ? `; spender ${r.spender} only, at most ${r.maxAmount} units` : ""})`);
  }
  for (const leg of UNSIGNED_LEGS) lines.push("", `${leg} signs nothing: it prepares a message and prints it for you to sign yourself, so it has no line above`);
  return lines.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Keep a forever-loop cadence using monotonic time, not a mutable wall date. */
export async function waitForNextPass(minutes, sleeper = sleep, ticks = () => process.hrtime.bigint()) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080)
    throw new GuardError("the pass interval must be 1 to 10080 whole minutes");
  const end = ticks() + BigInt(minutes) * 60_000_000_000n;
  for (;;) {
    const remaining = end - ticks();
    if (remaining <= 0n) return;
    await sleeper(Math.min(60_000, Math.max(1, Number(remaining / 1_000_000n))));
  }
}
/**
 * One wallet, one running bot home on this machine. Two homes (or two copies of the bot) signing for the same
 * address would each count only their own spending and could race for the same nonce, so the second is refused.
 * The lease is a file named for the address in a private per-user folder; like the home lock it is NOT stolen after
 * a crash: confirm the first bot is stopped, then remove the file it names. It does not span machines.
 */
export function acquireWalletLease(address, home, { dir = process.env.VEALTH_BOT_LEASE_DIR ?? path.join(os.homedir(), ".vealth-bot-leases"), pid = process.pid } = {}) {
  if (!isAddress(String(address ?? ""))) throw new GuardError("a wallet lease needs one valid wallet address");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.platform !== "win32" && (st.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && st.uid !== process.getuid()))
    throw new GuardError("the wallet lease folder must be a private real directory owned by you (chmod 700; no symlinks)");
  const file = path.join(dir, `${String(address).toLowerCase()}.lease`);
  const nonce = randomBytes(16).toString("hex");
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (e) {
    if (e?.code !== "EEXIST") throw e;
    let who = "another bot";
    try { const held = JSON.parse(fs.readFileSync(file, "utf8")); who = `the bot home ${clean(held.home, 120)} (pid ${clean(held.pid, 12)}, since ${clean(held.at, 30)})`; } catch { /* unreadable lease is still a lease */ }
    throw new GuardError(`this wallet is already in use by ${who}. One wallet runs from one bot home at a time. If that bot is stopped, remove ${file} and start again`);
  }
  try { fs.writeFileSync(fd, JSON.stringify({ home, pid, nonce, at: new Date().toISOString() })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(dir);
  return { file, release() {
    try { if (JSON.parse(fs.readFileSync(file, "utf8")).nonce === nonce) fs.unlinkSync(file); } catch { /* already gone or not ours */ }
  } };
}

const COMMITMENT_MISMATCH ="bot: this home does not match the commitment you saved: it may be an older backup (spending forgotten), a newer one, or altered. Do not run it live until you reconcile it against the chain.";

/** One read-only look at a stopped home: validate the whole journal and its archives, and hash what is there. The caller holds the home lock. */
async function auditHome(dir) {
  const home = openHome(dir);
  const totals = home.day(Date.now()), state = home.state();
  const archiveInventory = fs.existsSync(home.files.state) ? verifyArchiveInventory(dir) : { segments: 0, archivedBytes: 0, root: "GENESIS" };
  const bytes = fs.existsSync(home.files.ledger) ? fs.statSync(home.files.ledger).size : 0;
  const ledgerSha256 = bytes ? await hashLocalFile(home.files.ledger) : null;
  const stateSha256 = fs.existsSync(home.files.state) ? await hashLocalFile(home.files.state) : null;
  const auditCommitment = createHash("sha256").update(JSON.stringify({
    schemaVersion: STORAGE_SCHEMA_VERSION, wallet: state.walletAddress ?? null,
    ledgerSha256, stateSha256, archiveHead: archiveInventory.root
  })).digest("hex");
  return { home: dir, schemaVersion: STORAGE_SCHEMA_VERSION,
    ledgerSha256, stateSha256, auditCommitment, archives: archiveInventory, wallet: state.walletAddress ?? null,
    pending: state.pending ? { leg: state.pending.leg, chain: state.pending.chain,
      hash: state.pending.hash ?? null, nonce: state.pending.nonce ?? null } : null,
    ledgerBytes: bytes, rolling24Hours: { feeWei: String(totals.feeWei),
      spendWei: String(totals.spendWei), kvcmUnits: String(totals.kvcmUnits),
      usdcUnits: String(totals.usdcUnits) } };
}

// ---- backup and restore ------------------------------------------------------------------------------------------------
// A backup holds exactly the bot's memory: state.json, ledger.jsonl and its archived segments, with a manifest of their
// hashes and the audit commitment. It never holds the wallet key, the lock or the STOP file.
const BACKUP_FORMAT = "vealth-bot-backup";
const BACKUP_FILE_RE = /^(?:state\.json|ledger\.jsonl|archives\/ledger-[0-9a-f]{64}\.jsonl)$/;
const MAX_BACKUP_MANIFEST_BYTES = 1024 * 1024;
const insideOrSame = (parent, child) => { const rel = path.relative(parent, child); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
function copyPrivateFile(src, dst) {
  fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(dst, 0o600);
  const fd = fs.openSync(dst, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
/** Copy a stopped home's memory into a NEW private folder and prove the copy matches. The caller holds the home lock. */
export async function backupHome(homeDir, to) {
  if (!to) throw new ArgError("backup needs --to PATH, a folder that does not exist yet");
  const dest = path.resolve(to);
  if (fs.existsSync(dest)) throw new ArgError("the backup folder already exists; a backup never overwrites anything, choose a new one");
  if (insideOrSame(homeDir, dest) || insideOrSame(dest, homeDir)) throw new ArgError("the backup folder cannot be inside the bot home or contain it");
  if (!fs.existsSync(path.dirname(dest))) throw new ArgError("the folder that will hold the backup does not exist");
  const before = await auditHome(homeDir); // a corrupt home is refused here, never copied as if it were good
  const state = openHome(homeDir).state();
  const names = ["state.json"];
  if (fs.existsSync(path.join(homeDir, "ledger.jsonl"))) names.push("ledger.jsonl");
  for (const entry of state.archives ?? []) names.push(`archives/${entry.file}`);
  fs.mkdirSync(dest, { mode: 0o700 });
  fs.mkdirSync(path.join(dest, "archives"), { mode: 0o700 });
  const files = [];
  for (const name of names) {
    const src = path.join(homeDir, name), dst = path.join(dest, name);
    copyPrivateFile(src, dst);
    const sha256 = await hashLocalFile(dst);
    if (sha256 !== await hashLocalFile(src)) throw new GuardError(`the copy of ${name} does not match its source; the backup is not trustworthy`);
    files.push({ path: name, bytes: fs.statSync(dst).size, sha256 });
  }
  const manifest = { format: BACKUP_FORMAT, version: 1, createdAt: new Date().toISOString(),
    wallet: before.wallet, auditCommitment: before.auditCommitment, archiveHead: before.archives.root, files };
  const tmp = path.join(dest, `MANIFEST.json.${randomBytes(8).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(manifest, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path.join(dest, "MANIFEST.json"));
  syncDirectory(path.join(dest, "archives")); syncDirectory(dest); syncDirectory(path.dirname(dest));
  const after = await auditHome(dest); // read the copy back the way a restore will
  if (after.auditCommitment !== before.auditCommitment) throw new GuardError("the backup does not read back to the same audit commitment; it is not trustworthy");
  return { backup: dest, auditCommitment: after.auditCommitment, wallet: after.wallet, files: files.length,
    note: "Save auditCommitment somewhere other than this machine. The wallet key is NOT in the backup. The backup may hold signed transaction bytes: keep it private." };
}
/** Build a NEW home from a backup, verified file by file and against the audit commitment, and only then put it in place. */
export async function restoreHome(from, homeDir, expectCommitment) {
  if (!from) throw new ArgError("restore needs --from PATH, a backup folder made by `backup`");
  const source = path.resolve(from);
  if (fs.existsSync(homeDir)) throw new ArgError("the bot home already exists; restore only creates a new home and never overwrites one");
  if (!fs.existsSync(path.dirname(homeDir))) throw new ArgError("the folder that will hold the restored home does not exist");
  if (insideOrSame(source, homeDir) || insideOrSame(homeDir, source)) throw new ArgError("the backup and the restored home cannot contain each other");
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new ArgError("--from must be a real backup folder");
  const manifestFile = path.join(source, "MANIFEST.json");
  const manifestStat = fs.lstatSync(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_BACKUP_MANIFEST_BYTES) throw new GuardError("the backup manifest is missing or not a plain file");
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch { throw new GuardError("the backup manifest is not valid JSON"); }
  if (manifest?.format !== BACKUP_FORMAT || manifest.version !== 1 || !Array.isArray(manifest.files) ||
      !/^[0-9a-f]{64}$/.test(manifest.auditCommitment ?? ""))
    throw new GuardError("the backup manifest is not a version 1 bot backup");
  const listed = new Set();
  for (const f of manifest.files) {
    if (!f || typeof f.path !== "string" || !BACKUP_FILE_RE.test(f.path) || listed.has(f.path) ||
        !Number.isSafeInteger(f.bytes) || f.bytes < 0 || !/^[0-9a-f]{64}$/.test(f.sha256 ?? ""))
      throw new GuardError("the backup manifest lists a file the bot never backs up, or lists one twice");
    listed.add(f.path);
  }
  if (!listed.has("state.json")) throw new GuardError("the backup holds no state.json");
  // Nothing may sit in the backup that the manifest does not vouch for (a wallet key, a lock, a stray file).
  const present = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "MANIFEST.json") continue;
    if (entry.isDirectory() && entry.name === "archives") {
      for (const a of fs.readdirSync(path.join(source, "archives"))) present.push(`archives/${a}`);
    } else present.push(entry.name);
  }
  for (const name of present) if (!listed.has(name)) throw new GuardError(`the backup holds a file its manifest does not list: ${clean(name, 80)}`);
  for (const name of listed) if (!present.includes(name)) throw new GuardError(`the backup is missing ${clean(name, 80)}`);
  const stage = fs.mkdtempSync(path.join(path.dirname(homeDir), ".vealth-bot-restore-"));
  const discard = () => fs.rmSync(stage, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(stage, "archives"), { mode: 0o700 });
    for (const f of manifest.files) {
      const src = path.join(source, f.path), dst = path.join(stage, f.path);
      const st = fs.lstatSync(src);
      if (!st.isFile() || st.isSymbolicLink() || st.size !== f.bytes) throw new GuardError(`${f.path} in the backup is not the file its manifest describes`);
      copyPrivateFile(src, dst);
      if (await hashLocalFile(dst) !== f.sha256) throw new GuardError(`${f.path} in the backup has been altered: its hash differs from the manifest`);
    }
    syncDirectory(path.join(stage, "archives")); syncDirectory(stage);
    const audited = await auditHome(stage);
    if (audited.auditCommitment !== manifest.auditCommitment) throw new GuardError("the restored files do not reproduce the commitment in the manifest");
    if (expectCommitment !== undefined && expectCommitment !== audited.auditCommitment) {
      discard();
      console.error(COMMITMENT_MISMATCH);
      return null;
    }
    fs.renameSync(stage, homeDir);
    syncDirectory(path.dirname(homeDir));
    return { restored: homeDir, auditCommitment: audited.auditCommitment, wallet: audited.wallet, pending: audited.pending,
      verifiedAgainst: expectCommitment === undefined ? "the backup's own manifest only; pass --expect-commitment with the value you saved elsewhere" : "the commitment you saved",
      note: "The wallet key is not in a backup: put the SAME wallet's key at <home>/wallet.key (chmod 600) or pass --key-file. A send that was in doubt is still in doubt and stays blocked." };
  } catch (e) { if (fs.existsSync(stage)) discard(); throw e; }
}

export async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) {
    if (e instanceof ArgError) {
      console.error(`bot: ${e.message}`);
      // A machine that asked for --json gets its answer as JSON, even when the arguments were refused.
      if (argv[0] === "once" && argv.includes("--json")) console.log(JSON.stringify({ bot: "protocol-bot", version: VERSION, exitCode: 2, error: reportText(e.message) }, null, 2));
      return 2;
    }
    throw e;
  }
  if (opts.cmd === "help") { console.log(HELP); return 0; }
  if (opts.cmd === "list") { console.log(listText()); return 0; }
  try {
    if (opts.cmd === "audit") {
      if (!fs.existsSync(opts.home)) throw new ArgError("audit needs an existing bot home; refusing to create empty history");
      const home = openHome(opts.home);
      if (!home.lock()) throw new ArgError("audit cannot run while the bot home is locked; stop the bot first");
      try {
        const reported = await auditHome(opts.home);
        console.log(JSON.stringify(reported, null, 2));
        // A restored copy that differs from the commitment the owner saved elsewhere is an older, newer or
        // altered history: the spending it remembers cannot be trusted, so the audit does not pass.
        if (opts.expectCommitment !== undefined && opts.expectCommitment !== reported.auditCommitment) {
          console.error(COMMITMENT_MISMATCH);
          return 3;
        }
        return 0;
      } finally { home.unlock(); }
    }
    if (opts.cmd === "backup") {
      if (!fs.existsSync(opts.home)) throw new ArgError("backup needs an existing bot home");
      const home = openHome(opts.home);
      if (!home.lock()) throw new ArgError("backup cannot run while the bot home is locked; stop the bot first");
      try { console.log(JSON.stringify(await backupHome(opts.home, opts.to), null, 2)); return 0; }
      finally { home.unlock(); }
    }
    if (opts.cmd === "restore") {
      const restored = await restoreHome(opts.from, opts.home, opts.expectCommitment);
      if (!restored) return 3;
      console.log(JSON.stringify(restored, null, 2));
      return 0;
    }
    if (opts.cmd === "compact") {
      if (!fs.existsSync(opts.home)) throw new ArgError("compact needs an existing bot home");
      const home = openHome(opts.home);
      if (!home.lock()) throw new ArgError("compact cannot run while another bot holds the journal lock");
      try {
        const now = Date.now();
        const report = archiveJournal(opts.home, { locked: true, now, force: true, validateActive: () => home.day(now) });
        console.log(JSON.stringify(report, null, 2));
        return 0;
      } finally { home.unlock(); }
    }    if (opts.cmd === "wallet") {
      const w = makeWallet(opts.keyFile);
      console.log(`${w.made ? "made a new wallet" : "the wallet is"} ${w.address}\nits key is in ${opts.keyFile}, readable by you alone. Keep in it only what you can lose.`);
      return 0;
    }
    if (opts.live) verifyBundledKits(opts.kit, opts.circleKit);
    const account = opts.live ? loadAccount(opts.keyFile) : null;
    const address = account?.address ?? opts.address ?? (fs.existsSync(opts.keyFile) ? loadAccount(opts.keyFile).address : null);
    if (!address) throw new ArgError("a dry pass needs --address 0xYOU (or a wallet: run `node bot.mjs wallet`)");
    if (opts.live && opts.address && !same(opts.address, address)) throw new ArgError("--address is not the address of the key file");
    // A dry pass takes no exclusive lock and writes nothing into the home (it only reads what is there), so it runs beside a
    // live bot that holds the lock. Only a live pass locks the home, takes the wallet lease and rotates the journal.
    const home = openHome(opts.home, { readOnly: !opts.live });
    if (opts.live && !home.lock()) throw new ArgError(`the home ${opts.home} is locked: a bot may still be running or left a stale lock. Confirm it is stopped before manually removing ${home.files.lock}`);
    // With --json, stdout holds the one JSON object and nothing else: every human line goes to stderr.
    const say = opts.json ? (line) => console.error(line) : (line) => console.log(line);
    let lease = null;
    try {
      // One wallet, one running home on this machine: a second home signing for the same address is refused.
      if (opts.live) lease = acquireWalletLease(address, opts.home);
      // Finish a previously interrupted *local* archive using only verified disk hashes.
      // This cannot sign, broadcast or reset a pending onchain transaction.
      if (opts.live) {
        const recovered = archiveJournal(opts.home, { locked: true, recoveryOnly: true });
        if (recovered.archived) say(`journal archive recovered ${recovered.bytes} verified bytes`);
      }
      const ctx = makeContext({ opts, home, address, io: makeChainIo(account, opts.rpcs, opts.witnessRpcs), say });
      say(`bot ${VERSION} for ${address}: ${opts.live ? "LIVE, it sends" : "DRY, nothing is sent"}`);
      if (opts.cmd === "once") {
        const code = await pass(ctx);
        if (opts.json) console.log(JSON.stringify(passReport(ctx, code), null, 2));
        return code;
      }
      for (;;) {
        await pass(ctx);
        // Only rotate a complete, old and settled journal prefix, under the lock.
        // The state marker blocks trading if power is lost during the rotation.
        if (opts.live && !home.stopped() && !home.state().pending && fs.existsSync(home.files.ledger) &&
            fs.statSync(home.files.ledger).size >= ARCHIVE_TRIGGER_BYTES) {
          archiveJournal(opts.home, { locked: true, now: Date.now(), validateActive: () => home.day(Date.now()) });
        }
        // Finalized receipts can appear between ordinary hourly passes.
        // Poll a known pending hash at most every 5 minutes; hashless sends
        // remain manually blocked and use the ordinary cadence.
        const pendingHash = !home.stopped() && home.state().pending?.hash;
        await waitForNextPass(pendingHash ? Math.min(5, opts.everyMinutes) : opts.everyMinutes);
      }
    } finally { lease?.release(); home.unlock(); }
  } catch (e) {
    const code = e instanceof ArgError ? 2 : 1;
    const message = e instanceof ArgError ? e.message : clean(e?.shortMessage || e?.message || e);
    console.error(`bot: ${message}`);
    if (opts.json) console.log(JSON.stringify({ bot: "protocol-bot", version: VERSION, mode: opts.live ? "live" : "dry", exitCode: code, error: reportText(message) }, null, 2));
    return code;
  }
}

let direct = false;
try { direct = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { direct = false; }
if (direct) main(process.argv.slice(2)).then((c) => process.exit(c));
