#!/usr/bin/env node
// net-circle: every ETH loop through NET on Base, quoted in batches and taken as ONE transaction that refuses to pay
// back less than it took plus gas. Holds no key, signs nothing, sends nothing: you sign what it prepares.
//
//   node net-circle.mjs                    quote every loop: its gap, best size and profit after gas
//   node net-circle.mjs prepare --from 0xYOU [--loop mft] [--size 0.0001] [--min-profit-wei N] [--json]
//   node net-circle.mjs watch --from 0xYOU [--every 30]   one JSON line on stdout per trade worth sending
//   node net-circle.mjs selftest --from 0xYOU             prove every loop's path executes today (simulation)
//   node net-circle.mjs loops                              list the loops
//   --rpc https://... or BASE_RPC_URL (default https://mainnet.base.org)
//
// Exit codes: 0 ok (prepare: a sendable tx was printed) · 2 bad arguments · 3 wrong chain · 10 prepare: nothing worth
// sending right now · 1 any other failure (a read failed: nothing was decided).

import {
  createPublicClient, http, parseAbi, parseAbiParameters, encodeAbiParameters, encodeFunctionData, encodePacked,
  formatEther, parseEther, decodeErrorResult, getAddress, toHex, isAddress, keccak256,
} from "viem";
import { base } from "viem/chains";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

// ---- tokens and contracts (Base, chain 8453) ---------------------------------------------------------------------
export const CHAIN_ID = 8453;
export const ETH = "0x0000000000000000000000000000000000000000"; // native ETH as a V4 currency and as the SWEEP token
export const TOKENS = {
  ETH,
  WETH: "0x4200000000000000000000000000000000000006",
  NET: "0xE37A9125B6b14D5e8Ec056C744a99F4deC975022",
  ECO: "0x170dC0ca26F1247CED627D8aBcaFA90ecf1e1519",
  ZORA: "0x1111111111166b7FE7bd91427724B487980aFc69",
  MFT: "0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3",
  AXLREGEN: "0x2E6C05f1f7D1f4Eb9A088bf12257f1647682b754",
  VVV: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
};
// The Universal Router at this address predates v4-periphery's per-hop minimum (minHopPriceX36): its ExactInputParams
// has four fields. Do not point this program at a newer router without changing the encoding.
export const CONTRACTS = {
  UNIVERSAL_ROUTER: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  V4_QUOTER: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
  V3_QUOTER: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  V4_STATE_VIEW: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
  V4_POSITION_MANAGER: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
  GAS_PRICE_ORACLE: "0x420000000000000000000000000000000000000F",
};
export const DEAD = "0x000000000000000000000000000000000000dEaD";
const NO_HOOK = ETH;

// ---- pools ------------------------------------------------------------------------------------------------------
// V4 pools carry their PoolKey (currency0 < currency1). "coin" is read live from ECO.getPoolKey() on every run.
// `burnedPosition` is the pool's founding liquidity position (a V4 PositionManager NFT) sent to 0x...dEaD; the `pools`
// command reads its owner and its share of the pool's liquidity from chain, so nobody has to take this line on trust.
export const POOLS = {
  netWeth: { v: 4, name: "NET/WETH V4 0.01%", burnedPosition: 2868574n, key: { currency0: TOKENS.WETH, currency1: TOKENS.NET, fee: 100, tickSpacing: 1, hooks: NO_HOOK } },
  netEth: { v: 4, name: "NET/ETH V4 0.01% (native ETH)", burnedPosition: 3184094n, key: { currency0: ETH, currency1: TOKENS.NET, fee: 100, tickSpacing: 1, hooks: NO_HOOK } },
  netEco: { v: 4, name: "NET/ECO V4 0.01%", burnedPosition: 2865929n, key: { currency0: TOKENS.ECO, currency1: TOKENS.NET, fee: 100, tickSpacing: 1, hooks: NO_HOOK } },
  coin: { v: 4, name: "ECO/ZORA Zora coin pool (Zora hook)", key: null },
  zoraWeth: { v: 3, name: "ZORA/WETH V3 0.3%", fee: 3000 },
  ecoMft: { v: 3, name: "ECO/MfT V3 1%", fee: 10000 },
  mftWeth: { v: 4, name: "WETH/MfT V4 (hook, dynamic fee)", key: { currency0: TOKENS.WETH, currency1: TOKENS.MFT, fee: 8388608, tickSpacing: 200, hooks: "0xbB7784A4d481184283Ed89619A3e3ed143e1Adc0" } },
  ecoAxl: { v: 4, name: "ECO/axlREGEN V4 1%", key: { currency0: TOKENS.ECO, currency1: TOKENS.AXLREGEN, fee: 10000, tickSpacing: 200, hooks: NO_HOOK } },
  axlEth: { v: 4, name: "ETH/axlREGEN V4 1%", key: { currency0: ETH, currency1: TOKENS.AXLREGEN, fee: 10000, tickSpacing: 200, hooks: NO_HOOK } },
  ecoEth: { v: 4, name: "ETH/ECO V4 1%", key: { currency0: ETH, currency1: TOKENS.ECO, fee: 10000, tickSpacing: 200, hooks: NO_HOOK } },
  netVvv: { v: 4, name: "VVV/NET V4 0.01%", burnedPosition: 3208643n, key: { currency0: TOKENS.VVV, currency1: TOKENS.NET, fee: 100, tickSpacing: 1, hooks: NO_HOOK } },
  vvvWeth: { v: 3, name: "VVV/WETH V3 1%", fee: 10000 },
};

// ---- loops: each starts and ends in ETH (WETH or native) and crosses the NET/WETH pool ----------------------------
const BASE_LOOPS = [
  { id: "zora", via: "ZORA (Zora coin pool)", tokens: ["WETH", "NET", "ECO", "ZORA", "WETH"], pools: ["netWeth", "netEco", "coin", "zoraWeth"] },
  { id: "mft", via: "MfT", tokens: ["WETH", "NET", "ECO", "MFT", "WETH"], pools: ["netWeth", "netEco", "ecoMft", "mftWeth"] },
  { id: "axlregen", via: "axlREGEN", tokens: ["WETH", "NET", "ECO", "AXLREGEN", "ETH"], pools: ["netWeth", "netEco", "ecoAxl", "axlEth"] },
  { id: "eth", via: "ECO/ETH direct", tokens: ["WETH", "NET", "ECO", "ETH"], pools: ["netWeth", "netEco", "ecoEth"] },
  { id: "net-pools", via: "the two NET/ETH pools", tokens: ["WETH", "NET", "ETH"], pools: ["netWeth", "netEth"] },
  { id: "vvv", via: "VVV", tokens: ["WETH", "NET", "VVV", "WETH"], pools: ["netWeth", "netVvv", "vvvWeth"] },
];
/** Both directions of every loop: ":buy-net" pays ETH into the NET/WETH pool first; ":sell-net" takes ETH out of it last. */
export const LOOPS = BASE_LOOPS.flatMap((l) => [
  { ...l, id: `${l.id}:buy-net` },
  { ...l, id: `${l.id}:sell-net`, tokens: [...l.tokens].reverse(), pools: [...l.pools].reverse() },
]);
/** A loop id ("mft:buy-net") or a loop family ("mft"), or every loop when none is named. */
export const loopsMatching = (name) => (name ? LOOPS.filter((l) => l.id === name || l.id.startsWith(`${name}:`)) : LOOPS);

// ---- router constants (universal-router Commands.sol; v4-periphery Actions.sol, ActionConstants.sol) -------------
export const CMD = { V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 };
export const ACT = { SWAP_EXACT_IN: 0x07, SETTLE: 0x0b, TAKE: 0x0e };
export const OPEN_DELTA = 0n;
export const CONTRACT_BALANCE = 1n << 255n;
export const MSG_SENDER = "0x0000000000000000000000000000000000000001";
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
/** Router gas around the quoted swaps (wrap, refund, settle, take, payout); measured 154k to 161k on 2026-11-08. */
export const ROUTER_OVERHEAD_GAS = 160_000n;
export const MAX_SIZE_WEI = parseEther("1");
export const MAX_DEADLINE_SECONDS = 600;
/** The size search runs from MIN_SIZE_WEI to MAX_SEARCH_WEI; "no size pays" means none in that range. */
export const MIN_SIZE_WEI = parseEther("0.000002");
export const MAX_SEARCH_WEI = parseEther("0.01");
/** Gas limit = estimate x 1.5: crossing more ticks between prepare and inclusion costs more gas in these thin pools. */
export const GAS_LIMIT_NUM = 3n, GAS_LIMIT_DEN = 2n;
/** Refuse an RPC's fee or gas figure above these: a lying or broken node must not price your transaction. */
export const MAX_FEE_PER_GAS_WEI = 10_000_000_000n; // 10 gwei, over 1000x Base's usual fee
export const MAX_GAS = 6_000_000n;
export const MAX_WATCH_SECONDS = 3600;

const ABI = {
  coin: parseAbi(["function getPoolKey() view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)"]),
  v4q: parseAbi(["function quoteExactInput((address exactCurrency, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 exactAmount) params) returns (uint256 amountOut, uint256 gasEstimate)"]),
  v3q: parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"]),
  router: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]),
  oracle: parseAbi(["function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)"]),
  stateView: parseAbi([
    "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
    "function getLiquidity(bytes32 poolId) view returns (uint128)",
  ]),
  positions: parseAbi(["function ownerOf(uint256 tokenId) view returns (address)", "function getPositionLiquidity(uint256 tokenId) view returns (uint128)"]),
  errors: parseAbi([
    "error InsufficientETH()", "error InsufficientToken()", "error V3TooLittleReceived()", "error TransactionDeadlinePassed()",
    "error ExecutionFailed(uint256 commandIndex, bytes message)", "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  ]),
};

const addr = (sym) => TOKENS[sym];
const isEthLike = (sym) => sym === "ETH" || sym === "WETH";
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);

// ---- segments: consecutive pools of one venue version become one router command ----------------------------------
export function segmentsOf(loop, pools) {
  const segs = [];
  for (let i = 0; i < loop.pools.length; i++) {
    const pool = pools[loop.pools[i]];
    if (!pool) throw new Error(`unknown pool ${loop.pools[i]}`);
    const from = loop.tokens[i], to = loop.tokens[i + 1];
    const last = segs[segs.length - 1];
    if (pool.v === 4) {
      if (!pool.key) throw new Error(`pool ${loop.pools[i]} has no key (read it first)`);
      if (last && last.v === 4) last.hops.push({ to, key: pool.key });
      else segs.push({ v: 4, tokenIn: from, hops: [{ to, key: pool.key }] });
    } else {
      if (from === "ETH" || to === "ETH") throw new Error(`V3 pool ${loop.pools[i]} cannot take native ETH`);
      if (last && last.v === 3) { last.tokens.push(to); last.fees.push(pool.fee); }
      else segs.push({ v: 3, tokenIn: from, tokens: [from, to], fees: [pool.fee] });
    }
  }
  return segs;
}

const pathKey = (h) => ({ intermediateCurrency: addr(h.to), fee: h.key.fee, tickSpacing: h.key.tickSpacing, hooks: h.key.hooks, hookData: "0x" });
const v3Packed = (seg) => encodePacked(
  seg.tokens.flatMap((t, i) => (i < seg.fees.length ? ["address", "uint24"] : ["address"])),
  seg.tokens.flatMap((t, i) => (i < seg.fees.length ? [addr(t), seg.fees[i]] : [addr(t)])),
);
const segOut = (seg) => (seg.v === 4 ? seg.hops[seg.hops.length - 1].to : seg.tokens[seg.tokens.length - 1]);

/**
 * The whole loop as one Universal Router call, with exactly amountInWei traded and the payout floor enforced last.
 *  - starts in WETH: WRAP_ETH(amountIn), then SWEEP any extra msg.value straight back to the sender;
 *  - starts in native ETH: the first V4 segment settles exactly amountIn; extra msg.value is swept back at the end;
 *  - each segment trades the router's whole balance of its input (CONTRACT_BALANCE), so nothing is left behind;
 *  - ends in WETH: UNWRAP_WETH(minEthOut) pays the sender or reverts; ends in native ETH: SWEEP(ETH, minEthOut).
 * The floor must exceed the input: a floor at or below it would let the trade lose. `probe: true` allows a 1 wei floor
 * for an internal path simulation only; such a transaction is never printed.
 */
export function buildLoopTx({ loop, pools, amountInWei, minEthOutWei, deadline, probe = false }) {
  if (!(amountInWei > 0n) || amountInWei > MAX_SIZE_WEI) throw new Error("amountInWei must be positive and at most 1 ETH");
  if (!probe && !(minEthOutWei > amountInWei)) throw new Error("minEthOutWei must exceed amountInWei: the floor is what makes a loss impossible");
  if (probe && !(minEthOutWei > 0n)) throw new Error("a probe still needs a positive floor");
  const first = loop.tokens[0], end = loop.tokens[loop.tokens.length - 1];
  if (!isEthLike(first) || !isEthLike(end)) throw new Error(`loop ${loop.id} must start and end in ETH or WETH`);
  if (first === "ETH" && end === "ETH") throw new Error(`loop ${loop.id} starts and ends in native ETH: its refund would count toward the floor`);
  const segs = segmentsOf(loop, pools);
  if (first === "ETH" && segs[0].v !== 4) throw new Error(`loop ${loop.id} starts in native ETH but its first leg is not V4`);

  const steps = [];
  if (first === "WETH") {
    steps.push([CMD.WRAP_ETH, enc("address, uint256", [ADDRESS_THIS, amountInWei])]);
    steps.push([CMD.SWEEP, enc("address, address, uint256", [ETH, MSG_SENDER, 0n])]); // refund any extra msg.value now
  }
  segs.forEach((seg, k) => {
    const amount = k === 0 ? amountInWei : CONTRACT_BALANCE;
    if (seg.v === 4) {
      const settle = enc("address, uint256, bool", [addr(seg.tokenIn), amount, false]);
      const swap = enc("(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", [[addr(seg.tokenIn), seg.hops.map((h) => { const p = pathKey(h); return [p.intermediateCurrency, p.fee, p.tickSpacing, p.hooks, p.hookData]; }), OPEN_DELTA, 0n]]);
      const take = enc("address, address, uint256", [addr(segOut(seg)), ADDRESS_THIS, OPEN_DELTA]);
      steps.push([CMD.V4_SWAP, enc("bytes, bytes[]", [encodePacked(["uint8", "uint8", "uint8"], [ACT.SETTLE, ACT.SWAP_EXACT_IN, ACT.TAKE]), [settle, swap, take]])]);
    } else {
      steps.push([CMD.V3_SWAP_EXACT_IN, enc("address, uint256, uint256, bytes, bool", [ADDRESS_THIS, amount, 0n, v3Packed(seg), false])]);
    }
  });
  if (end === "WETH") {
    steps.push([CMD.UNWRAP_WETH, enc("address, uint256", [MSG_SENDER, minEthOutWei])]);
    steps.push([CMD.SWEEP, enc("address, address, uint256", [ETH, MSG_SENDER, 0n])]); // refund extra msg.value of a native start
  } else {
    steps.push([CMD.SWEEP, enc("address, address, uint256", [ETH, MSG_SENDER, minEthOutWei])]);
  }
  const commands = encodePacked(steps.map(() => "uint8"), steps.map(([c]) => c));
  const data = encodeFunctionData({ abi: ABI.router, functionName: "execute", args: [commands, steps.map(([, i]) => i), deadline] });
  return { to: CONTRACTS.UNIVERSAL_ROUTER, data, value: amountInWei, chainId: CHAIN_ID };
}

// ---- reads -------------------------------------------------------------------------------------------------------
export function makeClient(rpcUrl) {
  return createPublicClient({ chain: base, transport: http(rpcUrl || process.env.BASE_RPC_URL || "https://mainnet.base.org", { retryCount: 2 }) });
}

/** Text from an RPC or a revert, made safe to print into output an agent reads: printable ASCII, one line, capped. */
export function clean(text) {
  return String(text ?? "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Read the live coin pool key and refuse a pairing this program does not expect. */
export async function readPools(client) {
  const [currency0, currency1, fee, tickSpacing, hooks] = await client.readContract({ address: TOKENS.ECO, abi: ABI.coin, functionName: "getPoolKey" });
  const pair = [currency0, currency1].map((a) => a.toLowerCase()).sort().join();
  if (pair !== [TOKENS.ECO, TOKENS.ZORA].map((a) => a.toLowerCase()).sort().join()) throw new Error(`ECO's coin pool is no longer ECO/ZORA (${clean(currency0)}/${clean(currency1)}); refusing to route through it`);
  return { ...POOLS, coin: { ...POOLS.coin, key: { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks } } };
}

// Error names viem gives a failed request rather than a failed contract call (checked against viem 2.53 and 2.57).
const NODE_ERRORS = ["CallExecutionError", "HttpRequestError", "RpcRequestError", "TimeoutError", "WebSocketRequestError", "LimitExceededRpcError", "InternalRpcError", "InvalidParamsRpcError", "MethodNotFoundRpcError", "MethodNotSupportedRpcError", "UnknownRpcError"];
const inChain = (err, names) => { for (let x = err; x; x = x.cause) if (names.includes(x.name)) return true; return false; };

/**
 * True only for one multicall sub-call that reverted (viem wraps its return data in RawContractError). A whole batch
 * that failed (node error, rate limit, gas cap, timeout) is never a revert, whatever message the node attached.
 */
export function isRevert(err) {
  if (inChain(err, NODE_ERRORS)) return false;
  return inChain(err, ["RawContractError"]);
}

/** Quotes per multicall: a hooked pool's quote can cost over 1M gas, so those batches stay small (node eth_call gas caps). */
const chunkSizeFor = (seg) => (seg.v === 4 && seg.hops.some((h) => h.key.hooks.toLowerCase() !== NO_HOOK) ? 6 : 16);

/**
 * Quote many sizes of one loop: each segment's quotes go out in a few multicalls (one aggregate3 per chunk), so a loop
 * costs about one round trip per segment. A quote that REVERTS is a size that cannot fill (out: null). Any other
 * failure (a node error, a rate limit, a timeout) throws: it is never mistaken for an empty pool.
 */
export async function quoteLoop(client, loop, pools, sizes) {
  let amounts = [...sizes];
  const gas = sizes.map(() => 0n);
  for (const seg of segmentsOf(loop, pools)) {
    const live = amounts.map((a, i) => [a, i]).filter(([a]) => a !== null && a > 0n);
    if (!live.length) break;
    const call = ([a]) => (seg.v === 4
      ? { address: CONTRACTS.V4_QUOTER, abi: ABI.v4q, functionName: "quoteExactInput", args: [{ exactCurrency: addr(seg.tokenIn), path: seg.hops.map(pathKey), exactAmount: a }] }
      : { address: CONTRACTS.V3_QUOTER, abi: ABI.v3q, functionName: "quoteExactInput", args: [v3Packed(seg), a] });
    const size = chunkSizeFor(seg);
    const res = [];
    for (let c = 0; c < live.length; c += size) {
      const part = await client.multicall({ contracts: live.slice(c, c + size).map(call), allowFailure: true, batchSize: 1_000_000 });
      res.push(...part);
    }
    const next = amounts.map(() => null);
    res.forEach((r, j) => {
      const i = live[j][1];
      if (r.status !== "success") {
        if (!isRevert(r.error)) throw new Error(`quote read failed (not a revert): ${clean(r.error?.shortMessage || r.error?.message || r.error)}`);
        return;
      }
      next[i] = r.result[0];
      gas[i] += seg.v === 4 ? r.result[1] : r.result[3];
    });
    amounts = next;
  }
  return sizes.map((amountIn, i) => ({ amountIn, out: amounts[i], gas: gas[i] }));
}

/** Sizes on a geometric grid (floats are fine: a size need not be exact to the wei). */
const grid = (lo, hi, n) => { const r = Math.pow(hi / lo, 1 / (n - 1)); return Array.from({ length: n }, (_, k) => BigInt(Math.round(lo * Math.pow(r, k)))); };

/**
 * The loop's gap (ETH back per ETH in at the smallest fillable size, before gas) and its most profitable size:
 * a 16-point grid, then an 8-point grid between the best point's neighbours. Profit is after gas at feeWei.
 */
export async function bestSize(client, loop, pools, feeWei, { minWei = MIN_SIZE_WEI, maxWei = MAX_SEARCH_WEI, points = 16, l1Wei = 0n } = {}) {
  if (typeof feeWei !== "bigint" || feeWei <= 0n) throw new Error("bestSize needs a positive fee per gas (bigint)");
  // Scored the way the floor will be: the gas limit (estimate x GAS_LIMIT_FACTOR) at the max fee, plus twice the L1 bound.
  const gasCost = (g) => (((g + ROUTER_OVERHEAD_GAS) * GAS_LIMIT_NUM) / GAS_LIMIT_DEN) * feeWei + 2n * l1Wei;
  const score = (q) => (q.out === null ? null : { ...q, gasWei: gasCost(q.gas), profit: q.out - q.amountIn - gasCost(q.gas) });
  const sizes = grid(Number(minWei), Number(maxWei), points);
  const rows = (await quoteLoop(client, loop, pools, sizes)).map(score);
  let bi = -1;
  rows.forEach((r, k) => { if (r && (bi < 0 || r.profit > rows[bi].profit)) bi = k; });
  if (bi < 0) return null;
  const smallest = rows.find(Boolean);
  const gapBps = Number(((smallest.out - smallest.amountIn) * 10_000n) / smallest.amountIn);
  // Refine between the best point's grid neighbours (fillable or not): never widen to the search bounds.
  const lo = Number(sizes[Math.max(0, bi - 1)]), hi = Number(sizes[Math.min(sizes.length - 1, bi + 1)]);
  const fine = (await quoteLoop(client, loop, pools, grid(Math.max(lo, 1), Math.max(hi, lo + 1), 8))).map(score).filter(Boolean);
  return { ...[rows[bi], ...fine].reduce((a, b) => (b.profit > a.profit ? b : a)), gapBps, gapAtWei: smallest.amountIn };
}

/**
 * eth_call the tx as `from` at the pending block, granting it enough ETH: null when it succeeds, the revert reason
 * when the transaction itself reverts. A failed request (rate limit, timeout, a node that refuses state overrides)
 * throws instead: it says nothing about the trade and must never read as "the path fails".
 */
export async function simulate(client, tx, from) {
  try {
    await client.call({ account: getAddress(from), to: tx.to, data: tx.data, value: tx.value, blockTag: "pending", stateOverride: [{ address: getAddress(from), balance: tx.value + parseEther("1") }] });
    return null;
  } catch (e) {
    let raw = null, reverted = false;
    for (let x = e; x; x = x.cause) {
      if (!raw && typeof x.data === "string" && x.data.startsWith("0x") && x.data.length >= 10) raw = x.data;
      if (x.name === "ExecutionRevertedError" || x.name === "RawContractError") reverted = true;
    }
    if (raw) {
      try { const d = decodeErrorResult({ abi: ABI.errors, data: raw }); return d.errorName + (d.args?.length ? `(${d.args.map((a) => clean(a)).join(", ")})` : ""); } catch { return `revert ${clean(raw.slice(0, 10))}`; }
    }
    if (reverted) return `reverted: ${clean(e?.shortMessage || e?.message || e)}`;
    throw e;
  }
}

/**
 * Prepare one loop at one size. The path is proven with a probe (1 wei floor, never printed) and its gas read by
 * eth_estimateGas; then the floor is input + gas at the max fee handed back + twice the L1 data-fee upper bound + the
 * profit the caller insists on. Sending with the returned fee fields keeps what you pay under the floor's gas share,
 * so a landed trade returns at least input + gas. Sendable only if the guarded tx also succeeds in simulation.
 */
export async function prepareLoop(client, { loop, pools, amountInWei, from, minProfitWei = 0n, deadlineSeconds = 30, expectedOutWei = null }) {
  if (minProfitWei < 0n) throw new Error("--min-profit-wei cannot be negative: a negative profit floor would let the trade lose");
  const block = await client.getBlock({ blockTag: "latest" });
  const deadline = block.timestamp + BigInt(deadlineSeconds);
  const probe = buildLoopTx({ loop, pools, amountInWei, minEthOutWei: 1n, deadline, probe: true });
  const pathError = await simulate(client, probe, from);
  const out = { loop: loop.id, via: loop.via, amountInWei, deadline, pathExecutes: pathError === null, pathError, sendable: false, reason: null };
  if (pathError) return { ...out, reason: `path fails: ${pathError}` };
  const gas = await client.estimateGas({ account: getAddress(from), to: probe.to, data: probe.data, value: probe.value, blockTag: "pending", stateOverride: [{ address: getAddress(from), balance: probe.value + parseEther("1") }] });
  const fees = await client.estimateFeesPerGas();
  if (fees.maxFeePerGas > MAX_FEE_PER_GAS_WEI || fees.maxPriorityFeePerGas > MAX_FEE_PER_GAS_WEI) throw new Error(`the RPC reports a fee above ${MAX_FEE_PER_GAS_WEI} wei per gas; refusing to price a transaction with it`);
  if (gas > MAX_GAS) throw new Error(`the RPC estimates ${gas} gas, above ${MAX_GAS}; refusing`);
  const l1 = await client.readContract({ address: CONTRACTS.GAS_PRICE_ORACLE, abi: ABI.oracle, functionName: "getL1FeeUpperBound", args: [BigInt((probe.data.length - 2) / 2 + 120)] });
  // The worst case an ordinary account can pay: every unit of the gas limit at the max fee, plus twice the L1 bound.
  const gasLimit = (gas * GAS_LIMIT_NUM) / GAS_LIMIT_DEN;
  const gasCostWei = gasLimit * fees.maxFeePerGas + 2n * l1;
  const minEthOutWei = amountInWei + gasCostWei + minProfitWei;
  const tx = buildLoopTx({ loop, pools, amountInWei, minEthOutWei, deadline });
  const guardedError = await simulate(client, tx, from);
  const sendable = guardedError === null && (expectedOutWei === null || expectedOutWei >= minEthOutWei);
  return {
    ...out, gasEstimate: gas, gasLimit, gasCostWei, l1FeeWei: l1, minEthOutWei, guardedError, sendable,
    reason: sendable ? null : guardedError ? `the floor reverts (${guardedError}): nothing to take right now` : "the quote no longer clears the floor",
    tx: sendable ? { to: tx.to, data: tx.data, value: toHex(tx.value), valueWei: tx.value, chainId: tx.chainId, gas: toHex(gasLimit), maxFeePerGas: toHex(fees.maxFeePerGas), maxPriorityFeePerGas: toHex(fees.maxPriorityFeePerGas) } : null,
  };
}

/** Run fn over items with at most `limit` in flight (public RPCs rate-limit bursts). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const DYNAMIC_FEE_FLAG = 0x800000;
/** Sum of the loop's pool fees in percent, and whether a pool sets its fee dynamically (then the sum is a floor). */
export function loopFees(loop, pools) {
  let pct = 0, dynamic = false;
  for (const name of loop.pools) {
    const p = pools[name];
    const fee = p.v === 4 ? p.key?.fee : p.fee;
    if (fee === undefined || fee === null) continue;
    if (fee === DYNAMIC_FEE_FLAG) { dynamic = true; continue; }
    pct += fee / 10_000;
  }
  return { pct: Math.round(pct * 100) / 100, dynamic };
}

/** Quote every loop (or one loop family) at its best size, a few loops at a time. */
export async function scan(client, { only, concurrency = 4 } = {}) {
  const [pools, fees, block, l1Wei] = await Promise.all([
    readPools(client), client.estimateFeesPerGas(), client.getBlockNumber(),
    client.readContract({ address: CONTRACTS.GAS_PRICE_ORACLE, abi: ABI.oracle, functionName: "getL1FeeUpperBound", args: [2400n] }),
  ]);
  const loops = loopsMatching(only);
  if (!loops.length) throw new Error(`no loop named ${clean(only)}; loops: ${LOOPS.map((l) => l.id).join(", ")}`);
  const rows = await mapLimit(loops, concurrency, async (loop) => ({ loop, fees: loopFees(loop, pools), best: await bestSize(client, loop, pools, fees.maxFeePerGas, { l1Wei }) }));
  return { pools, feeWei: fees.maxFeePerGas, block, rows };
}

export const poolIdOf = (key) => keccak256(enc("address, address, uint24, int24, address", [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
const symbolOf = (address) => Object.entries(TOKENS).find(([, a]) => a.toLowerCase() === address.toLowerCase())?.[0] ?? address;

/**
 * Live facts for every V4 pool: its id, liquidity and tick; for a NET pool also the founding position's owner (it
 * should be 0x...dEaD) and its share of the pool's liquidity, and the reserves implied by full-range liquidity (exact
 * while that burned full-range position is all the liquidity there is; all four tokens involved have 18 decimals).
 */
export async function readPoolFacts(client, pools) {
  return mapLimit(Object.entries(pools), 3, async ([id, p]) => {
    if (p.v !== 4) return { id, name: p.name, v: 3, feePct: p.fee / 10_000 };
    const poolId = poolIdOf(p.key);
    const [[sqrtPriceX96, tick, , lpFee], liquidity] = await Promise.all([
      client.readContract({ address: CONTRACTS.V4_STATE_VIEW, abi: ABI.stateView, functionName: "getSlot0", args: [poolId] }),
      client.readContract({ address: CONTRACTS.V4_STATE_VIEW, abi: ABI.stateView, functionName: "getLiquidity", args: [poolId] }),
    ]);
    const row = { id, name: p.name, v: 4, poolId, tick, lpFeePct: lpFee / 10_000, liquidity, hooks: p.key.hooks };
    if (p.burnedPosition) {
      const [owner, positionLiquidity] = await Promise.all([
        client.readContract({ address: CONTRACTS.V4_POSITION_MANAGER, abi: ABI.positions, functionName: "ownerOf", args: [p.burnedPosition] }),
        client.readContract({ address: CONTRACTS.V4_POSITION_MANAGER, abi: ABI.positions, functionName: "getPositionLiquidity", args: [p.burnedPosition] }),
      ]);
      const sp = Number(sqrtPriceX96) / 2 ** 96, L = Number(liquidity);
      row.burned = { tokenId: p.burnedPosition, owner, ownedByDead: owner.toLowerCase() === DEAD.toLowerCase(), shareOfLiquidityPct: liquidity > 0n ? Number((positionLiquidity * 10_000n) / liquidity) / 100 : null };
      row.reserves = { [symbolOf(p.key.currency0)]: L / sp / 1e18, [symbolOf(p.key.currency1)]: (L * sp) / 1e18 };
    }
    return row;
  });
}

// ---- command line ------------------------------------------------------------------------------------------------
class ArgError extends Error {}
function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") return { cmd: "help", flags: {} };
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "quote";
  const flags = {};
  for (let i = cmd === "quote" && argv[0] !== "quote" ? 0 : 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new ArgError(`unexpected argument ${clean(a)}`);
    if (a === "--json") { flags.json = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new ArgError(`${a} needs a value`);
    flags[a.slice(2)] = v;
    i++;
  }
  const known = new Set(["json", "rpc", "loop", "from", "size", "min-profit-wei", "deadline-seconds", "every"]);
  for (const k of Object.keys(flags)) if (!known.has(k)) throw new ArgError(`unknown flag --${clean(k)}`);
  if (flags.from !== undefined && !isAddress(flags.from)) throw new ArgError("--from must be an address");
  if (flags.size !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(flags.size)) throw new ArgError("--size is an amount of ETH, e.g. 0.0001");
    flags.sizeWei = parseEther(flags.size);
    if (flags.sizeWei <= 0n || flags.sizeWei > MAX_SIZE_WEI) throw new ArgError("--size must be above 0 and at most 1 ETH");
  }
  if (flags["min-profit-wei"] !== undefined && !/^\d+$/.test(flags["min-profit-wei"])) throw new ArgError("--min-profit-wei is a whole number of wei, 0 or more");
  flags.minProfitWei = BigInt(flags["min-profit-wei"] ?? "0");
  const dl = Number(flags["deadline-seconds"] ?? 30);
  if (!Number.isInteger(dl) || dl < 5 || dl > MAX_DEADLINE_SECONDS) throw new ArgError(`--deadline-seconds is a whole number from 5 to ${MAX_DEADLINE_SECONDS}`);
  flags.deadlineSeconds = dl;
  const every = Number(flags.every ?? 30);
  if (!Number.isInteger(every) || every < 10 || every > MAX_WATCH_SECONDS) throw new ArgError(`--every is a whole number of seconds from 10 to ${MAX_WATCH_SECONDS}`);
  flags.everyMs = every * 1000;
  if (flags.loop !== undefined && !loopsMatching(flags.loop).length) throw new ArgError(`no loop named ${clean(flags.loop)} (see: node net-circle.mjs loops)`);
  return { cmd, flags };
}

const HELP = `net-circle: every ETH loop through NET on Base, as one transaction that cannot pay back less than it took plus gas.
Holds no key, signs nothing, sends nothing.

  node net-circle.mjs [quote]            every loop: its gap, its fees, and whether any size pays after gas
  node net-circle.mjs prepare --from 0xYOU [--loop <id>] [--size <ETH>] [--min-profit-wei <wei>] [--deadline-seconds 30]
                                         the best loop as one unsigned tx, simulated; printed only when sendable
  node net-circle.mjs watch --from 0xYOU [--every 30] [--min-profit-wei <wei>]
                                         stdout: one JSON line per sendable tx; stderr: one status line per reading
  node net-circle.mjs selftest --from 0xYOU    prove every loop's path executes on chain today (simulation)
  node net-circle.mjs pools              every pool's id and liquidity; the NET pools' holdings and burned founding positions
  node net-circle.mjs loops              the loop ids and their legs
  --json  machine-readable output   --rpc <url> or BASE_RPC_URL (default https://mainnet.base.org; use a node you trust)

Exit codes: 0 ok (prepare: a sendable tx was printed) · 2 bad arguments · 3 the RPC is not Base · 4 selftest: a loop's path
fails · 10 prepare: nothing worth sending now · 1 a read failed or the RPC returned something implausible (nothing decided).`;

const eth = (wei) => (wei === null || wei === undefined ? "-" : `${Number(formatEther(wei)).toPrecision(4)} ETH`);
const bigJson = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v));

async function main(argv) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { if (e instanceof ArgError) { console.error(`net-circle: ${e.message}`); return 2; } throw e; }
  const { cmd, flags } = parsed;
  if (cmd === "help") { console.log(HELP); return 0; }
  if (!["quote", "prepare", "watch", "selftest", "loops", "pools"].includes(cmd)) { console.error(`net-circle: unknown command ${clean(cmd)} (quote | prepare | watch | selftest | pools | loops | help)`); return 2; }
  if (cmd === "loops") { for (const l of LOOPS) console.log(`${l.id.padEnd(19)} ${l.tokens.join(" -> ")}`); return 0; }
  if (["prepare", "watch", "selftest"].includes(cmd) && !flags.from) { console.error(`net-circle: ${cmd} needs --from 0xYourAddress (the simulation runs as you)`); return 2; }
  const client = makeClient(flags.rpc);
  const chainId = await client.getChainId();
  if (chainId !== CHAIN_ID) { console.error(`net-circle: the RPC is on chain ${chainId}, not Base (${CHAIN_ID})`); return 3; }

  if (cmd === "pools") {
    const facts = await readPoolFacts(client, await readPools(client));
    if (flags.json) { console.log(bigJson(facts)); return 0; }
    for (const f of facts) {
      if (f.v === 3) { console.log(`${f.name.padEnd(36)} Uniswap V3, fee ${f.feePct}%`); continue; }
      const res = f.reserves ? Object.entries(f.reserves).map(([s, n]) => `${n.toPrecision(4)} ${s}`).join(" + ") : "";
      const burn = f.burned ? ` · founding position #${f.burned.tokenId} owner ${f.burned.ownedByDead ? "0x...dEaD (burned)" : clean(f.burned.owner)}, ${f.burned.shareOfLiquidityPct}% of liquidity` : "";
      console.log(`${f.name.padEnd(36)} id ${f.poolId.slice(0, 10)}... fee ${f.lpFeePct}% liquidity ${f.liquidity}${res ? ` · holds ${res}` : ""}${burn}`);
    }
    return 0;
  }

  if (cmd === "selftest") {
    const pools = await readPools(client);
    let ok = true;
    for (const loop of LOOPS) {
      const block = await client.getBlock({ blockTag: "latest" });
      const probe = buildLoopTx({ loop, pools, amountInWei: flags.sizeWei ?? parseEther("0.00005"), minEthOutWei: 1n, deadline: block.timestamp + 60n, probe: true });
      const err = await simulate(client, probe, flags.from);
      ok &&= err === null;
      console.log(`${loop.id.padEnd(19)} ${err === null ? "path executes" : `FAILS: ${err}`}`);
    }
    return ok ? 0 : 4;
  }

  const once = async () => {
    const t0 = Date.now();
    const { pools, feeWei, block, rows } = await scan(client, { only: flags.loop });
    const ranked = rows.filter((r) => r.best).sort((a, b) => (b.best.profit > a.best.profit ? 1 : b.best.profit < a.best.profit ? -1 : 0));
    const top = ranked[0] ?? null;
    let prepared = null;
    const wantPrepare = cmd === "prepare" || (cmd === "watch" && top && top.best.profit > flags.minProfitWei);
    if (wantPrepare && top) {
      const amountInWei = flags.sizeWei ?? top.best.amountIn;
      prepared = await prepareLoop(client, { loop: top.loop, pools, amountInWei, from: flags.from, minProfitWei: flags.minProfitWei, deadlineSeconds: flags.deadlineSeconds, expectedOutWei: flags.sizeWei ? null : top.best.out });
    }
    return { at: new Date().toISOString(), block, ms: Date.now() - t0, feeWei, rows, top, prepared };
  };

  const render = (r) => {
    const lines = [`net-circle · block ${r.block} · ${r.at} · max fee ${(Number(r.feeWei) / 1e9).toFixed(4)} gwei · ${r.ms} ms · reads only, nothing is sent`,
      "  gap = how much more ETH comes back than goes in at the smallest size that fills, after pool fees, before gas",
      `  sizes searched: ${eth(MIN_SIZE_WEI)} to ${eth(MAX_SEARCH_WEI)}; gas is priced the way the floor prices it (limit x max fee + L1)`];
    for (const { loop, fees, best } of r.rows) {
      const feeNote = `fees ${fees.pct}%${fees.dynamic ? "+dyn" : ""}`;
      lines.push(best
        ? `  ${loop.id.padEnd(19)} gap ${(best.gapBps / 100).toFixed(2).padStart(6)}% · ${feeNote.padEnd(13)} · ${best.profit > 0n ? `PAYS ${eth(best.profit)} at ${eth(best.amountIn)} in (gas ${eth(best.gasWei)})` : `no size pays after gas (gas ~${eth(best.gasWei)} a try)`}`
        : `  ${loop.id.padEnd(19)} a leg cannot fill at any tested size`);
    }
    const p = r.prepared;
    if (!p && cmd === "prepare") lines.push("  not sendable: no loop can fill at any tested size");
    if (p) {
      lines.push(`  prepared ${p.loop} at ${eth(p.amountInWei)}: path ${p.pathExecutes ? "executes" : `fails (${p.pathError})`}${p.minEthOutWei ? `; floor ${eth(p.minEthOutWei)} = input + gas ${eth(p.gasCostWei)}${flags.minProfitWei > 0n ? ` + ${eth(flags.minProfitWei)}` : ""}` : ""}`);
      lines.push(p.sendable ? "  SENDABLE: sign and send the tx below with its fee fields, before the deadline" : `  not sendable: ${p.reason}`);
      if (p.tx) lines.push("  tx: " + bigJson(p.tx));
    }
    return lines.join("\n");
  };
  const asJson = (r) => bigJson({
    at: r.at, block: r.block, feeWei: r.feeWei,
    best: r.top && r.top.best.profit > 0n ? r.top.loop.id : null,
    loops: Object.fromEntries(r.rows.map(({ loop, fees, best }) => [loop.id, best ? { pays: best.profit > 0n, gapBps: best.gapBps, feesPct: fees.pct, feesDynamic: fees.dynamic, amountInWei: best.amountIn, ethOutWei: best.out, gasWei: best.gasWei, profitWei: best.profit } : { pays: false, fillable: false }])),
    ...(cmd === "prepare" ? { sendable: Boolean(r.prepared?.sendable), prepared: r.prepared ?? { sendable: false, reason: "no loop can fill at any tested size", tx: null } } : {}),
  });

  if (cmd !== "watch") {
    const r = await once();
    console.log(flags.json ? asJson(r) : render(r));
    return cmd === "prepare" && !r.prepared?.sendable ? 10 : 0;
  }
  // watch: never sends. One JSON line on stdout per sendable trade (pipe it to your own signer); status on stderr.
  // While a printed tx for a loop is still inside its deadline, the same loop is not printed again, so a signer that
  // sends every line never has two live transactions for one loop.
  const liveUntil = new Map();
  for (;;) {
    try {
      const r = await once();
      const p = r.prepared;
      const now = BigInt(Math.floor(Date.now() / 1000));
      if (p?.sendable && !(liveUntil.get(p.loop) > now)) {
        liveUntil.set(p.loop, p.deadline);
        console.log(bigJson({ at: r.at, block: r.block, loop: p.loop, deadline: p.deadline, floorWei: p.minEthOutWei, tx: p.tx }));
      }
      console.error(`${r.at} best ${r.top ? `${r.top.loop.id} gap ${(r.top.best.gapBps / 100).toFixed(2)}% profit ${eth(r.top.best.profit)}` : "none"}${r.prepared ? ` · ${r.prepared.sendable ? "SENDABLE" : `skip: ${r.prepared.reason}`}` : ""}`);
    } catch (e) {
      console.error(`${new Date().toISOString()} read failed, nothing decided: ${clean(e?.shortMessage || e?.message || e)}`);
    }
    await new Promise((res) => setTimeout(res, flags.everyMs));
  }
}

const self = fileURLToPath(import.meta.url);
let invokedDirectly = false;
try { invokedDirectly = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(self); } catch { invokedDirectly = false; }
if (invokedDirectly) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(`net-circle: ${clean(e?.shortMessage || e?.message || e)}`); process.exit(1); });
}
