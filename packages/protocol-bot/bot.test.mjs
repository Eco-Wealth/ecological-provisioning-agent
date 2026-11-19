// Offline checks for the protocol bot (node --test): no network, no real key, no kit process. Every key here is made in a
// temporary folder by the test and thrown away.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, parseEther, toFunctionSelector } from "viem";
import {
  ADDR, ADDRESS_THIS, CHAINS, GuardError, LEG_ORDER, MAX_GMX_USDC, MAX_KVCM_APPROVE, MSG_SENDER, ROUTER_CMD, RULES, SEL, SIGNATURES, V4_ACT, ArgError,
  checkTx, kitEnv, listText, loadAccount, makeContext, makeWallet, openHome, parseArgs, pass, validVote,
} from "./bot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.resolve(HERE, "../../skills/protocol-guide/protocol-guide.mjs");
const CIRCLE = path.resolve(HERE, "../../skills/net-circle/net-circle.mjs");
const ME = "0x1111111111111111111111111111111111111111";
const THIEF = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const ABI = Object.fromEntries(Object.entries(SIGNATURES).map(([k, s]) => [k, parseAbi([s])]));
const call = (fn, args) => encodeFunctionData({ abi: ABI[fn], functionName: fn, args });
const tx = (to, data, over = {}) => ({ to, data, value: "0x0", chainId: 8453, gas: "0x30d40", maxFeePerGas: "0x989680", maxPriorityFeePerGas: "0x989680", ...over });
const caps = { from: ME, maxTxFeeWei: parseEther("0.0005") };
const voteTx = (over) => tx(ADDR.hydrexVoter, call("vote", [[POOL], [10000n]]), over);
// The swaps in these tests are built by the two kits' own builders, so the gate is held against what the kits really emit.
const kit = await import(KIT);
const circle = await import(CIRCLE);
const ECO_POOL = kit.V4_SWAP_POOLS["eth-eco"];
const COIN_KEY = { currency0: circle.TOKENS.ZORA, currency1: circle.TOKENS.ECO, fee: 30000, tickSpacing: 200, hooks: "0xd61A675F8a0c67A73DC3B54FB7318B4D91409040" };
const CIRCLE_POOLS = { ...circle.POOLS, coin: { ...circle.POOLS.coin, key: COIN_KEY } };
const hex = (n) => `0x${n.toString(16)}`;
const swapTx = (value, over) => { const b = kit.buildEthInSwapTx({ key: ECO_POOL.key, tokenOut: ECO_POOL.token, amountInWei: value, minOutUnits: 1n, deadline: 2_000_000_000n }); return tx(b.to, b.data, { value: hex(value), ...over }); };
const tripTx = (value, id = "zora:buy-net", over) => { const b = circle.buildLoopTx({ loop: circle.LOOPS.find((l) => l.id === id), pools: CIRCLE_POOLS, amountInWei: value, minEthOutWei: value + 1n, deadline: 2_000_000_000n }); return tx(b.to, b.data, { value: hex(value), ...over }); };
const enc = (types, values) => encodeAbiParameters(parseAbiParameters(types), values);
const cmdHex = (list) => `0x${list.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
/** A hand-made router call: [command byte, input] pairs. */
const router = (steps, value = 1000n) => tx(ADDR.universalRouter, call("execute", [cmdHex(steps.map(([c]) => c)), steps.map(([, i]) => i), 2_000_000_000n]), { value: hex(value) });
const v4 = (acts) => enc("bytes, bytes[]", [cmdHex(acts.map(([a]) => a)), acts.map(([, p]) => p)]);
const settle = (currency, amount, payerIsUser = false) => [V4_ACT.SETTLE, enc("address, uint256, bool", [currency, amount, payerIsUser])];
const take = (recipient) => [V4_ACT.TAKE, enc("address, address, uint256", [POOL, recipient, 0n])];
const swapAct = [V4_ACT.SWAP_EXACT_IN, "0x"];
const NATIVE = "0x0000000000000000000000000000000000000000";
const sweep = (recipient, token = NATIVE) => [ROUTER_CMD.SWEEP, enc("address, address, uint256", [token, recipient, 0n])];
const order = (over = {}) => call("createOrder", [{
  addresses: { receiver: ME, cancellationReceiver: "0x0000000000000000000000000000000000000000", callbackContract: "0x0000000000000000000000000000000000000000", uiFeeReceiver: "0x0000000000000000000000000000000000000000", market: POOL, initialCollateralToken: ADDR.arbitrumUsdc, swapPath: [], ...over },
  numbers: { sizeDeltaUsd: 1n, initialCollateralDeltaAmount: 1n, triggerPrice: 0n, acceptablePrice: 1n, executionFee: 1n, callbackGasLimit: 0n, minOutputAmount: 0n, validFromTime: 0n },
  orderType: 2, decreasePositionSwapType: 0, isLong: true, shouldUnwrapNativeToken: false, autoCancel: false, referralCode: `0x${"00".repeat(32)}`, dataList: [],
}]);
const gmxTx = (calls, over) => tx(ADDR.gmxExchangeRouter, call("multicall", [calls]), { chainId: 42161, value: "0x64", ...over });
const goodGmx = () => [call("sendWnt", [ADDR.gmxOrderVault, 100n]), call("sendTokens", [ADDR.arbitrumUsdc, ADDR.gmxOrderVault, MAX_GMX_USDC]), order()];
const retirementTx = (maxInputTokenIn = 10n ** 18n, inputToken = ADDR.kvcm) =>
  tx(ADDR.klimaAggregator, call("retireCreditViaKlima", [
    POOL, 0n, 0n, 10n ** 16n, inputToken, POOL, maxInputTokenIn, 0n,
    {
      retiringAddress: ME, retiringEntityString: "Test", beneficiaryAddress: ME, beneficiaryString: "Test",
      retirementMessage: "", beneficiaryLocation: "", consumptionCountryCode: "",
      consumptionPeriodStart: 0n, consumptionPeriodEnd: 0n,
    },
  ]));

test("every pinned selector is the selector of its signature", () => {
  for (const [name, sig] of Object.entries(SIGNATURES)) assert.equal(SEL[name], toFunctionSelector(parseAbi([sig])[0]), name);
});

test("every pinned contract is the kit's own constant, and the kit builds the calls the rules name", async () => {
  assert.equal(ADDR.hydrexVoter, kit.HYDREX.Voter);
  assert.equal(ADDR.kvcm, kit.KLIMA.kVCM);
  assert.equal(ADDR.klimaAggregator, kit.KLIMA.RetirementAggregator);
  assert.equal(ADDR.klimaAssetManager, kit.KLIMA.AssetManager);
  assert.equal(ADDR.universalRouter, kit.REGEN.UniversalRouter);
  assert.equal(ADDR.universalRouter, circle.CONTRACTS.UNIVERSAL_ROUTER);
  assert.equal(ADDR.gmxExchangeRouter, kit.GMX.ExchangeRouter);
  assert.equal(ADDR.gmxRouter, kit.GMX.Router);
  assert.equal(ADDR.gmxOrderVault, kit.GMX.OrderVault);
  assert.equal(ADDR.arbitrumUsdc, kit.GMX.USDC);
  assert.equal(CHAINS.base.id, kit.CHAIN.base);
  assert.equal(CHAINS.arbitrum.id, kit.CHAIN.arbitrum);
  assert.equal(MAX_KVCM_APPROVE, kit.MAX_KLIMA_KVCM_IN);
  assert.equal(MAX_GMX_USDC, kit.MAX_GMX_COLLATERAL_USDC);
  // The kit's own GMX order, built by the kit, passes the bot's gate; the same order paying someone else does not.
  const built = kit.buildIncreaseTx({ from: ME, market: POOL, isLong: true, collateralUnits: 5_000_000n, leverageTenths: 20n, acceptable: 1n, executionFee: 100n });
  assert.equal(checkTx("gmx", tx(built.to, built.data, { chainId: 42161, value: "0x64" }), caps), null);
  const stolen = kit.buildIncreaseTx({ from: THIEF, market: POOL, isLong: true, collateralUnits: 5_000_000n, leverageTenths: 20n, acceptable: 1n, executionFee: 100n });
  assert.match(checkTx("gmx", tx(stolen.to, stolen.data, { chainId: 42161, value: "0x64" }), caps), /not yours/);
  const src = fs.readFileSync(KIT, "utf8");
  for (const fn of ["claimFees", "claimBribes", "vote", "retireCreditViaKlima", "execute", "multicall", "sendWnt", "sendTokens", "createOrder"]) assert.ok(src.includes(`"${fn}"`), `the kit names ${fn}`);
});

test("the gate passes the steps on the list", () => {
  assert.equal(checkTx("hydrex", voteTx(), caps), null);
  assert.equal(checkTx("hydrex", tx(ADDR.hydrexVoter, call("claimFees", [[POOL], [[POOL]]])), caps), null);
  assert.equal(checkTx("hydrex", tx(ADDR.hydrexVoter, call("claimBribes", [[POOL], [[POOL]]])), caps), null);
  assert.equal(checkTx("klima", tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, MAX_KVCM_APPROVE])), caps), null);
  assert.equal(checkTx("klima", tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, 0n])), caps), null);
  assert.equal(checkTx("klima", retirementTx(), caps), null);
  assert.equal(checkTx("eco", swapTx(1000n), { ...caps, sizeWei: 1000n }), null);
  assert.equal(checkTx("gmx", gmxTx(goodGmx()), caps), null);
  assert.equal(checkTx("gmx", tx(ADDR.arbitrumUsdc, call("approve", [ADDR.gmxRouter, MAX_GMX_USDC]), { chainId: 42161 }), caps), null);
});

test("the gate refuses everything else", () => {
  const transfer = encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]), functionName: "transfer", args: [THIEF, 1n] });
  assert.match(checkTx("klima", tx(ADDR.kvcm, transfer), caps), /not on the list/);
  assert.match(checkTx("hydrex", tx(THIEF, call("vote", [[POOL], [10000n]])), caps), /not on the list/);
  assert.match(checkTx("hydrex", voteTx({ chainId: 1 }), caps), /chain/);
  assert.match(checkTx("hydrex", voteTx({ value: "0x1" }), caps), /no ETH/);
  assert.match(checkTx("hydrex", voteTx({ gas: "0xffffffffffff" }), caps), /fees/);
  assert.match(checkTx("hydrex", voteTx({ maxPriorityFeePerGas: "0xffffffffff" }), caps), /gas or fee/);
  assert.match(checkTx("hydrex", voteTx({ l1FeeBoundWei: parseEther("1").toString() }), caps), /fees/);
  assert.match(checkTx("hydrex", { ...voteTx(), data: "0x1234" }, caps), /well formed/);
  assert.match(checkTx("nope", voteTx(), caps), /no rules/);
  assert.match(checkTx("klima", tx(ADDR.kvcm, call("approve", [THIEF, 1n])), caps), /spender/);
  assert.match(checkTx("klima", tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, MAX_KVCM_APPROVE + 1n])), caps), /above the cap/);
  assert.match(checkTx("klima", retirementTx(MAX_KVCM_APPROVE + 1n), caps), /outside the cap/);
  assert.match(checkTx("klima", retirementTx(1n, ADDR.arbitrumUsdc), caps), /must spend kVCM/);
  assert.match(checkTx("klima", tx(ADDR.klimaAggregator, `${SEL.retireCreditViaKlima}${"00".repeat(32)}`), caps), /does not decode/);
  assert.match(checkTx("eco", swapTx(1001n), { ...caps, sizeWei: 1000n }), /above/);
  assert.match(checkTx("eco", swapTx(1000n), caps), /no size set/);
  assert.match(checkTx("regen", swapTx(parseEther("0.05"), { value: hex(parseEther("0.06")) }), { ...caps, sizeWei: parseEther("1") }), /above/);
  // A vote is a hydrex step, never an eco step: rules do not leak across legs.
  assert.match(checkTx("eco", voteTx(), { ...caps, sizeWei: 1000n }), /not on the list/);
});

test("the gate reads inside a swap: only what the kits build, nothing pulled from the wallet, everything out to the owner", () => {
  const size = { ...caps, sizeWei: 1000n };
  // What the kits really build passes: the buy, and every loop the circle kit knows.
  assert.equal(checkTx("regen", swapTx(1000n), size), null);
  for (const l of circle.LOOPS) assert.equal(checkTx("circle", tripTx(1000n, l.id), size), null, l.id);
  // A buy is not a trip and a trip is not a buy.
  assert.match(checkTx("circle", swapTx(1000n), size), /must end by sweeping/);
  assert.match(checkTx("eco", tripTx(1000n), size), /one v4 swap and nothing else/);
  const buy = (acts) => router([[ROUTER_CMD.V4_SWAP, v4(acts)]]);
  assert.equal(checkTx("eco", buy([settle(NATIVE, 1000n), swapAct, take(MSG_SENDER)]), size), null);
  assert.equal(checkTx("eco", buy([settle(NATIVE, 1000n), swapAct, take(ME)]), size), null);
  assert.match(checkTx("eco", buy([settle(NATIVE, 1000n), swapAct, take(THIEF)]), size), /not yours/);
  assert.match(checkTx("eco", buy([settle(NATIVE, 1000n), swapAct, take(ADDRESS_THIS)]), size), /not yours/);
  assert.match(checkTx("eco", buy([settle(NATIVE, 1000n, true), swapAct, take(ME)]), size), /pull a token from your wallet/);
  assert.match(checkTx("eco", buy([settle(POOL, 1000n), swapAct, take(ME)]), size), /exactly the ETH/);
  assert.match(checkTx("eco", buy([settle(NATIVE, 999n), swapAct, take(ME)]), size), /exactly the ETH/);
  assert.match(checkTx("eco", buy([settle(NATIVE, 1000n), swapAct, [0x10, "0x"]]), size), /action that is not on the list \(0x10\)/);
  assert.match(checkTx("eco", buy([settle(NATIVE, 1000n), swapAct, [0x14, "0x"]]), size), /action that is not on the list/);
  assert.match(checkTx("eco", router([[ROUTER_CMD.V4_SWAP, v4([settle(NATIVE, 1000n), swapAct, take(ME)])], sweep(ME)]), size), /one v4 swap and nothing else/);
  // A trip: every command off the list is refused, by its exact byte.
  const trip = (steps) => router([...steps, sweep(MSG_SENDER)]);
  assert.equal(checkTx("circle", trip([[ROUTER_CMD.WRAP_ETH, enc("address, uint256", [ADDRESS_THIS, 1000n])]]), size), null);
  for (const [name, byte] of [["PERMIT2_TRANSFER_FROM", 0x02], ["PERMIT2_PERMIT_BATCH", 0x03], ["TRANSFER", 0x05], ["PAY_PORTION", 0x06], ["PERMIT2_PERMIT", 0x0a], ["PERMIT2_TRANSFER_FROM_BATCH", 0x0d], ["V3_SWAP_EXACT_OUT", 0x01], ["EXECUTE_SUB_PLAN", 0x21], ["V4_SWAP with the allow-revert flag", 0x90]]) {
    assert.match(checkTx("circle", trip([[byte, enc("address, address, uint256", [POOL, THIEF, 1n])]]), size), /command that is not on the list/, name);
  }
  assert.match(checkTx("circle", router([sweep(THIEF)]), size), /not yours/);
  assert.match(checkTx("circle", router([sweep(ME, POOL)]), size), /must end by sweeping ETH/);
  assert.match(checkTx("circle", router([[ROUTER_CMD.UNWRAP_WETH, enc("address, uint256", [MSG_SENDER, 1n])]]), size), /must end by sweeping/);
  assert.match(checkTx("circle", trip([[ROUTER_CMD.UNWRAP_WETH, enc("address, uint256", [THIEF, 1n])]]), size), /not yours/);
  assert.match(checkTx("circle", trip([[ROUTER_CMD.WRAP_ETH, enc("address, uint256", [THIEF, 1000n])]]), size), /not yours/);
  assert.match(checkTx("circle", trip([[ROUTER_CMD.WRAP_ETH, enc("address, uint256", [ADDRESS_THIS, 1001n])]]), size), /more ETH than the step carries/);
  assert.match(checkTx("circle", trip([[ROUTER_CMD.V3_SWAP_EXACT_IN, enc("address, uint256, uint256, bytes, bool", [THIEF, 1n, 0n, "0x", false])]]), size), /not yours/);
  assert.match(checkTx("circle", trip([[ROUTER_CMD.V3_SWAP_EXACT_IN, enc("address, uint256, uint256, bytes, bool", [ADDRESS_THIS, 1n, 0n, "0x", true])]]), size), /pull a token from your wallet/);
  assert.match(checkTx("circle", trip([[ROUTER_CMD.V4_SWAP, v4([settle(POOL, 1n, true), swapAct, take(ADDRESS_THIS)])]]), size), /pull a token from your wallet/);
  assert.match(checkTx("circle", trip([[ROUTER_CMD.V4_SWAP, v4([settle(POOL, 1n), swapAct, take(THIEF)])]]), size), /not yours/);
  assert.match(checkTx("circle", trip([[ROUTER_CMD.V4_SWAP, "0x1234"]]), size), /does not decode/);
  assert.match(checkTx("circle", tx(ADDR.universalRouter, call("execute", ["0x0404", [sweep(ME)[1]], 1n]), { value: "0x1" }), size), /do not line up/);
});

test("the gate reads inside a GMX order", () => {
  assert.match(checkTx("gmx", gmxTx([call("sendWnt", [THIEF, 100n]), order()]), caps), /order vault/);
  assert.match(checkTx("gmx", gmxTx([call("sendWnt", [ADDR.gmxOrderVault, 101n]), order()]), caps), /not exactly/);
  assert.match(checkTx("gmx", gmxTx([call("sendWnt", [ADDR.gmxOrderVault, 99n]), order()]), caps), /not exactly/);
  assert.match(checkTx("gmx", gmxTx([call("sendTokens", [ADDR.arbitrumUsdc, THIEF, 1n]), order()]), caps), /collateral/);
  assert.match(checkTx("gmx", gmxTx([call("sendTokens", [ADDR.arbitrumUsdc, ADDR.gmxOrderVault, MAX_GMX_USDC + 1n]), order()]), caps), /above the cap/);
  assert.match(checkTx("gmx", gmxTx([
    call("sendWnt", [ADDR.gmxOrderVault, 100n]),
    call("sendTokens", [ADDR.arbitrumUsdc, ADDR.gmxOrderVault, MAX_GMX_USDC]),
    call("sendTokens", [ADDR.arbitrumUsdc, ADDR.gmxOrderVault, 1n]), order(),
  ]), caps), /total collateral.*above the cap/);
  assert.match(checkTx("gmx", gmxTx([order({ receiver: THIEF })]), caps), /not yours/);
  assert.match(checkTx("gmx", gmxTx([order({ cancellationReceiver: THIEF })]), caps), /not yours/);
  assert.match(checkTx("gmx", gmxTx([order({ callbackContract: THIEF })]), caps), /callback/);
  assert.match(checkTx("gmx", gmxTx([order({ swapPath: [POOL] })]), caps), /plain USDC/);
  assert.match(checkTx("gmx", gmxTx([call("sendWnt", [ADDR.gmxOrderVault, 100n]), order(), order()]), caps), /exactly one/);
  assert.match(checkTx("gmx", gmxTx([call("sendWnt", [ADDR.gmxOrderVault, 100n])]), caps), /exactly one/);
  assert.match(checkTx("gmx", gmxTx([call("approve", [THIEF, 1n])]), caps), /not on the list/);
  assert.match(checkTx("gmx", gmxTx(goodGmx(), { value: parseEther("0.006").toString() }), caps), /execution fee/);
});

test("no rule lets a token leave by transfer, and the list command prints every rule", () => {
  const text = listText();
  for (const leg of LEG_ORDER) for (const r of RULES[leg]) { assert.ok(text.includes(r.to)); assert.ok(!/transfer/i.test(r.fn)); }
  assert.deepEqual(Object.keys(RULES).sort(), [...LEG_ORDER].sort());
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "protocol-bot-"));

test("the key file: made once, owner-only, never overwritten, refused when others can read it", { skip: process.platform === "win32" }, () => {
  const dir = tmp(), file = path.join(dir, "home", "wallet.key");
  const a = makeWallet(file);
  assert.equal(a.made, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = makeWallet(file);
  assert.equal(b.made, false);
  assert.equal(b.address, a.address);
  assert.equal(loadAccount(file).address, a.address);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadAccount(file), /other users/);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, "not a key\n");
  assert.throws(() => loadAccount(file), /does not hold one private key/);
  assert.throws(() => loadAccount(path.join(dir, "none")), ArgError);
});

test("a kit gets an environment with no secret in it", () => {
  const env = kitEnv({ base: "https://b", arbitrum: "https://a" }, { PATH: "/bin", HOME: "/h", VEALTH_AGENT_KEY: "0xsecret", SOME_MODEL_TOKEN: "secret", WALLET_SECRET: "0xsecret" });
  assert.deepEqual(Object.keys(env).sort(), ["ARBITRUM_RPC_URL", "BASE_RPC_URL", "HOME", "PATH"]);
});

test("arguments: no size means no spend, caps have ceilings, unknown words are refused", () => {
  const o = parseArgs(["once", "--address", ME], {});
  assert.equal(o.live, false);
  assert.equal(o.regenWei, 0n); assert.equal(o.ecoWei, 0n); assert.equal(o.circleWei, 0n);
  assert.deepEqual(o.legs, LEG_ORDER);
  assert.throws(() => parseArgs(["once", "--eco-eth", "0.06"], {}), /at most/);
  assert.throws(() => parseArgs(["once", "--day-spend-eth", "2"], {}), /at most/);
  assert.throws(() => parseArgs(["once", "--max-tx-fee-eth", "1"], {}), /at most/);
  assert.throws(() => parseArgs(["once", "--send-everything"], {}), /no flag/);
  assert.throws(() => parseArgs(["drain"], {}), /no command/);
  assert.throws(() => parseArgs(["once", "--legs", "hydrex,bank"], {}), /no leg/);
  assert.throws(() => parseArgs(["once", "--hydrex-vote", `${POOL}:9999`], {}), /10000/);
  assert.throws(() => parseArgs(["once", "--klima-name", "--json"], {}), /plain characters/);
  assert.throws(() => parseArgs(["once", "--address", "0x12"], {}), /address/);
  assert.equal(validVote(`${POOL}:6000,${ME}:4000`), true);
  assert.equal(validVote(`${POOL}:6000,${ME}:4001`), false);
  assert.equal(validVote(`${POOL}:10000;rm`), false);
});

// ---- whole passes, with a pretend kit and a pretend chain ------------------------------------------------------------
const EPOCH = { epochStart: "1763000000", secondsToFlip: "100" };
const VOTE = `${POOL}:10000`;
function world({ live = false, args = [], answers = {}, nowMs = Date.parse("2026-11-20T00:00:00Z") } = {}) {
  const dir = tmp();
  const opts = parseArgs(["once", "--address", ME, "--home", dir, ...(live ? ["--live"] : []), ...args], {});
  const calls = [], sent = [], said = [];
  const base = {
    "hydrex epoch": { code: 0, out: EPOCH },
    "hydrex locks": { code: 0, out: { nfts: [{ tokenId: "1" }], votes: [] } },
    "hydrex prepare claim": { code: 0, out: { sendable: true, prepared: { steps: [{ kind: "fees", tokens: [{ earned: "1.5", symbol: "USDC" }], tx: tx(ADDR.hydrexVoter, call("claimFees", [[POOL], [[POOL]]])) }, { kind: "bribes", tokens: [{ earned: "2", symbol: "kVCM" }], tx: tx(ADDR.hydrexVoter, call("claimBribes", [[POOL], [[POOL]]])) }] } } },
    "hydrex rank": { code: 0, out: { act: "hydrex rank", vote: VOTE } },
    "hydrex prepare vote": { code: 0, out: { sendable: true, prepared: { tx: voteTx() } } },
    "uniswap prepare swap": { code: 0, out: { sendable: true, prepared: { minOut: "12.5", disclosure: "EcoWealth created ECO, holds it and gains if it rises", tx: swapTx(parseEther("0.0002")) } } },
    "regen prepare buy-regen": { code: 0, out: { sendable: true, prepared: { minOut: "3", tx: swapTx(parseEther("0.0002")) } } },
    "prepare": { code: 0, out: { sendable: true, prepared: { loop: "zora:buy-net", deadline: String(Math.floor(nowMs / 1000) + 30), tx: tripTx(parseEther("0.0001")) } } },
    ...answers,
  };
  const kit = async (file, a) => {
    const key = Object.keys(base).filter((k) => a.join(" ").startsWith(k)).sort((x, y) => y.length - x.length)[0];
    calls.push(a.join(" "));
    const r = base[key];
    return typeof r === "function" ? r(a) : r ?? { code: 2, out: null, err: "unknown act" };
  };
  let n = 0;
  const io = { send: async (chain, t) => { sent.push({ chain, to: t.to, sel: t.data.slice(0, 10), value: BigInt(t.value) }); return `0x${String(++n).padStart(64, "0")}`; }, wait: async () => true, seen: async () => null };
  const home = openHome(dir);
  const ctx = makeContext({ opts, home, address: ME, io, kit, say: (l) => said.push(l), now: () => nowMs });
  return { ctx, calls, sent, said, home, dir };
}

test("a dry pass walks the whole loop and sends nothing", async () => {
  const w = world({ args: ["--eco-eth", "0.0002", "--regen-eth", "0.0002", "--circle-eth", "0.0001"] });
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.sent.length, 0);
  assert.ok(w.said.some((l) => /hydrex: DRY, would send claim fees 1.5 USDC/.test(l)));
  assert.ok(w.said.some((l) => l.startsWith(`hydrex: DRY, would send vote ${VOTE}`)));
  assert.ok(w.said.some((l) => /eco: EcoWealth created ECO/.test(l)));
  assert.ok(w.said.some((l) => /regen: DRY, would send buy/.test(l)));
  assert.ok(w.said.some((l) => /regen: As of 2026-11-18 EcoWealth holds REGEN/.test(l)), "the regen leg says EcoWealth holds REGEN");
  assert.ok(w.said.some((l) => /eco: As of 2026-11-18 EcoWealth both buys ECO and swaps ECO/.test(l)), "the eco leg says it both buys and swaps");
  assert.ok(w.said.some((l) => /circle: DRY, would send one trip/.test(l)));
  assert.ok(w.said.some((l) => /klima: off/.test(l)) && w.said.some((l) => /gmx: off/.test(l)));
  assert.equal(fs.existsSync(w.home.files.ledger), false);
});

test("a live pass sends the loop in order, records it, and votes once per epoch", async () => {
  const w = world({ live: true, args: ["--eco-eth", "0.0002", "--regen-eth", "0.0002", "--circle-eth", "0.0001"] });
  assert.equal(await pass(w.ctx), 0);
  assert.deepEqual(w.sent.map((s) => s.sel), [SEL.claimFees, SEL.claimBribes, SEL.vote, SEL.execute, SEL.execute, SEL.execute]);
  assert.deepEqual(w.sent.slice(3).map((s) => s.value), [parseEther("0.0002"), parseEther("0.0002"), parseEther("0.0001")]);
  assert.ok(w.calls.includes(`hydrex prepare vote --from ${ME} --vote ${VOTE}`), "the ranked vote is passed to the kit verbatim");
  assert.equal(fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").length, 6);
  assert.equal(w.home.state().hydrex.votedEpoch, EPOCH.epochStart);
  assert.equal(w.home.state().pending, undefined);
  const before = w.sent.length;
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.sent.length - before, 1, "the second pass only tries the circle again: the vote and the buys are not due");
  assert.ok(w.said.some((l) => /already voted this epoch/.test(l)));
});

test("a step that is not on the list stops its leg, sends nothing for it, and the other legs go on", async () => {
  const bad = tx(ADDR.hydrexVoter, encodeFunctionData({ abi: parseAbi(["function reset(uint256 id)"]), functionName: "reset", args: [1n] }));
  const w = world({ live: true, args: ["--eco-eth", "0.0002"], answers: { "hydrex prepare vote": { code: 0, out: { sendable: true, prepared: { tx: bad } } } } });
  assert.equal(await pass(w.ctx), 4);
  assert.deepEqual(w.sent.map((s) => s.sel), [SEL.claimFees, SEL.claimBribes, SEL.execute]);
  assert.ok(w.said.some((l) => /hydrex: STOPPED: hydrex: refused vote/.test(l)));
  assert.equal(await pass(w.ctx), 1, "a stopped leg stays stopped");
});

test("a kit with no rank yet stops only the hydrex leg, and your own vote works without it", async () => {
  const w = world({ live: true, args: ["--eco-eth", "0.0002"], answers: { "hydrex rank": { code: 2, out: null, err: "unknown act" } } });
  assert.equal(await pass(w.ctx), 1);
  assert.ok(w.said.some((l) => /no `hydrex rank` yet/.test(l)));
  assert.ok(w.sent.some((s) => s.sel === SEL.execute));
  const own = world({ live: true, args: ["--hydrex-vote", VOTE], answers: { "hydrex rank": { code: 2, out: null } } });
  assert.equal(await pass(own.ctx), 0);
  assert.ok(own.sent.some((s) => s.sel === SEL.vote));
  assert.ok(!own.calls.some((c) => c.startsWith("hydrex rank")));
});

test("no lock, a failed read and a bad vote string each end the leg without a send", async () => {
  const none = world({ live: true, answers: { "hydrex locks": { code: 0, out: { nfts: [], votes: [] } } } });
  assert.equal(await pass(none.ctx), 0);
  assert.equal(none.sent.length, 0);
  const failed = world({ live: true, answers: { "hydrex epoch": { code: 1, out: null, err: "node down" } } });
  assert.equal(await pass(failed.ctx), 0);
  await pass(failed.ctx);
  assert.equal(await pass(failed.ctx), 1, "three failures in a row stop the leg");
  const odd = world({ live: true, answers: { "hydrex rank": { code: 0, out: { vote: `${POOL}:10000 --from ${THIEF}` } } } });
  assert.equal(await pass(odd.ctx), 1);
  assert.ok(!odd.sent.some((s) => s.sel === SEL.vote));
});

test("the day caps, the STOP file and an unconfirmed transaction each hold every send", async () => {
  const capped = world({ live: true, args: ["--eco-eth", "0.0002", "--regen-eth", "0.0002", "--day-spend-eth", "0.0003", "--legs", "regen,eco"] });
  await pass(capped.ctx);
  assert.equal(capped.sent.length, 1);
  assert.ok(capped.said.some((l) => /spend cap/.test(l)));
  const stopped = world({ live: true, args: ["--eco-eth", "0.0002"] });
  fs.writeFileSync(stopped.home.files.stop, "");
  assert.equal(await pass(stopped.ctx), 0);
  assert.equal(stopped.sent.length, 0);
  assert.equal(stopped.calls.length, 0);
  const waiting = world({ live: true, args: ["--eco-eth", "0.0002"] });
  waiting.home.save({ pending: { chain: "base", hash: `0x${"ab".repeat(32)}`, leg: "eco", name: "buy", at: "2026-11-19T00:00:00Z" } });
  assert.equal(await pass(waiting.ctx), 0);
  assert.equal(waiting.sent.length, 0);
  assert.ok(waiting.said.some((l) => /still unconfirmed/.test(l)));
});

test("STOP set between transactions prevents every later send", async () => {
  const w = world({ live: true, args: ["--eco-eth", "0.0002"] });
  const send = w.ctx.io.send;
  w.ctx.io.send = async (...args) => {
    const hash = await send(...args);
    fs.writeFileSync(w.home.files.stop, "");
    return hash;
  };
  await pass(w.ctx);
  assert.equal(w.sent.length, 1, "the first send is allowed, but no later send is");
  assert.ok(w.said.some((line) => /STOP is set/.test(line)));
});

test("a timed-out receipt leaves pending and refuses later sends in the same pass", async () => {
  const w = world({ live: true, args: ["--eco-eth", "0.0002"] });
  w.ctx.io.wait = async () => { throw new Error("receipt timeout"); };
  await pass(w.ctx);
  assert.equal(w.sent.length, 1, "no second transaction may send while receipt is unresolved");
  assert.ok(w.home.state().pending, "pending must survive receipt timeout and stop later sends");
  assert.ok(w.said.some((line) => /still pending/.test(line)));
});

test("a send that gets no answer may be out: nothing more is sent, now or on the next pass, until the owner clears it", async () => {
  const w = world({ live: true, args: ["--eco-eth", "0.0002", "--regen-eth", "0.0002"] });
  const send = w.ctx.io.send;
  let calls = 0;
  w.ctx.io.send = async (...a) => { calls += 1; if (calls === 1) throw new Error("fetch failed"); return send(...a); };
  const before = w.sent.length;
  await pass(w.ctx);
  assert.equal(calls, 1, "the first send threw, and no second send was even tried");
  assert.equal(w.sent.length, before, "no send went through after the one that got no answer");
  const pending = w.home.state().pending;
  assert.ok(pending && pending.hash === null, "the bot remembers that a send may be out");
  assert.ok(w.said.some((l) => /still pending, nothing sent/.test(l)), "later sends in the same pass wait");
  // the next pass says what to do and sends nothing
  w.said.length = 0;
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.sent.length, before);
  assert.ok(w.said.some((l) => /a send got no answer .* may or may not have gone out, so nothing is sent\. Look at your wallet, then delete "pending"/.test(l)));
  // once the owner clears it, the bot goes on
  const s = w.home.state(); delete s.pending; w.home.save(s);
  await pass(w.ctx);
  assert.ok(w.sent.length > before, "after the owner clears it, sending goes on");
});

test("negative Base data-fee bound cannot reduce the recorded fee cap", async () => {
  const bad = voteTx({ l1FeeBoundWei: "-999999999999999999999" });
  const w = world({ live: true, args: ["--legs", "hydrex"], answers: {
    "hydrex prepare claim": { code: 10, out: null },
    "hydrex prepare vote": { code: 0, out: { sendable: true, prepared: { tx: bad } } },
  } });
  await pass(w.ctx);
  assert.equal(w.sent.length, 1);
  const row = JSON.parse(fs.readFileSync(w.home.files.ledger, "utf8").trim());
  assert.equal(BigInt(row.feeBoundWei), BigInt(bad.gas) * BigInt(bad.maxFeePerGas));
});

test("klima: approve, retire, take the approval back; gmx: open, hold, close", async () => {
  let klimaTurn = 0;
  const approve = tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, 10n ** 18n]));
  const retire = retirementTx();
  const k = world({ live: true, args: ["--legs", "klima", "--klima-class", POOL, "--klima-credit", POOL, "--klima-tonnes", "0.01"], answers: {
    "klima prepare retire": () => ({ code: 0, out: { sendable: true, prepared: klimaTurn++ === 0 ? { step: "approve", tx: approve } : { step: "retire", tx: retire } } }),
    "klima prepare revoke": { code: 0, out: { sendable: true, prepared: { step: "revoke", tx: tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, 0n])) } } },
  } });
  assert.equal(await pass(k.ctx), 0);
  assert.ok(k.said.some((l) => /klima: As of 2026-11-18 EcoWealth holds a stake in Klima/.test(l)), "the klima leg says EcoWealth holds a stake in Klima");
  assert.deepEqual(k.sent.map((s) => s.sel), [SEL.approve, SEL.retireCreditViaKlima, SEL.approve]);
  assert.ok(k.home.state().klima.at);

  let open = false, turn = 0;
  const args = ["--legs", "gmx", "--gmx-market", "ETH", "--gmx-side", "long", "--gmx-collateral", "5", "--gmx-leverage", "2", "--gmx-hold-hours", "1"];
  const answers = {
    "gmx orders": { code: 0, out: [] },
    "gmx positions": () => ({ code: 0, out: open ? [{ isLong: true, market: POOL }] : [] }),
    "gmx prepare open": () => ({ code: 0, out: { sendable: true, prepared: turn++ === 0 ? { step: "approve", tx: tx(ADDR.arbitrumUsdc, call("approve", [ADDR.gmxRouter, MAX_GMX_USDC]), { chainId: 42161 }) } : { step: "order", tx: gmxTx(goodGmx()) } } }),
    "gmx prepare close": { code: 0, out: { sendable: true, prepared: { tx: gmxTx([call("sendWnt", [ADDR.gmxOrderVault, 100n]), order()]) } } },
  };
  const g = world({ live: true, args, answers });
  assert.equal(await pass(g.ctx), 0);
  assert.ok(g.said.some((l) => /gmx: As of 2026-11-18 EcoWealth holds a stake in GMX/.test(l)), "the gmx leg says EcoWealth holds a stake in GMX");
  assert.deepEqual(g.sent.map((s) => [s.chain, s.sel]), [["arbitrum", SEL.approve], ["arbitrum", SEL.multicall]]);
  open = true;
  await pass(g.ctx);
  assert.equal(g.sent.length, 2, "it holds until the hold time has passed");
  const later = makeContext({ opts: g.ctx.opts, home: g.home, address: ME, io: g.ctx.io, kit: g.ctx.kit, say: () => {}, now: () => Date.parse("2026-11-20T02:00:00Z") });
  assert.equal(await pass(later), 0);
  assert.equal(g.sent.length, 3);
  assert.ok(g.home.state().gmx.closedAt);
  // A position this bot did not open is never touched.
  open = true;
  const foreign = world({ live: true, args, answers });
  await pass(foreign.ctx);
  assert.equal(foreign.sent.length, 0);
});

test("the key never reaches a kit's command line, and GuardError is what a refusal throws", async () => {
  const w = world({ live: true, args: ["--eco-eth", "0.0002"] });
  await pass(w.ctx);
  for (const c of w.calls) assert.ok(!/0x[0-9a-fA-F]{64}/.test(c), "no 32-byte secret in any kit argument");
  assert.ok(new GuardError("x") instanceof Error);
});
