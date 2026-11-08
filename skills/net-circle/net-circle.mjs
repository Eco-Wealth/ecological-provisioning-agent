#!/usr/bin/env node
// net-circle: the ETH / NET / ECO / ZORA circle on Base, for any agent with its own wallet.
//
// Four pools form one loop:
//   NET/WETH  Uniswap V4, 0.01%, LP burned (permanent)
//   NET/ECO   Uniswap V4, 0.01%, LP burned (permanent)
//   ECO/ZORA  Uniswap V4, the Zora coin pool for ECOWEALTH (Zora's hook, its fee)
//   ZORA/WETH Uniswap V3, 0.3%
// When one pool moves, the loop is briefly out of line and a trade around it returns more ETH than it took.
// This program finds that trade, prepares it as ONE Universal Router transaction that starts and ends in
// native ETH, and simulates it on chain. The transaction carries a minimum: if it would return less ETH than
// you put in plus gas (a bot got there first, the price moved, anything), it reverts and you lose only gas.
//
// It holds no key, signs nothing and sends nothing. You sign the prepared transaction with your own wallet.
//
//   node net-circle.mjs                         quote both directions at the best size
//   node net-circle.mjs prepare --from 0xYOU    best direction and size, as an unsigned tx, simulated
//   node net-circle.mjs prepare --from 0xYOU --direction forward --size 0.0002
//   node net-circle.mjs --json                  machine-readable
//   BASE_RPC_URL=https://...  or  --rpc https://...   (default https://mainnet.base.org)

import {
  createPublicClient, http, parseAbi, parseAbiParameters, encodeAbiParameters, encodeFunctionData,
  encodePacked, formatEther, parseEther, decodeErrorResult, getAddress,
} from "viem";
import { base } from "viem/chains";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// ---- addresses (Base mainnet, chain 8453) --------------------------------------------------------------------
export const ADDR = {
  WETH: "0x4200000000000000000000000000000000000006",
  NET: "0xE37A9125B6b14D5e8Ec056C744a99F4deC975022",
  ECO: "0x170dC0ca26F1247CED627D8aBcaFA90ecf1e1519",
  ZORA: "0x1111111111166b7FE7bd91427724B487980aFc69",
  UNIVERSAL_ROUTER: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
  V4_QUOTER: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
  V3_QUOTER: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  GAS_PRICE_ORACLE: "0x420000000000000000000000000000000000000F",
};
const ZERO = "0x0000000000000000000000000000000000000000";
export const NET_POOL_FEE = 100; // 0.01%, both NET pools
export const NET_TICK_SPACING = 1;
export const ZORA_WETH_V3_FEE = 3000; // 0.3%

// ---- Universal Router and V4 router constants (Commands.sol, Actions.sol, ActionConstants.sol) ---------------
export const CMD = { V3_SWAP_EXACT_IN: 0x00, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 };
export const ACT = { SWAP_EXACT_IN: 0x07, SETTLE: 0x0b, TAKE: 0x0e };
export const OPEN_DELTA = 0n;
export const CONTRACT_BALANCE = 1n << 255n;
export const MSG_SENDER = "0x0000000000000000000000000000000000000001";
export const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
/** Gas the router spends around the swaps (wrap, settle, take, unwrap); added to the quoters' own estimates. */
export const ROUTER_OVERHEAD_GAS = 160_000n; // measured 2026-11-08: eth_estimateGas ran 154k to 161k over the quoters' sum

const COIN_ABI = parseAbi(["function getPoolKey() view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)"]);
const V4_QUOTER_ABI = parseAbi([
  "function quoteExactInput((address exactCurrency, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 exactAmount) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const V3_QUOTER_ABI = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const ROUTER_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const ORACLE_ABI = parseAbi(["function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)"]);
const ROUTER_ERRORS = parseAbi([
  "error InsufficientETH()", "error InsufficientToken()", "error V3TooLittleReceived()", "error TransactionDeadlinePassed()",
  "error ExecutionFailed(uint256 commandIndex, bytes message)", "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
]);

// ---- the two directions ----------------------------------------------------------------------------------------
// forward: ETH -> NET (NET/WETH) -> ECO (NET/ECO) -> ZORA (coin pool) -> ETH (ZORA/WETH V3)
// reverse: ETH -> ZORA (ZORA/WETH V3) -> ECO (coin pool) -> NET (NET/ECO) -> ETH (NET/WETH)
export const DIRECTIONS = ["forward", "reverse"];

const netHop = (to) => ({ intermediateCurrency: to, fee: NET_POOL_FEE, tickSpacing: NET_TICK_SPACING, hooks: ZERO, hookData: "0x" });
const coinHop = (to, key) => ({ intermediateCurrency: to, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, hookData: "0x" });

/** The V4 part of the loop as a quoter/router path. */
export function v4Path(direction, coinKey) {
  if (direction === "forward") return { currencyIn: ADDR.WETH, path: [netHop(ADDR.NET), netHop(ADDR.ECO), coinHop(ADDR.ZORA, coinKey)] };
  if (direction === "reverse") return { currencyIn: ADDR.ZORA, path: [coinHop(ADDR.ECO, coinKey), netHop(ADDR.NET), netHop(ADDR.WETH)] };
  throw new Error(`unknown direction ${direction}`);
}

/** The V3 leg's packed path. */
export function v3Path(direction) {
  return direction === "forward"
    ? encodePacked(["address", "uint24", "address"], [ADDR.ZORA, ZORA_WETH_V3_FEE, ADDR.WETH])
    : encodePacked(["address", "uint24", "address"], [ADDR.WETH, ZORA_WETH_V3_FEE, ADDR.ZORA]);
}

const pathTuple = (p) => [p.intermediateCurrency, p.fee, p.tickSpacing, p.hooks, p.hookData];

function encodeV4Swap(direction, coinKey) {
  const { currencyIn, path } = v4Path(direction, coinKey);
  const currencyOut = direction === "forward" ? ADDR.ZORA : ADDR.WETH;
  const settle = encodeAbiParameters(parseAbiParameters("address, uint256, bool"), [currencyIn, CONTRACT_BALANCE, false]);
  const swap = encodeAbiParameters(
    parseAbiParameters("(address, (address, uint24, int24, address, bytes)[], uint128, uint128)"),
    [[currencyIn, path.map(pathTuple), OPEN_DELTA, 0n]],
  );
  const take = encodeAbiParameters(parseAbiParameters("address, address, uint256"), [currencyOut, ADDRESS_THIS, OPEN_DELTA]);
  const actions = encodePacked(["uint8", "uint8", "uint8"], [ACT.SETTLE, ACT.SWAP_EXACT_IN, ACT.TAKE]);
  return encodeAbiParameters(parseAbiParameters("bytes, bytes[]"), [actions, [settle, swap, take]]);
}

function encodeV3Swap(direction) {
  return encodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), [ADDRESS_THIS, CONTRACT_BALANCE, 0n, v3Path(direction), false]);
}

/**
 * The whole loop as one Universal Router call. Native ETH in (msg.value), native ETH out to the sender.
 * minEthOut is enforced by the final UNWRAP_WETH: below it, the whole transaction reverts.
 */
export function buildCircleTx({ direction, amountInWei, minEthOutWei, coinKey, deadline }) {
  if (!DIRECTIONS.includes(direction)) throw new Error(`unknown direction ${direction}`);
  if (!(amountInWei > 0n)) throw new Error("amountInWei must be positive");
  if (!(minEthOutWei > 0n)) throw new Error("minEthOutWei must be positive: a zero minimum would let the trade lose");
  const wrap = encodeAbiParameters(parseAbiParameters("address, uint256"), [ADDRESS_THIS, amountInWei]);
  const unwrap = encodeAbiParameters(parseAbiParameters("address, uint256"), [MSG_SENDER, minEthOutWei]);
  const middle = direction === "forward"
    ? [[CMD.V4_SWAP, encodeV4Swap(direction, coinKey)], [CMD.V3_SWAP_EXACT_IN, encodeV3Swap(direction)]]
    : [[CMD.V3_SWAP_EXACT_IN, encodeV3Swap(direction)], [CMD.V4_SWAP, encodeV4Swap(direction, coinKey)]];
  const steps = [[CMD.WRAP_ETH, wrap], ...middle, [CMD.UNWRAP_WETH, unwrap]];
  const commands = encodePacked(steps.map(() => "uint8"), steps.map(([c]) => c));
  const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: "execute", args: [commands, steps.map(([, i]) => i), deadline] });
  return { to: ADDR.UNIVERSAL_ROUTER, data, value: amountInWei, chainId: 8453 };
}

// ---- reads -----------------------------------------------------------------------------------------------------
export function makeClient(rpcUrl) {
  return createPublicClient({ chain: base, transport: http(rpcUrl || process.env.BASE_RPC_URL || "https://mainnet.base.org") });
}

export async function readCoinKey(client) {
  const [currency0, currency1, fee, tickSpacing, hooks] = await client.readContract({ address: ADDR.ECO, abi: COIN_ABI, functionName: "getPoolKey" });
  return { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks };
}

/** ETH back for amountInWei around the loop, from the two quoters; null when a leg cannot fill. */
export async function quoteCircle(client, direction, amountInWei, coinKey) {
  try {
    const { currencyIn, path } = v4Path(direction, coinKey);
    if (direction === "forward") {
      const { result: [zoraOut, g4] } = await client.simulateContract({ address: ADDR.V4_QUOTER, abi: V4_QUOTER_ABI, functionName: "quoteExactInput", args: [{ exactCurrency: currencyIn, path, exactAmount: amountInWei }] });
      const { result: [ethOut, , , g3] } = await client.simulateContract({ address: ADDR.V3_QUOTER, abi: V3_QUOTER_ABI, functionName: "quoteExactInput", args: [v3Path(direction), zoraOut] });
      return { ethOut, swapGas: g4 + g3 };
    }
    const { result: [zoraOut, , , g3] } = await client.simulateContract({ address: ADDR.V3_QUOTER, abi: V3_QUOTER_ABI, functionName: "quoteExactInput", args: [v3Path(direction), amountInWei] });
    const { result: [ethOut, g4] } = await client.simulateContract({ address: ADDR.V4_QUOTER, abi: V4_QUOTER_ABI, functionName: "quoteExactInput", args: [{ exactCurrency: currencyIn, path, exactAmount: zoraOut }] });
    return { ethOut, swapGas: g4 + g3 };
  } catch {
    return null;
  }
}

async function gasCostWei(client, gasUnits, dataBytes) {
  const gasPrice = await client.getGasPrice();
  let l1 = 0n;
  try { l1 = await client.readContract({ address: ADDR.GAS_PRICE_ORACLE, abi: ORACLE_ABI, functionName: "getL1FeeUpperBound", args: [BigInt(dataBytes + 120)] }); } catch { /* pre-Fjord node: L2 gas only */ }
  return { gasPrice, l1, total: gasUnits * gasPrice + l1 };
}

/** Best input size for one direction: a geometric grid, then a golden-section refine around the best cell. */
export async function bestCircle(client, direction, coinKey, { minWei = parseEther("0.00001"), maxWei = parseEther("0.005"), gridPoints = 12, refine = 10, gasPriceWei } = {}) {
  const profitAt = async (x) => {
    const q = await quoteCircle(client, direction, x, coinKey);
    if (!q) return { x, q: null, profit: -(1n << 200n) };
    const gas = (q.swapGas + ROUTER_OVERHEAD_GAS) * gasPriceWei;
    return { x, q, profit: q.ethOut - x - gas, gasWei: gas };
  };
  const ratio = Math.pow(Number(maxWei) / Number(minWei), 1 / (gridPoints - 1));
  const grid = [];
  for (let i = 0; i < gridPoints; i++) grid.push(await profitAt(BigInt(Math.round(Number(minWei) * Math.pow(ratio, i)))));
  let bi = 0;
  for (let i = 1; i < grid.length; i++) if (grid[i].profit > grid[bi].profit) bi = i;
  let lo = Number(grid[Math.max(0, bi - 1)].x), hi = Number(grid[Math.min(grid.length - 1, bi + 1)].x);
  let best = grid[bi];
  const phi = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < refine && hi - lo > 1e9; k++) {
    const c = hi - phi * (hi - lo), d = lo + phi * (hi - lo);
    const [pc, pd] = [await profitAt(BigInt(Math.round(c))), await profitAt(BigInt(Math.round(d)))];
    for (const p of [pc, pd]) if (p.profit > best.profit) best = p;
    if (pc.profit > pd.profit) hi = d; else lo = c;
  }
  return best;
}

/** eth_call the prepared tx from `from` with enough ETH granted by a state override; returns null on success or the revert reason. */
export async function simulate(client, tx, from) {
  try {
    await client.call({ account: getAddress(from), to: tx.to, data: tx.data, value: tx.value, stateOverride: [{ address: getAddress(from), balance: tx.value + parseEther("1") }] });
    return null;
  } catch (e) {
    const raw = e?.cause?.data ?? e?.data ?? e?.walk?.((x) => x?.data)?.data;
    if (typeof raw === "string" && raw.startsWith("0x") && raw.length >= 10) {
      try { const d = decodeErrorResult({ abi: ROUTER_ERRORS, data: raw }); return d.errorName + (d.args?.length ? `(${d.args.map(String).join(", ")})` : ""); } catch { return `revert ${raw.slice(0, 10)}`; }
    }
    return (e?.shortMessage || e?.message || String(e)).split("\n")[0];
  }
}

// ---- command line ----------------------------------------------------------------------------------------------
const flag = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const eth = (wei) => `${Number(formatEther(wei)).toPrecision(4)} ETH`;

async function main(argv) {
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "quote";
  const json = argv.includes("--json");
  if (!["quote", "prepare"].includes(cmd)) { console.error(`net-circle: unknown command ${cmd} (quote | prepare)`); return 2; }
  const client = makeClient(flag(argv, "--rpc"));
  const coinKey = await readCoinKey(client);
  const gasPriceWei = await client.getGasPrice();
  const out = { at: new Date().toISOString(), coinPool: coinKey, gasPriceWei: gasPriceWei.toString(), directions: {} };
  const lines = [`net-circle · ${out.at} · Base gas ${(Number(gasPriceWei) / 1e9).toFixed(4)} gwei · reads only, nothing is sent`];

  const forced = flag(argv, "--direction");
  const sizeArg = flag(argv, "--size");
  if (forced && !DIRECTIONS.includes(forced)) { console.error("net-circle: --direction is forward or reverse"); return 2; }
  const dirs = forced ? [forced] : DIRECTIONS;
  const results = [];
  for (const d of dirs) {
    let r;
    if (sizeArg) {
      const x = parseEther(sizeArg);
      const q = await quoteCircle(client, d, x, coinKey);
      const gasWei = q ? (q.swapGas + ROUTER_OVERHEAD_GAS) * gasPriceWei : 0n;
      r = { x, q, gasWei, profit: q ? q.ethOut - x - gasWei : -(1n << 200n) };
    } else {
      r = await bestCircle(client, d, coinKey, { gasPriceWei });
    }
    results.push({ d, ...r });
    out.directions[d] = r.q ? { amountInWei: r.x.toString(), ethOutWei: r.q.ethOut.toString(), gasWei: r.gasWei.toString(), profitWei: r.profit.toString() } : { fillable: false };
    lines.push(r.q
      ? `  ${d.padEnd(7)} best size ${eth(r.x)} -> ${eth(r.q.ethOut)} back · gas about ${eth(r.gasWei)} · ${r.profit > 0n ? `PROFIT ${eth(r.profit)}` : `no profit (${eth(r.profit)})`}`
      : `  ${d.padEnd(7)} a leg cannot fill right now`);
  }

  if (cmd === "prepare") {
    const from = flag(argv, "--from");
    if (!from) { console.error("net-circle: prepare needs --from 0xYourAddress (used only to simulate; the ETH comes back to whoever sends)"); return 2; }
    const pick = results.filter((r) => r.q).sort((a, b) => (b.profit > a.profit ? 1 : -1))[0];
    if (!pick) { console.error("net-circle: no direction can fill right now"); return 3; }
    const minProfit = BigInt(flag(argv, "--min-profit-wei") ?? "0");
    const deadline = BigInt(Math.floor(Date.now() / 1000) + Number(flag(argv, "--deadline-seconds") ?? 120));
    // The path alone (a 1 wei floor) proves the route executes; its gas comes from eth_estimateGas when the node
    // allows a balance override, else from the quoters plus the router's overhead.
    const loose = buildCircleTx({ direction: pick.d, amountInWei: pick.x, minEthOutWei: 1n, coinKey, deadline });
    const mechanical = await simulate(client, loose, from);
    let gasUnits = pick.q.swapGas + ROUTER_OVERHEAD_GAS;
    let gasSource = "quoters + router overhead";
    try {
      gasUnits = await client.estimateGas({ account: getAddress(from), to: loose.to, data: loose.data, value: loose.value, stateOverride: [{ address: getAddress(from), balance: loose.value + parseEther("1") }] });
      gasSource = "eth_estimateGas";
    } catch { /* node refused the override: keep the quoters' figure */ }
    // The floor: everything you put in, plus the gas you will pay, plus any profit you insist on. Below it, revert.
    const cost = await gasCostWei(client, gasUnits, (loose.data.length - 2) / 2);
    const minEthOutWei = pick.x + cost.total + minProfit;
    const tx = buildCircleTx({ direction: pick.d, amountInWei: pick.x, minEthOutWei, coinKey, deadline });
    const guarded = await simulate(client, tx, from);
    out.prepared = { direction: pick.d, tx: { to: tx.to, data: tx.data, value: tx.value.toString(), chainId: tx.chainId, gas: ((gasUnits * 12n) / 10n).toString() }, minEthOutWei: minEthOutWei.toString(), gasUnits: gasUnits.toString(), gasSource, gasCostWei: cost.total.toString(), deadline: deadline.toString(), simulation: { pathExecutes: mechanical === null, pathError: mechanical, guardedSucceeds: guarded === null, guardedError: guarded } };
    lines.push(`  prepared ${pick.d}: send ${eth(pick.x)} to ${tx.to}, reverts unless at least ${eth(minEthOutWei)} comes back (input + gas ${eth(cost.total)}${minProfit > 0n ? ` + ${eth(minProfit)}` : ""}), deadline ${Number(deadline - BigInt(Math.floor(Date.now() / 1000)))}s`);
    lines.push(`  simulation: the path ${mechanical === null ? "executes" : `fails: ${mechanical}`}; with the floor it ${guarded === null ? "SUCCEEDS: sign and send it now" : `reverts (${guarded}): do not send, nothing to take right now`}`);
    lines.push("  tx (sign with your own wallet): " + JSON.stringify(out.prepared.tx));
  }
  console.log(json ? JSON.stringify(out, null, 2) : lines.join("\n"));
  return 0;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error(`net-circle: ${e?.shortMessage || e?.message || e}`); process.exit(1); });
}
