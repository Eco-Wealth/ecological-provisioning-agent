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
//   regen    buy axlREGEN (Regen's token on Base) with a slice of ETH you set. EcoWealth holds REGEN and may gain if it rises.
//   eco      buy ECO, the coin EcoWealth made on Zora, with a slice of ETH you set. EcoWealth created ECO. As of 2026-11-18
//            it holds it and may gain if it rises; it both buys ECO and swaps ECO it holds for NET.
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
//
// One dependency, to sign and send: `npm ci` (viem, pinned). Node 22 or newer. No build step.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, decodeAbiParameters, decodeFunctionData, formatEther, http, isAddress, parseAbi, parseAbiParameters, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base } from "viem/chains";

export const VERSION = "0.1.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_KIT = path.resolve(HERE, "../../skills/protocol-guide/protocol-guide.mjs");
export const DEFAULT_CIRCLE_KIT = path.resolve(HERE, "../../skills/net-circle/net-circle.mjs");
export const CHAINS = {
  base: { id: 8453, env: "BASE_RPC_URL", rpc: "https://mainnet.base.org", viem: base },
  arbitrum: { id: 42161, env: "ARBITRUM_RPC_URL", rpc: "https://arb1.arbitrum.io/rpc", viem: arbitrum },
};
export const LEG_ORDER = ["hydrex", "klima", "regen", "eco", "circle", "gmx"];

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
};
const ZERO = "0x0000000000000000000000000000000000000000";

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
 * The gate every step passes before it is signed. Returns null when the step is on the list, or the reason it is refused.
 * Pure: no network, no key. `sizeWei` is the size you set for that leg (only read by "size" rules).
 */
export function checkTx(leg, tx, { from, sizeWei = 0n, maxTxFeeWei }) {
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
  const l1 = big(tx.l1FeeBoundWei ?? 0) ?? 0n;
  const feeBound = gas * feePer + (l1 > 0n ? l1 : 0n);
  if (feeBound > maxTxFeeWei) return `the step could cost ${eth(feeBound)} in fees, above your cap of ${eth(maxTxFeeWei)} for one transaction`;
  if (rule.fn === "approve") {
    let args; try { args = decodeFunctionData({ abi: ERC20, data: tx.data }).args; } catch { return "the approval does not decode"; }
    if (!same(args[0], rule.spender)) return `the approval names ${clean(args[0], 42)} as spender, not ${rule.spender}`;
    if (args[1] > rule.maxAmount) return `the approval covers ${args[1]} units, above the cap ${rule.maxAmount}`;
  }
  if (rule.fn === "retireCreditViaKlima") {
    let args; try { args = decodeFunctionData({ abi: KLIMA_ABI, data: tx.data }).args; } catch { return "the Klima retirement does not decode"; }
    if (!same(args[4], ADDR.kvcm)) return "the Klima retirement must spend kVCM, not a different input token";
    if (args[6] <= 0n || args[6] > MAX_KVCM_APPROVE) return `the Klima retirement may spend ${args[6]} kVCM units, outside the cap of ${MAX_KVCM_APPROVE}`;
  }
  if (rule.gmx) {
    const why = checkGmxMulticall(tx.data, { from, value });
    if (why) return why;
  }
  if (rule.router) {
    const why = checkRouterExecute(tx.data, { from, value, shape: rule.router });
    if (why) return why;
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
function checkRouterExecute(data, { from, value, shape }) {
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
      if (cmds[cmds.length - 1] !== ROUTER_CMD.SWEEP) return "a trip must end by sweeping ETH back to you";
      const [token, recipient] = dec("address, address, uint256", inputs[inputs.length - 1]);
      if (!same(token, ZERO) || !you(recipient)) return "a trip must end by sweeping ETH back to you";
    }
  } catch { return "the swap holds an input that does not decode"; }
  return null;
}

/** A GMX order is one multicall: the execution fee and the collateral go to GMX's order vault only, and what comes back comes to you. */
function checkGmxMulticall(data, { from, value }) {
  let calls; try { calls = decodeFunctionData({ abi: GMX_ABI, data }).args[0]; } catch { return "the GMX multicall does not decode"; }
  let orders = 0, fee = 0n, collateral = 0n;
  for (const inner of calls) {
    let d; try { d = decodeFunctionData({ abi: GMX_ABI, data: inner }); } catch { return "the GMX multicall holds a call that is not on the list"; }
    if (d.functionName === "sendWnt") {
      if (!same(d.args[0], ADDR.gmxOrderVault)) return "the execution fee goes somewhere other than GMX's order vault";
      fee += d.args[1];
    } else if (d.functionName === "sendTokens") {
      if (!same(d.args[0], ADDR.arbitrumUsdc) || !same(d.args[1], ADDR.gmxOrderVault)) return "the collateral is not USDC to GMX's order vault";
      collateral += d.args[2];
      if (collateral > MAX_GMX_USDC) return `the total collateral ${collateral} units is above the cap ${MAX_GMX_USDC}`;
    } else if (d.functionName === "createOrder") {
      orders += 1;
      const a = d.args[0].addresses;
      if (!same(a.receiver, from)) return "the order pays out to an address that is not yours";
      if (!same(a.cancellationReceiver, ZERO) && !same(a.cancellationReceiver, from)) return "the order's cancellation refund goes to an address that is not yours";
      if (!same(a.callbackContract, ZERO) || !same(a.uiFeeReceiver, ZERO)) return "the order names a callback or a fee receiver";
      if (!same(a.initialCollateralToken, ADDR.arbitrumUsdc) || a.swapPath.length !== 0) return "the order's collateral is not plain USDC";
    } else return "the GMX multicall holds a call that is not on the list";
  }
  // Every wei the step carries must go to the order vault as the fee: ETH left in GMX's router can be swept by anyone.
  if (fee !== value) return "the execution fee inside the order is not exactly the ETH the step carries";
  return orders === 1 ? null : "the GMX multicall must hold exactly one order";
}

// ---- the key: read on this machine only, never printed ---------------------------------------------------------------
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const CURVE_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const validKey = (k) => KEY_RE.test(k) && BigInt(k) > 0n && BigInt(k) < CURVE_N;

/** Read a key file. Refused unless it is a plain file that only its owner can read. The key never leaves this function's caller. */
export function loadAccount(keyFile) {
  let st; try { st = fs.lstatSync(keyFile); } catch { throw new ArgError(`no key file at ${keyFile}: run \`node bot.mjs wallet\` to make one, or pass --key-file`); }
  if (!st.isFile()) throw new ArgError(`${keyFile} is not a plain file`);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new ArgError(`${keyFile} can be read by other users of this machine: run chmod 600 on it first`);
  const key = fs.readFileSync(keyFile, "utf8").trim();
  if (!validKey(key)) throw new ArgError(`${keyFile} does not hold one private key (0x and 64 hex characters)`);
  return privateKeyToAccount(key);
}
/** Make the bot's own wallet. Never overwrites a key file. Returns the address only. */
export function makeWallet(keyFile) {
  if (fs.existsSync(keyFile)) return { address: loadAccount(keyFile).address, made: false };
  fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  let key; do { key = `0x${randomBytes(32).toString("hex")}`; } while (!validKey(key));
  fs.writeFileSync(keyFile, `${key}\n`, { mode: 0o600, flag: "wx" });
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
export function makeChainIo(account, rpcs) {
  const made = {};
  const of = (chain) => (made[chain] ??= {
    pub: createPublicClient({ chain: CHAINS[chain].viem, transport: http(rpcs[chain]) }),
    wallet: account ? createWalletClient({ account, chain: CHAINS[chain].viem, transport: http(rpcs[chain]) }) : null,
  });
  return {
    async send(chain, tx) {
      const c = of(chain);
      if ((await c.pub.getChainId()) !== CHAINS[chain].id) throw new GuardError(`your ${chain} node is on another chain`);
      return c.wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
    },
    async wait(chain, hash) {
      const r = await of(chain).pub.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      return r.status === "success";
    },
    /** true landed, false reverted, null not seen yet. */
    async seen(chain, hash) {
      try { const r = await of(chain).pub.getTransactionReceipt({ hash }); return r.status === "success"; } catch { return null; }
    },
  };
}

// ---- the home folder: state, the ledger of everything sent, the stop file -------------------------------------------
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
export function openHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const files = { state: path.join(home, "state.json"), ledger: path.join(home, "ledger.jsonl"), stop: path.join(home, "STOP"), lock: path.join(home, "lock") };
  return {
    files,
    stopped: () => fs.existsSync(files.stop),
    state: () => readJson(files.state, {}),
    save(state) { const tmp = `${files.state}.tmp`; fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 }); fs.renameSync(tmp, files.state); },
    record(row) { fs.appendFileSync(files.ledger, `${JSON.stringify(row)}\n`, { mode: 0o600 }); },
    /** Fees (upper bound) and ETH sent in the last 24 hours, from the ledger. */
    day(now) {
      let feeWei = 0n, spendWei = 0n;
      let text = ""; try { text = fs.readFileSync(files.ledger, "utf8"); } catch { text = ""; }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (!(now - Date.parse(r.at) < DAY_MS)) continue;
        feeWei += big(r.feeBoundWei) ?? 0n; spendWei += big(r.valueWei) ?? 0n;
      }
      return { feeWei, spendWei };
    },
    /** One bot per home folder. A lock is another bot's while its process is alive. */
    lock() {
      const held = readJson(files.lock, null);
      if (held && held.pid !== process.pid) { try { process.kill(held.pid, 0); return false; } catch { /* that process is gone */ } }
      fs.writeFileSync(files.lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 });
      return true;
    },
    unlock() { const held = readJson(files.lock, null); if (held?.pid === process.pid) fs.rmSync(files.lock, { force: true }); },
  };
}

// ---- one step: check it, count it against the day, then (only with --live) sign, send and wait ---------------------
/** Returns "dry" | "sent" | "reverted" | "budget". STOP and pending transactions return "budget" without sending. Throws GuardError for a refused rule. */
export async function step(ctx, leg, name, tx, { sizeWei = 0n } = {}) {
  const why = checkTx(leg, tx, { from: ctx.address, sizeWei, maxTxFeeWei: ctx.caps.maxTxFeeWei });
  if (why) throw new GuardError(`${leg}: refused ${name}: ${why}`);
  const chain = RULES[leg][0].chain;
  const value = BigInt(tx.value ?? 0);
  const l1 = big(tx.l1FeeBoundWei ?? 0) ?? 0n;
  const feeBound = BigInt(tx.gas) * BigInt(tx.maxFeePerGas) + (l1 > 0n ? l1 : 0n);
  const day = ctx.home.day(ctx.now());
  if (day.feeWei + feeBound > ctx.caps.dayFeeWei) { ctx.say(`${leg}: ${name} waits: the day's fee cap (${eth(ctx.caps.dayFeeWei)}) is reached`); return "budget"; }
  if (value > 0n && day.spendWei + value > ctx.caps.daySpendWei) { ctx.say(`${leg}: ${name} waits: the day's spend cap (${eth(ctx.caps.daySpendWei)}) is reached`); return "budget"; }
  if (!ctx.live) { ctx.say(`${leg}: DRY, would send ${name}${value > 0n ? ` with ${eth(value)}` : ""} (fee at most ${eth(feeBound)})`); return "dry"; }
  // These checks must happen for every send, not only at the start of a pass: a prior receipt may have timed out.
  if (ctx.home.stopped()) { ctx.say(`${leg}: ${name} waits: STOP is set, nothing sent`); return "budget"; }
  if (ctx.home.state().pending) { ctx.say(`${leg}: ${name} waits: a transaction is still pending, nothing sent`); return "budget"; }
  let hash;
  try { hash = await ctx.io.send(chain, tx); }
  catch (e) {
    // The node may have taken the transaction even though no answer came back, so do not guess: remember that a send may be out,
    // send nothing more, and let the next pass tell the owner to look at the wallet.
    const lost = ctx.home.state(); lost.pending = { chain, hash: null, leg, name, at: new Date(ctx.now()).toISOString() }; ctx.home.save(lost);
    throw e;
  }
  const state = ctx.home.state(); state.pending = { chain, hash, leg, name, at: new Date(ctx.now()).toISOString() }; ctx.home.save(state);
  ctx.home.record({ at: new Date(ctx.now()).toISOString(), leg, name, chain, to: tx.to, valueWei: value.toString(), feeBoundWei: feeBound.toString(), hash });
  const ok = await ctx.io.wait(chain, hash);
  const after = ctx.home.state(); delete after.pending; ctx.home.save(after);
  ctx.say(`${leg}: ${ok ? "sent" : "REVERTED"} ${name} ${hash}`);
  return ok ? "sent" : "reverted";
}

/** A kit answer, read the way the recipes say: 0 go on, 10 nothing now, 1 a read failed, 2/3/4 stop the leg. */
function settle(ctx, leg, what, r) {
  if (r.code === 0 && r.out) return "ok";
  if (r.code === 10) { ctx.say(`${leg}: ${what}: nothing to do now${r.out?.prepared?.reason || r.out?.reason ? ` (${clean(r.out?.prepared?.reason ?? r.out?.reason)})` : ""}`); return "nothing"; }
  if (r.code === 1 || r.code === 0) { ctx.fail(leg, `${what}: a read failed, nothing was decided${r.err ? ` (${r.err})` : ""}`); return "failed"; }
  ctx.halt(leg, `${what} stopped with exit ${r.code}${r.err ? ` (${r.err})` : ""}`);
  return "halted";
}
const kit = (ctx, args) => ctx.kit(ctx.kitFile, args, ctx.rpcs);
const due = (last, hours, now) => !(now - Date.parse(last ?? "") < hours * 3600_000);
const VOTE_RE = /^0x[0-9a-fA-F]{40}:\d{1,5}(,0x[0-9a-fA-F]{40}:\d{1,5}){0,9}$/;
/** A vote string is pools and basis points that sum to exactly 10000. */
export const validVote = (v) => typeof v === "string" && VOTE_RE.test(v) && v.split(",").reduce((n, p) => n + Number(p.split(":")[1]), 0) === 10000;

// ---- the legs ------------------------------------------------------------------------------------------------------
export const LEGS = {
  /** Claim, then vote by the plain kit rank (NOT any wallet's vote), once per epoch. */
  async hydrex(ctx) {
    const leg = "hydrex";
    const e = await kit(ctx, ["hydrex", "epoch"]);
    if (settle(ctx, leg, "epoch", e) !== "ok") return;
    const epoch = String(e.out.epochStart);
    if (ctx.home.state().hydrex?.votedEpoch === epoch) return ctx.say(`${leg}: already voted this epoch`);
    const locks = await kit(ctx, ["hydrex", "locks", "--address", ctx.address]);
    if (settle(ctx, leg, "locks", locks) !== "ok") return;
    if (!locks.out.nfts?.length) return ctx.say(`${leg}: this wallet holds no veHYDX lock, so there is nothing to claim or vote (the Hydrex guide says how a lock is made)`);
    const claim = await kit(ctx, ["hydrex", "prepare", "claim", "--from", ctx.address]);
    const claimed = settle(ctx, leg, "claim", claim);
    if (claimed === "failed" || claimed === "halted") return;
    if (claimed === "ok") for (const s of claim.out.prepared?.steps ?? []) {
      const got = await step(ctx, leg, `claim ${clean(s.kind, 8)} ${(s.tokens ?? []).map((t) => `${clean(t.earned, 24)} ${clean(t.symbol, 12)}`).join(", ")}`, s.tx);
      if (got === "budget") return;
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
    const got = await step(ctx, leg, `vote ${vote}`, v.out.prepared.tx);
    if (got === "sent") { const s = ctx.home.state(); s.hydrex = { votedEpoch: epoch, vote, at: new Date(ctx.now()).toISOString() }; ctx.home.save(s); }
  },

  /** Approve the exact amount, retire, take the approval back. */
  async klima(ctx) {
    const leg = "klima", o = ctx.opts;
    if (!o.klimaClass || !o.klimaCredit || !o.klimaTonnes) return ctx.say(`${leg}: off (set --klima-class, --klima-credit and --klima-tonnes to turn it on; \`klima classes\` and \`klima credits\` in the kit list them)`);
    if (!due(ctx.home.state().klima?.at, o.buyEveryHours, ctx.now())) return ctx.say(`${leg}: not due yet`);
    ctx.say(`${leg}: As of 2026-11-18 EcoWealth holds a stake in Klima and may gain if it rises`);
    const args = ["klima", "prepare", "retire", "--from", ctx.address, "--class", o.klimaClass, "--credit", o.klimaCredit, "--tonnes", o.klimaTonnes, "--beneficiary-name", o.klimaName, ...(o.klimaTokenId ? ["--token-id", o.klimaTokenId] : [])];
    for (let turn = 0; turn < 2; turn++) {
      const p = await kit(ctx, args);
      if (settle(ctx, leg, "retire", p) !== "ok") return;
      const kind = p.out.prepared.step;
      const got = await step(ctx, leg, kind === "approve" ? "the exact kVCM approval" : `retire ${o.klimaTonnes} tonnes`, p.out.prepared.tx);
      if (got === "dry" && kind === "approve") return ctx.say(`${leg}: DRY, then the retirement, then the approval is taken back`);
      if (got !== "sent") break;
      if (kind === "retire") { const s = ctx.home.state(); s.klima = { at: new Date(ctx.now()).toISOString() }; ctx.home.save(s); break; }
    }
    const r = await kit(ctx, ["klima", "prepare", "revoke", "--from", ctx.address]);
    if (r.code === 0 && r.out?.prepared?.tx) await step(ctx, leg, "take the kVCM approval back", r.out.prepared.tx);
  },

  /** ETH to axlREGEN, a slice you set. */
  async regen(ctx) { return buy(ctx, "regen", ctx.opts.regenWei, ["regen", "prepare", "buy-regen"], "axlREGEN"); },
  /** ETH to ECO, a slice you set. */
  async eco(ctx) { return buy(ctx, "eco", ctx.opts.ecoWei, ["uniswap", "prepare", "swap", "--pool", "eth-eco"], "ECO"); },

  /** The NET circle, only when the kit's floor passes. */
  async circle(ctx) {
    const leg = "circle", size = ctx.opts.circleWei;
    if (!(size > 0n)) return ctx.say(`${leg}: off (set --circle-eth to turn it on)`);
    const p = await ctx.kit(ctx.circleKitFile, ["prepare", "--from", ctx.address, "--size", formatEther(size)], ctx.rpcs);
    if (settle(ctx, leg, "prepare", p) !== "ok") return;
    const t = p.out.prepared;
    if (!(Number(t.deadline) * 1000 > ctx.now() + 3000)) return ctx.say(`${leg}: the prepared trip is past its deadline, skipped`);
    await step(ctx, leg, `one trip through NET's pools (${clean(t.loop, 40)})`, t.tx, { sizeWei: size });
  },

  /** One small position by your rule: open, hold, close, start again. */
  async gmx(ctx) {
    const leg = "gmx", o = ctx.opts;
    if (!o.gmxMarket || !o.gmxSide || !o.gmxCollateral || !o.gmxLeverage) return ctx.say(`${leg}: off (set --gmx-market, --gmx-side, --gmx-collateral and --gmx-leverage to turn it on)`);
    ctx.say(`${leg}: As of 2026-11-18 EcoWealth holds a stake in GMX and may gain if it rises`);
    const mine = ctx.home.state().gmx ?? {};
    const orders = await kit(ctx, ["gmx", "orders", "--address", ctx.address]);
    if (settle(ctx, leg, "orders", orders) !== "ok") return;
    if (orders.out.length) return ctx.say(`${leg}: an order is waiting for GMX's keeper`);
    const pos = await kit(ctx, ["gmx", "positions", "--address", ctx.address]);
    if (settle(ctx, leg, "positions", pos) !== "ok") return;
    if (mine.openedAt) {
      if (!pos.out.length) { const s = ctx.home.state(); s.gmx = { closedAt: new Date(ctx.now()).toISOString() }; ctx.home.save(s); return ctx.say(`${leg}: the position is gone (closed elsewhere, or liquidated)`); }
      if (!due(mine.openedAt, o.gmxHoldHours, ctx.now())) return ctx.say(`${leg}: holding`);
      const c = await kit(ctx, ["gmx", "prepare", "close", "--from", ctx.address, "--market", o.gmxMarket, "--side", o.gmxSide]);
      if (settle(ctx, leg, "close", c) !== "ok") return;
      const got = await step(ctx, leg, "close the position", c.out.prepared.tx);
      if (got === "sent") { const s = ctx.home.state(); s.gmx = { closedAt: new Date(ctx.now()).toISOString() }; ctx.home.save(s); }
      return;
    }
    if (pos.out.length) return ctx.say(`${leg}: this wallet already holds a GMX position this bot did not open, so it is left alone`);
    if (!due(mine.closedAt, o.buyEveryHours, ctx.now())) return ctx.say(`${leg}: not due yet`);
    const args = ["gmx", "prepare", "open", "--from", ctx.address, "--market", o.gmxMarket, "--side", o.gmxSide, "--collateral", o.gmxCollateral, "--leverage", o.gmxLeverage];
    for (let turn = 0; turn < 2; turn++) {
      const p = await kit(ctx, args);
      if (settle(ctx, leg, "open", p) !== "ok") return;
      const kind = p.out.prepared.step;
      const got = await step(ctx, leg, kind === "approve" ? "the exact USDC approval" : `open ${o.gmxSide} ${o.gmxMarket}, ${o.gmxCollateral} USDC at ${o.gmxLeverage}x`, p.out.prepared.tx);
      if (got === "dry" && kind === "approve") return ctx.say(`${leg}: DRY, then the order`);
      if (got !== "sent") return;
      if (kind === "order") { const s = ctx.home.state(); s.gmx = { openedAt: new Date(ctx.now()).toISOString() }; ctx.home.save(s); return; }
    }
  },
};

async function buy(ctx, leg, size, act, symbol) {
  if (!(size > 0n)) return ctx.say(`${leg}: off (set --${leg}-eth to turn it on)`);
  if (!due(ctx.home.state()[leg]?.at, ctx.opts.buyEveryHours, ctx.now())) return ctx.say(`${leg}: not due yet`);
  const p = await kit(ctx, [...act, "--from", ctx.address, "--size", formatEther(size)]);
  if (settle(ctx, leg, "buy", p) !== "ok") return;
  const t = p.out.prepared;
  if (t.disclosure) ctx.say(`${leg}: ${clean(t.disclosure)}`);
  if (leg === "eco") ctx.say("eco: As of 2026-11-18 EcoWealth both buys ECO and swaps ECO it holds for NET; the house can gain if ECO rises");
  if (leg === "regen") ctx.say("regen: As of 2026-11-18 EcoWealth holds REGEN and may gain if it rises");
  const got = await step(ctx, leg, `buy at least ${clean(t.minOut, 40)} ${symbol}`, t.tx, { sizeWei: size });
  if (got === "sent") { const s = ctx.home.state(); s[leg] = { at: new Date(ctx.now()).toISOString() }; ctx.home.save(s); }
}

// ---- one pass over the loop ------------------------------------------------------------------------------------------
/** Walk the legs in order once. Returns the exit code: 0 the pass ran, 4 a rule refused a step, 1 a leg was stopped. */
export async function pass(ctx) {
  if (ctx.home.stopped()) { ctx.say(`stopped by the STOP file at ${ctx.home.files.stop}`); return 0; }
  const pending = ctx.home.state().pending;
  if (pending && ctx.live) {
    if (!pending.hash) { ctx.say(`a send got no answer (${clean(pending.leg, 20)}: ${clean(pending.name, 80)} on ${clean(pending.chain, 10)}): it may or may not have gone out, so nothing is sent. Look at your wallet, then delete "pending" from ${ctx.home.files.state} to go on`); return 0; }
    const seen = await ctx.io.seen(pending.chain, pending.hash);
    if (seen === null) { ctx.say(`a transaction is still unconfirmed (${clean(pending.hash, 66)} on ${clean(pending.chain, 10)}): nothing is sent until it lands. If it was dropped, delete "pending" from ${ctx.home.files.state}`); return 0; }
    const s = ctx.home.state(); delete s.pending; ctx.home.save(s);
  }
  let code = 0;
  for (const leg of LEG_ORDER) {
    if (!ctx.opts.legs.includes(leg)) continue;
    if (ctx.halted[leg]) { ctx.say(`${leg}: stopped earlier (${ctx.halted[leg]})`); code = code || 1; continue; }
    try { await LEGS[leg](ctx); }
    catch (e) {
      if (e instanceof GuardError) { ctx.halt(leg, e.message); code = 4; }
      else ctx.fail(leg, `stopped this pass: ${clean(e?.shortMessage || e?.message || e)}`);
    }
    if (ctx.halted[leg]) code = code || 1;
  }
  return code;
}

/** Everything a pass needs. `kit` and `io` can be swapped by a test; nothing else reaches the network or the key. */
export function makeContext({ opts, home, address, io, kit = runKit, say = (line) => console.log(line), now = () => Date.now() }) {
  const ctx = {
    opts, home, address, io, kit, say, now, live: Boolean(opts.live), kitFile: opts.kit, circleKitFile: opts.circleKit, rpcs: opts.rpcs,
    caps: { maxTxFeeWei: opts.maxTxFeeWei, dayFeeWei: opts.dayFeeWei, daySpendWei: opts.daySpendWei },
    halted: {}, fails: {},
    /** A read failed: three in a row stops the leg until the bot is started again. */
    fail(leg, why) { ctx.fails[leg] = (ctx.fails[leg] ?? 0) + 1; say(`${leg}: ${why}`); if (ctx.fails[leg] >= 3) ctx.halt(leg, "three failures in a row"); },
    halt(leg, why) { ctx.halted[leg] = clean(why); say(`${leg}: STOPPED: ${clean(why)}. Fix it and start the bot again.`); },
  };
  return ctx;
}

// ---- the command line ------------------------------------------------------------------------------------------------
const FLAGS = new Set(["live", "home", "key-file", "address", "every", "legs", "buy-every-hours", "hydrex-top", "hydrex-vote", "klima-class", "klima-credit", "klima-tonnes", "klima-token-id", "klima-name", "regen-eth", "eco-eth", "circle-eth", "gmx-market", "gmx-side", "gmx-collateral", "gmx-leverage", "gmx-hold-hours", "day-fee-eth", "day-spend-eth", "max-tx-fee-eth", "kit", "circle-kit", "base-rpc", "arbitrum-rpc"]);
const BOOL = new Set(["live"]);
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
  if (!["run", "once", "wallet", "list", "help", undefined].includes(cmd)) throw new ArgError(`no command named ${clean(cmd, 20)}: use run, once, wallet or list`);
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
  if (f["gmx-market"] !== undefined && !/^[A-Za-z0-9.]{1,12}$/.test(f["gmx-market"])) throw new ArgError("--gmx-market is a market symbol, like ETH");
  for (const n of ["gmx-collateral", "gmx-leverage", "klima-tonnes"]) if (f[n] !== undefined && !/^\d+(\.\d+)?$/.test(f[n])) throw new ArgError(`--${n} is a number`);
  if (f["klima-token-id"] !== undefined && !/^\d{1,78}$/.test(f["klima-token-id"])) throw new ArgError("--klima-token-id is a whole number");
  const name = f["klima-name"] ?? "my bot";
  if (!/^[\x20-\x7E]{1,64}$/.test(name) || name.startsWith("-")) throw new ArgError("--klima-name is 1 to 64 plain characters and is public for good");
  return {
    cmd: cmd ?? "help", live: Boolean(f.live), home, keyFile: path.resolve(f["key-file"] ?? path.join(home, "wallet.key")), address: addrFlag("address", f.address), legs,
    everyMinutes: whole("every", f.every, DEFAULTS.everyMinutes, 1, 10_080), buyEveryHours: whole("buy-every-hours", f["buy-every-hours"], DEFAULTS.buyEveryHours, 1, 8_760),
    hydrexTop: whole("hydrex-top", f["hydrex-top"], DEFAULTS.hydrexTop, 1, 10), hydrexVote: f["hydrex-vote"],
    klimaClass: addrFlag("klima-class", f["klima-class"]), klimaCredit: addrFlag("klima-credit", f["klima-credit"]), klimaTonnes: f["klima-tonnes"], klimaTokenId: f["klima-token-id"], klimaName: name,
    regenWei: ethFlag("regen-eth", f["regen-eth"], MAX_LEG_ETH_WEI), ecoWei: ethFlag("eco-eth", f["eco-eth"], MAX_LEG_ETH_WEI), circleWei: ethFlag("circle-eth", f["circle-eth"], MAX_LEG_ETH_WEI),
    gmxMarket: f["gmx-market"], gmxSide: f["gmx-side"], gmxCollateral: f["gmx-collateral"], gmxLeverage: f["gmx-leverage"], gmxHoldHours: whole("gmx-hold-hours", f["gmx-hold-hours"], DEFAULTS.gmxHoldHours, 1, 8_760),
    dayFeeWei: ethFlag("day-fee-eth", f["day-fee-eth"] ?? DEFAULTS.dayFeeEth, HARD_MAX.dayFeeWei), daySpendWei: ethFlag("day-spend-eth", f["day-spend-eth"] ?? DEFAULTS.daySpendEth, HARD_MAX.daySpendWei),
    maxTxFeeWei: ethFlag("max-tx-fee-eth", f["max-tx-fee-eth"] ?? DEFAULTS.maxTxFeeEth, HARD_MAX.maxTxFeeWei),
    kit: path.resolve(f.kit ?? DEFAULT_KIT), circleKit: path.resolve(f["circle-kit"] ?? DEFAULT_CIRCLE_KIT),
    rpcs: { base: f["base-rpc"] ?? env.BASE_RPC_URL ?? CHAINS.base.rpc, arbitrum: f["arbitrum-rpc"] ?? env.ARBITRUM_RPC_URL ?? CHAINS.arbitrum.rpc },
  };
}

export const HELP = `vealth protocol bot ${VERSION}: one loop over Hydrex, Klima, Regen, ECO (the Zora coin), NET's circle and GMX, with your own key.
Never an offer or advice, no return promised. DRY unless you pass --live.

  node bot.mjs once --address 0xYOU        a dry pass for any address: no key, nothing signed, nothing sent
  node bot.mjs wallet                      make the bot's wallet in <home>/wallet.key (never overwrites one)
  node bot.mjs once --live ...             one pass that sends (for cron or launchd)
  node bot.mjs run --live ...              the loop, forever, one pass every --every minutes (default ${DEFAULTS.everyMinutes})
  node bot.mjs list                        every contract call this program can sign, and nothing else

Legs (--legs hydrex,klima,regen,eco,circle,gmx; default all, each one off until it has what it needs):
  hydrex   needs a veHYDX lock in the wallet. [--hydrex-top ${DEFAULTS.hydrexTop}] [--hydrex-vote 0xPOOL:10000 to use your own vote]
  klima    --klima-class 0x.. --klima-credit 0x.. --klima-tonnes 0.01 [--klima-token-id n] [--klima-name "my bot"]
  regen    --regen-eth 0.0002        eco   --eco-eth 0.0002        circle   --circle-eth 0.0001
  gmx      --gmx-market ETH --gmx-side long --gmx-collateral 5 --gmx-leverage 2 [--gmx-hold-hours ${DEFAULTS.gmxHoldHours}]
Pace and caps:
  --buy-every-hours ${DEFAULTS.buyEveryHours}   --day-fee-eth ${DEFAULTS.dayFeeEth}   --day-spend-eth ${DEFAULTS.daySpendEth}   --max-tx-fee-eth ${DEFAULTS.maxTxFeeEth}
Where things are:
  --home ~/.vealth-bot   --key-file <home>/wallet.key   --base-rpc / --arbitrum-rpc (or BASE_RPC_URL / ARBITRUM_RPC_URL)
Stop it: touch <home>/STOP. Everything it sent is in <home>/ledger.jsonl.
Exit codes: 0 the pass ran | 2 bad arguments | 4 a rule refused a step (nothing was sent) | 1 a leg was stopped`;

export function listText() {
  const lines = ["Every contract call this program can sign. A step that is not here is refused.", ""];
  for (const leg of LEG_ORDER) for (const r of RULES[leg]) {
    const value = r.value === "zero" ? "no ETH" : r.value === "size" ? "at most the size you set" : `at most ${eth(MAX_GMX_EXECUTION_FEE_WEI)} as GMX's execution fee`;
    lines.push(`${leg.padEnd(7)} ${r.chain.padEnd(9)} ${r.to}  ${r.fn}  (${value}${r.spender ? `; spender ${r.spender} only, at most ${r.maxAmount} units` : ""})`);
  }
  return lines.join("\n");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { if (e instanceof ArgError) { console.error(`bot: ${e.message}`); return 2; } throw e; }
  if (opts.cmd === "help") { console.log(HELP); return 0; }
  if (opts.cmd === "list") { console.log(listText()); return 0; }
  try {
    if (opts.cmd === "wallet") {
      const w = makeWallet(opts.keyFile);
      console.log(`${w.made ? "made a new wallet" : "the wallet is"} ${w.address}\nits key is in ${opts.keyFile}, readable by you alone. Keep in it only what you can lose.`);
      return 0;
    }
    const account = opts.live ? loadAccount(opts.keyFile) : null;
    const address = account?.address ?? opts.address ?? (fs.existsSync(opts.keyFile) ? loadAccount(opts.keyFile).address : null);
    if (!address) throw new ArgError("a dry pass needs --address 0xYOU (or a wallet: run `node bot.mjs wallet`)");
    if (opts.live && opts.address && !same(opts.address, address)) throw new ArgError("--address is not the address of the key file");
    const home = openHome(opts.home);
    if (!home.lock()) throw new ArgError(`another bot is already running from ${opts.home}`);
    const ctx = makeContext({ opts, home, address, io: makeChainIo(account, opts.rpcs) });
    console.log(`bot ${VERSION} for ${address}: ${opts.live ? "LIVE, it sends" : "DRY, nothing is sent"}`);
    try {
      if (opts.cmd === "once") return await pass(ctx);
      for (;;) {
        await pass(ctx);
        const until = Date.now() + opts.everyMinutes * 60_000;
        while (Date.now() < until) await sleep(Math.min(60_000, until - Date.now()));
      }
    } finally { home.unlock(); }
  } catch (e) {
    if (e instanceof ArgError) { console.error(`bot: ${e.message}`); return 2; }
    console.error(`bot: ${clean(e?.shortMessage || e?.message || e)}`);
    return 1;
  }
}

let direct = false;
try { direct = Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { direct = false; }
if (direct) main(process.argv.slice(2)).then((c) => process.exit(c));
