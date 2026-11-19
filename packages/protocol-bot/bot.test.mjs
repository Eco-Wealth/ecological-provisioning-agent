// Offline checks for the protocol bot (node --test): no network, no real key, no kit process. Every key here is made in a
// temporary folder by the test and thrown away.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, parseEther, keccak256, toFunctionSelector } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ADDR, ADDRESS_THIS, CHAINS, CONTRACT_BALANCE, GMX_STARTER_MARKETS, GuardError, HELP, LEG_ORDER, LEGS, MAX_GMX_USDC, MAX_KVCM_APPROVE, MAX_LEDGER_BYTES, MSG_SENDER, REGEN_RETIRE_RE, REGEN_RETIRE_TYPE_URL, ROUTER_CMD, RULES, SEL, SIGNATURES, STORAGE_SCHEMA_VERSION, PINNED_KIT_GIT_SHA1, UNSIGNED_LEGS, V4_ACT, ArgError,
  acquireWalletLease, makeChainIo, assertChainClock, assertUncontendedNonce, checkRegenRetire, checkTx, finalizedReceiptStatus, gitBlobSha1, hashLocalFile, kitEnv, listText, loadAccount, main, makeClockGuard, makeContext, makeWallet, openHome, parseArgs, pass, recordedTime, scanJournalFile, step, validVote, verifyBundledKits, verifySignedIntent, waitForNextPass,
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
const regenTx = (value, over) => { const b = kit.buildBuyRegenTx({ amountInWei: value, minOutUnits: 1n, deadline: 2_000_000_000n }); return tx(b.to, b.data, { value: hex(value), ...over }); };
const swapTx = (value, over) => { const b = kit.buildEthInSwapTx({ key: ECO_POOL.key, tokenOut: ECO_POOL.token, amountInWei: value, minOutUnits: 1n, deadline: 2_000_000_000n }); return tx(b.to, b.data, { value: hex(value), ...over }); };
const tripTx = (value, id = "zora:buy-net", over) => { const gasBound = BigInt(over?.gas ?? "0x30d40") * BigInt(over?.maxFeePerGas ?? "0x989680"); const b = circle.buildLoopTx({ loop: circle.LOOPS.find((l) => l.id === id), pools: CIRCLE_POOLS, amountInWei: value, minEthOutWei: value + gasBound + 1n, deadline: 2_000_000_000n }); return tx(b.to, b.data, { value: hex(value), ...over }); };
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
const GMX_SIZE_2X = MAX_GMX_USDC * 20n * 10n ** 23n;
const order = (over = {}, numbersOver = {}, flagsOver = {}) => call("createOrder", [{
  addresses: { receiver: ME, cancellationReceiver: "0x0000000000000000000000000000000000000000", callbackContract: "0x0000000000000000000000000000000000000000", uiFeeReceiver: "0x0000000000000000000000000000000000000000", market: POOL, initialCollateralToken: ADDR.arbitrumUsdc, swapPath: [], ...over },
  numbers: { sizeDeltaUsd: GMX_SIZE_2X, initialCollateralDeltaAmount: MAX_GMX_USDC, triggerPrice: 0n, acceptablePrice: 1n, executionFee: 100n, callbackGasLimit: 0n, minOutputAmount: 0n, validFromTime: 0n, ...numbersOver },
  orderType: 2, decreasePositionSwapType: 0, isLong: true, shouldUnwrapNativeToken: false, autoCancel: false, referralCode: `0x${"00".repeat(32)}`, dataList: [], ...flagsOver,
}]);
const KLIMA_TEST_INTENT = { credit: POOL, carbonClass: POOL, tokenId: 0n, tonnes: 10n ** 16n, name: "Test" };
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
  assert.equal(checkTx("hydrex", voteTx(), { ...caps, hydrexVote: POOL + ":10000" }), null);
  assert.match(checkTx("hydrex", voteTx(), caps), /explicit owner intent/, "no governance intent means no authorization");
  assert.equal(checkTx("hydrex", tx(ADDR.hydrexVoter, call("claimFees", [[POOL], [[POOL]]])), caps), null);
  assert.equal(checkTx("hydrex", tx(ADDR.hydrexVoter, call("claimBribes", [[POOL], [[POOL]]])), caps), null);
  assert.equal(checkTx("klima", tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, MAX_KVCM_APPROVE])), caps), null);
  assert.equal(checkTx("klima", tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, 0n])), caps), null);
  assert.equal(checkTx("klima", retirementTx(), { ...caps, klimaIntent: KLIMA_TEST_INTENT }), null);
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

test("Klima retirement signs only owner-selected credit, tonnes and beneficiary", () => {
  const intent = { ...caps, klimaIntent: KLIMA_TEST_INTENT };
  const txRetire = (changes = {}, details = {}) => tx(ADDR.klimaAggregator, call("retireCreditViaKlima", [
    changes.credit ?? POOL, changes.tokenId ?? 0n, changes.batchId ?? 0n, changes.tonnes ?? 10n ** 16n,
    changes.inputToken ?? ADDR.kvcm, changes.carbonClass ?? POOL, changes.maxKvcm ?? 10n ** 18n, changes.coupons ?? 0n,
    { retiringAddress: ME, retiringEntityString: "Test", beneficiaryAddress: ME, beneficiaryString: "Test",
      retirementMessage: "", beneficiaryLocation: "", consumptionCountryCode: "",
      consumptionPeriodStart: 0n, consumptionPeriodEnd: 0n, ...details },
  ]));
  assert.equal(checkTx("klima", txRetire(), intent), null);
  assert.match(checkTx("klima", txRetire(), caps), /explicit owner-selected/);
  for (const changes of [
    { credit: THIEF }, { carbonClass: THIEF }, { tokenId: 1n },
    { batchId: 1n }, { tonnes: 10n ** 17n }, { coupons: 1n },
  ]) assert.match(checkTx("klima", txRetire(changes), intent), /differs from the selected intent/);
  for (const details of [
    { beneficiaryAddress: THIEF }, { retiringAddress: THIEF }, { beneficiaryString: "Not Test" },
    { retiringEntityString: "Not Test" }, { retirementMessage: "side effect" },
    { consumptionCountryCode: "XX" }, { consumptionPeriodStart: 1n },
  ]) assert.match(checkTx("klima", txRetire({}, details), intent), /onchain details differ/);
});

test("Klima rejects mislabeled kit steps and refuses to turn revoke into a positive allowance", async () => {
  const args = ["--legs", "klima", "--klima-class", POOL, "--klima-credit", POOL, "--klima-tonnes", "0.01", "--klima-name", "Test"];
  const positive = tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, 10n ** 18n]));
  const zero = tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, 0n]));
  for (const [prepared, rejection] of [
    [{ step: "unknown", tx: positive }, /unrecognized retirement step/],
    [{ step: "approve", tx: retirementTx() }, /step label does not match/],
    [{ step: "retire", tx: positive }, /step label does not match/],
  ]) {
    const w = world({ live: true, args, answers: {
      "klima prepare retire": { code: 0, out: { sendable: true, prepared } },
    } });
    assert.equal(await pass(w.ctx), 4);
    assert.equal(w.sent.length, 0);
    assert.ok(w.said.some((l) => rejection.test(l)));
  }
  for (const [prepared, rejection] of [
    [{ step: "approve", tx: positive }, /unknown step or a different transaction/],
    [{ step: "revoke", tx: positive }, /must set exactly zero/],
    [{ step: "revoke", tx: retirementTx() }, /unknown step or a different transaction/],
  ]) {
    let turn = 0;
    const w = world({ live: true, args, answers: {
      "klima prepare retire": () => ({ code: 0, out: { sendable: true, prepared: turn++ === 0 ?
        { step: "approve", tx: positive } : { step: "retire", tx: retirementTx() } } }),
      "klima prepare revoke": { code: 0, out: { sendable: true, prepared } },
    } });
    assert.equal(await pass(w.ctx), 4);
    assert.equal(w.sent.length, 2, "legitimate retirement may occur, but never an unauthorized revoke transaction");
    assert.ok(w.said.some((l) => rejection.test(l)));
  }
  let turn = 0;
  const valid = world({ live: true, args, answers: {
    "klima prepare retire": () => ({ code: 0, out: { sendable: true, prepared: turn++ === 0 ?
      { step: "approve", tx: positive } : { step: "retire", tx: retirementTx() } } }),
    "klima prepare revoke": { code: 0, out: { sendable: true, prepared: { step: "revoke", tx: zero } } },
  } });
  assert.equal(await pass(valid.ctx), 0);
  assert.deepEqual(valid.sent.map((x) => x.sel), [SEL.approve, SEL.retireCreditViaKlima, SEL.approve]);
});
test("the gate reads inside a swap: only what the kits build, nothing pulled from the wallet, everything out to the owner", () => {
  const size = { ...caps, sizeWei: 1000n };
  // What the kits really build passes: the buy, and every loop the circle kit knows.
  assert.equal(checkTx("regen", regenTx(1000n), size), null);
  for (const l of circle.LOOPS) assert.equal(checkTx("circle", tripTx(1000n, l.id), size), null, l.id);
  // A buy is not a trip and a trip is not a buy.
  assert.match(checkTx("circle", swapTx(1000n), size), /must end by sweeping/);
  assert.match(checkTx("eco", tripTx(1000n), size), /one v4 swap and nothing else/);
  const buy = (acts) => router([[ROUTER_CMD.V4_SWAP, v4(acts)]]);
  assert.equal(checkTx("eco", swapTx(1000n), size), null, "only kit-shaped ECO pools pass the direct buy gate");
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
  assert.match(checkTx("circle", trip([[ROUTER_CMD.WRAP_ETH, enc("address, uint256", [ADDRESS_THIS, 1000n])]]), size), /must include a real swap/, "wrapping ETH and sweeping a refund is not a circle trade");
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

test("the NET circle gate independently checks that onchain ETH return covers input and signed gas", () => {
  const size = { ...caps, sizeWei: 1000n };
  const native = "net-pools:buy-net", weth = "net-pools:sell-net";
  assert.equal(checkTx("circle", tripTx(1000n, native), size), null);
  assert.equal(checkTx("circle", tripTx(1000n, weth), size), null);
  const changed = (route, edit) => {
    const original = tripTx(1000n, route);
    const decoded = decodeFunctionData({ abi: ABI.execute, data: original.data });
    const cmds = decoded.args[0].slice(2).match(/../g).map((hex) => parseInt(hex, 16));
    const inputs = [...decoded.args[1]];
    edit(cmds, inputs);
    return tx(original.to, call("execute", [cmdHex(cmds), inputs, decoded.args[2]]), { value: "0x3e8" });
  };
  const replaceSweep = (inp, floor, token = NATIVE) => enc("address, address, uint256", [token, MSG_SENDER, floor]);
  const replaceUnwrap = (floor) => enc("address, uint256", [MSG_SENDER, floor]);
  assert.match(checkTx("circle", changed(native, (cmds, inp) => {
    inp[inp.length - 1] = replaceSweep(inp, 0n);
  }), size), /minimum ETH return/);
  assert.match(checkTx("circle", changed(native, (cmds, inp) => {
    inp[inp.length - 1] = replaceSweep(inp, 1000n);
  }), size), /minimum ETH return/);
  assert.match(checkTx("circle", changed(weth, (cmds, inp) => {
    inp[inp.length - 2] = replaceUnwrap(0n);
  }), size), /minimum ETH return/);
  assert.match(checkTx("circle", changed(weth, (cmds, inp) => {
    inp[inp.length - 1] = replaceSweep(inp, 1n);
  }), size), /last ETH refund must have zero floor/);
  assert.match(checkTx("circle", changed(native, (cmds, inp) => {
    inp[0] = enc("address, uint256", [ADDRESS_THIS, 999n]);
  }), size), /wrap exactly its ETH/);
  assert.match(checkTx("circle", changed(native, (cmds, inp) => {
    inp[1] = replaceSweep(inp, 0n, ADDR.net);
  }), size), /early refund has unexpected/);
  assert.match(checkTx("circle", changed(weth, (cmds, inp) => {
    const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), inp[0]);
    const edited = [...params];
    edited[0] = enc("address, uint256, bool", [NATIVE, 999n, false]);
    inp[0] = enc("bytes, bytes[]", [actions, edited]);
  }), size), /must settle exactly its ETH/);
  assert.match(checkTx("circle", changed(native, (cmds, inp) => {
    cmds.splice(cmds.length - 1, 0, ROUTER_CMD.SWEEP);
    inp.splice(inp.length - 1, 0, replaceSweep(inp, 0n));
  }), size), /extra early sweep/);
});

test("direct ECO and Regen buys pin the actual output token, pool key and positive minimum", () => {
  const size = { ...caps, sizeWei: 1000n };
  assert.equal(checkTx("eco", swapTx(1000n), size), null);
  assert.equal(checkTx("regen", regenTx(1000n), size), null);
  assert.match(checkTx("regen", swapTx(1000n), size), /output token differs from its pinned route/, "ECO cannot impersonate axlREGEN");
  assert.match(checkTx("eco", regenTx(1000n), size), /output token differs from its pinned route/, "axlREGEN cannot impersonate ECO");
  const mutate = (base, index, types, fn) => {
    const decoded = decodeFunctionData({ abi: ABI.execute, data: base.data });
    const [acts, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), decoded.args[1][0]);
    const patched = [...params];
    const original = decodeAbiParameters(parseAbiParameters(types), patched[index]);
    const newValues = fn([...original]);
    patched[index] = enc(types, newValues);
    return tx(ADDR.universalRouter, call("execute", [decoded.args[0], [enc("bytes, bytes[]", [acts, patched])], decoded.args[2]]), { value: base.value });
  };
  const SWAP = "(address, (address, uint24, int24, address, bytes)[], uint128, uint128)";
  const swapMutation = (base, fn) => mutate(base, 1, SWAP, (a) => {
    const x = [...a[0]];
    fn(x);
    return [x];
  });
  const base = swapTx(1000n);
  const differentOutput = swapMutation(base, (x) => { x[1] = [[THIEF, 10000, 200, NATIVE, "0x"]]; });
  assert.match(checkTx("eco", differentOutput, size), /pool or output token differs/);
  const fee = swapMutation(base, (x) => { x[1] = [[ADDR.eco, 500, 200, NATIVE, "0x"]]; });
  assert.match(checkTx("eco", fee, size), /pool or output token differs/);
  const hook = swapMutation(base, (x) => { x[1] = [[ADDR.eco, 10000, 200, THIEF, "0x"]]; });
  assert.match(checkTx("eco", hook, size), /pool or output token differs/);
  const noFloor = swapMutation(base, (x) => { x[3] = 0n; });
  assert.match(checkTx("eco", noFloor, size), /positive onchain minimum output/);
  const takeWrongToken = mutate(base, 2, "address, address, uint256", (a) => { a[0] = THIEF; return a; });
  assert.match(checkTx("eco", takeWrongToken, size), /exact output token/);
  const takePositiveAmount = mutate(base, 2, "address, address, uint256", (a) => { a[2] = 1n; return a; });
  assert.match(checkTx("eco", takePositiveAmount, size), /exact output token/);
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

test("the GMX gate holds each signed order to the exact market-order shape, execution fee, and 1-10x starter bound", () => {
  const gmx = (calls, intent) => checkTx("gmx", gmxTx(calls), { ...caps, gmxIntent: intent });
  const full = (params = {}, root = {}) => [call("sendWnt", [ADDR.gmxOrderVault, 100n]), call("sendTokens", [ADDR.arbitrumUsdc, ADDR.gmxOrderVault, MAX_GMX_USDC]), order({}, params, root)];
  assert.equal(gmx(full(), "open"), null);
  // Order metadata is not the owner intent. Each encoded value must match the requested market and risk.
  const ownerIntent = { action: "open", market: POOL, isLong: true, collateralUnits: MAX_GMX_USDC, leverageTenths: 20n };
  assert.equal(gmxTx(full()).chainId, 42161);
  assert.equal(checkTx("gmx", gmxTx(full()), { ...caps, gmxIntent: ownerIntent }), null);
  assert.match(checkTx("gmx", gmxTx(full()), { ...caps, gmxIntent: { ...ownerIntent, market: THIEF } }), /selected market/);
  assert.match(checkTx("gmx", gmxTx(full()), { ...caps, gmxIntent: { ...ownerIntent, isLong: false } }), /selected side/);
  assert.match(checkTx("gmx", gmxTx(full()), { ...caps, gmxIntent: { ...ownerIntent, collateralUnits: 4_000_000n } }), /selected USDC/);
  assert.match(checkTx("gmx", gmxTx(full()), { ...caps, gmxIntent: { ...ownerIntent, leverageTenths: 30n } }), /selected leverage/);
  assert.match(checkTx("gmx", gmxTx(full()), { ...caps, gmxIntent: { ...ownerIntent, action: "close" } }), /type does not match/);
  assert.match(gmx(full({}, { orderType: 4 }), "open"), /type does not match|exact fee, collateral, order sequence/);
  assert.match(gmx(full({}, { orderType: 3 })), /order type/);
  assert.match(gmx(full({}, { orderType: 0 })), /order type/);
  assert.match(gmx(full({ executionFee: 99n })), /execution fee/);
  assert.match(gmx(full({ initialCollateralDeltaAmount: 1n })), /collateral does not match/);
  assert.match(gmx(full({ sizeDeltaUsd: MAX_GMX_USDC * 101n * 10n ** 23n })), /leverage outside/);
  assert.match(gmx(full({ sizeDeltaUsd: MAX_GMX_USDC * 9n * 10n ** 23n })), /leverage outside/);
  assert.match(gmx(full({ sizeDeltaUsd: 0n })), /must be positive/);
  assert.match(gmx(full({ acceptablePrice: 0n })), /unexpected trigger, price or callback/);
  assert.match(gmx(full({ triggerPrice: 1n })), /unexpected trigger, price or callback/);
  assert.match(gmx(full({ minOutputAmount: 1n })), /unexpected trigger, price or callback/);
  assert.match(gmx(full({ callbackGasLimit: 1n })), /unexpected trigger, price or callback/);
  assert.match(gmx(full({}, { referralCode: `0x${"01".repeat(32)}` })), /non-starter flags/);
  assert.match(gmx(full({}, { autoCancel: true })), /non-starter flags/);
  assert.match(gmx(full({}, { shouldUnwrapNativeToken: true })), /non-starter flags/);
  assert.match(gmx(full({}, { decreasePositionSwapType: 1 })), /unexpected decrease swap/);
  assert.match(gmx(full({}, { dataList: [`0x${"01".repeat(32)}`] })), /non-starter flags/);
  assert.match(gmx([call("sendTokens", [ADDR.arbitrumUsdc, ADDR.gmxOrderVault, MAX_GMX_USDC]), call("sendWnt", [ADDR.gmxOrderVault, 100n]), order()]), /exact fee, collateral, order sequence/);
  assert.match(gmx([call("sendWnt", [ADDR.gmxOrderVault, 100n]), call("sendTokens", [ADDR.arbitrumUsdc, ADDR.gmxOrderVault, 1n]), order()]), /collateral does not match/);
  assert.match(gmx([call("sendWnt", [ADDR.gmxOrderVault, 100n]), order()]), /exact fee, collateral, order sequence/);

  const close = kit.buildDecreaseTx({ from: ME, market: POOL, isLong: true, sizeInUsd: GMX_SIZE_2X, acceptable: 1n, executionFee: 100n });
  const closing = tx(close.to, close.data, { chainId: 42161, value: "0x64" });
  assert.equal(checkTx("gmx", closing, { ...caps, gmxIntent: "close" }), null, "the real kit's market close remains valid");
  const closeOwner = { action: "close", market: POOL, isLong: true, closeSizeUsd: GMX_SIZE_2X };
  assert.equal(checkTx("gmx", closing, { ...caps, gmxIntent: closeOwner }), null);
  assert.match(checkTx("gmx", closing, { ...caps, gmxIntent: { ...closeOwner, closeSizeUsd: GMX_SIZE_2X + 1n } }), /live position/);
  assert.match(checkTx("gmx", closing, { ...caps, gmxIntent: { ...closeOwner, market: THIEF } }), /selected market/);
  assert.match(checkTx("gmx", closing, { ...caps, gmxIntent: "open" }), /type does not match/);
  const badClose = [call("sendWnt", [ADDR.gmxOrderVault, 100n]), order({}, { initialCollateralDeltaAmount: 0n }, { orderType: 4, decreasePositionSwapType: 1 })];
  assert.equal(gmx(badClose, "close"), null);
  assert.match(gmx([badClose[0], call("sendTokens", [ADDR.arbitrumUsdc, ADDR.gmxOrderVault, 1n]), badClose[1]], "close"), /exact fee, collateral, order sequence/);
});

test("no rule lets a token leave by transfer, and the list command prints every rule", () => {
  const text = listText();
  for (const leg of LEG_ORDER) for (const r of RULES[leg] ?? []) { assert.ok(text.includes(r.to)); assert.ok(!/transfer/i.test(r.fn)); }
  // Every leg that can sign has a rule list. A leg that signs nothing is named in UNSIGNED_LEGS and has no rule list at all.
  assert.deepEqual(Object.keys(RULES).sort(), LEG_ORDER.filter((l) => !UNSIGNED_LEGS.includes(l)).sort());
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "protocol-bot-"));

test("bot home lock is exclusive, owner-bound, and fails closed on crashes or stale records", () => {
  const homePath = tmp();
  const first = openHome(homePath);
  const second = openHome(homePath);
  assert.equal(first.lock(), true, "first bot acquires the exclusive file");
  assert.equal(fs.statSync(first.files.lock).mode & 0o777, 0o600, "only owner can read the lock");
  assert.equal(second.lock(), false, "another bot, even in the same process, cannot replace the lock");
  second.unlock();
  assert.equal(fs.existsSync(first.files.lock), true, "a non-owner cannot unlink the first lock");
  assert.equal(first.lock(), false, "a second acquisition from the same instance must fail");
  first.unlock();
  assert.equal(fs.existsSync(first.files.lock), false, "the original owner can release its own lock");

  fs.writeFileSync(first.files.lock, JSON.stringify({ pid: 999999999, nonce: "stale", at: "2020-01-01T00:00:00Z" }), { mode: 0o600 });
  assert.equal(first.lock(), false, "a dead PID is not permission to auto-steal a lock");
  first.unlock();
  assert.equal(fs.existsSync(first.files.lock), true, "a stale lock requires deliberate manual recovery");
  fs.rmSync(first.files.lock);
  assert.equal(second.lock(), true, "the bot can run after a deliberate stale-lock removal");
  second.unlock();

  assert.equal(first.lock(), true);
  fs.writeFileSync(first.files.lock, JSON.stringify({ pid: process.pid, nonce: "another-owner" }), { mode: 0o600 });
  first.unlock();
  assert.equal(fs.existsSync(first.files.lock), true, "a replaced lock is not deleted by the former owner, even with the same PID");
  fs.rmSync(first.files.lock);
});

test("one accounting home binds to one wallet and will not silently import anonymous historic ledgers", async () => {
  const home = openHome(tmp());
  home.bindWallet(ME);
  assert.equal(home.state().walletAddress, ME);
  home.bindWallet(ME.toLowerCase());
  assert.equal(home.state().walletAddress, ME);
  assert.throws(() => home.bindWallet(THIEF), /bound to a different wallet/);
  assert.throws(() => home.bindWallet("not-an-address"), /valid wallet address/);
  // a ledger with no state at all: state() refuses first, with its own message
  const legacy = openHome(tmp());
  fs.writeFileSync(legacy.files.ledger, "a historic nonempty ledger", { mode: 0o600 });
  assert.throws(() => legacy.bindWallet(ME), /bot state is missing but a transaction ledger exists/);
  assert.equal(fs.existsSync(legacy.files.state), false, "legacy records are never silently adopted");
  // a state that names no wallet beside a nonempty ledger: the legacy-ledger refusal is the one that fires
  const anonymous = openHome(tmp());
  anonymous.save({});
  fs.writeFileSync(anonymous.files.ledger, "a historic nonempty ledger", { mode: 0o600 });
  assert.throws(() => anonymous.bindWallet(ME), /legacy ledger exists without a wallet identity/);
  assert.equal(anonymous.state().walletAddress, undefined, "an anonymous ledger is never bound to a wallet by itself");
  const live = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  assert.equal(await pass(live.ctx), 0);
  assert.equal(live.home.state().walletAddress.toLowerCase(), ME.toLowerCase());
  const stranger = makeContext({ opts: live.ctx.opts, home: live.home, address: THIEF,
    io: live.ctx.io, kit: live.ctx.kit, say: () => {}, now: live.ctx.now });
  await assert.rejects(
    () => step(stranger, "eco", "a forged second signer", swapTx(parseEther("0.0002")), { sizeWei: parseEther("0.0002") }),
    /bound to a different wallet/, "another signer cannot use the first signer\'s spend journal");
  assert.equal(live.sent.length, 1);
});
test("all journal timestamps are canonical real UTC dates, never future timestamps", () => {
  assert.equal(recordedTime("2026-11-20T00:00:00.000Z"), Date.UTC(2026, 10, 20));
  for (const value of ["2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z",
    "2026-11-20T24:00:00Z", "2026-11-20T00:00:60Z", "2026-11-20 00:00:00Z",
    "2026-11-20T00:00:00+00:00", "2026-11-20T00:00:00.0000Z", "garbage",
    "", null, 1, {}, "2026-11-20T00:00:00-08:00"]) {
    assert.throws(() => recordedTime(value), /timestamp/);
  }
  const now = Date.parse("2026-11-20T00:00:00.000Z");
  const home = openHome(tmp());
  home.save({}); // a ledger never exists without its state (the home refuses that on purpose)
  fs.writeFileSync(home.files.ledger, JSON.stringify({
    at: new Date(now + 130_000).toISOString(), valueWei: "1", feeBoundWei: "1",
  }) + "\n");
  assert.throws(() => home.day(now), /future transaction timestamp/);
  fs.writeFileSync(home.files.ledger, JSON.stringify({
    at: new Date(now + 60_000).toISOString(), valueWei: "1", feeBoundWei: "1",
  }) + "\n");
  assert.equal(home.day(now).spendWei, 1n, "small plausible clock drift keeps its spend reserved");
});

test("monotonic clock blocks time travel and misconfigured system time before sending", async () => {
  let wall = Date.parse("2026-11-20T00:00:00Z"), mono = 10_000_000_000n;
  const clock = makeClockGuard(() => wall, () => mono, 10_000);
  assert.equal(clock(), wall);
  wall += 60_000; mono += 60_000_000_000n;
  assert.equal(clock(), wall);
  wall -= 60_000; mono += 5_000_000_000n;
  assert.throws(() => clock(), /wall clock disagrees with monotonic time/);
  wall += 65_000;
  assert.equal(clock(), wall, "repairing wall time restores the guard without silently resetting a ledger");
  wall += 86_400_000;
  assert.throws(() => clock(), /wall clock disagrees with monotonic time/);
  assert.throws(() => makeClockGuard(() => NaN, () => 0n), /valid monotonic clock baseline/);
  const state = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  state.ctx.safeNow = () => { throw new GuardError("simulated NTP jump"); };
  await assert.rejects(() => pass(state.ctx), /simulated NTP jump/);
  assert.equal(state.sent.length, 0);
  assert.equal(fs.existsSync(state.home.files.ledger), false);
});

test("forever-loop waits on monotonic time, regardless of wall clock jumps", async () => {
  let elapsed = 0n; const sleeps = [];
  await waitForNextPass(2, async (ms) => { sleeps.push(ms); elapsed += BigInt(ms) * 1_000_000n; }, () => elapsed);
  assert.deepEqual(sleeps, [60_000, 60_000]);
  await assert.rejects(() => waitForNextPass(0), /pass interval/); // an async function rejects, it does not throw
});
test("live signing requires chain time within five minutes; dry mode requires no RPC", async () => {
  const far = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  far.ctx.io.chainTime = async (chain) => { assert.equal(chain, "base"); return far.ctx.now() + 15 * 60_000; };
  assert.equal(await pass(far.ctx), 4);
  assert.equal(far.sent.length, 0, "a wrong wall clock must never reach signing");
  assert.ok(far.said.some((line) => /node time disagrees/.test(line)));
  const malformed = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  malformed.ctx.io.chainTime = async () => NaN;
  assert.equal(await pass(malformed.ctx), 4);
  assert.equal(malformed.sent.length, 0);
  const near = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  let readCount = 0;
  near.ctx.io.chainTime = async () => { readCount++; return near.ctx.now() - 15_000; };
  assert.equal(await pass(near.ctx), 0);
  assert.equal(near.sent.length, 1);
  assert.equal(readCount, 1);
  const dry = world({ args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  dry.ctx.io.chainTime = async () => { throw new Error("dry run must not call a chain timestamp endpoint"); };
  assert.equal(await pass(dry.ctx), 0);
  assert.equal(dry.sent.length, 0);
});

test("private homes and accounting files refuse symlinks and hardlink redirection",
  { skip: process.platform === "win32" }, () => {
  const root = tmp(), physical = path.join(root, "physical"), linked = path.join(root, "link");
  fs.mkdirSync(physical, { mode: 0o700 });
  fs.symlinkSync(physical, linked, "dir");
  assert.throws(() => openHome(linked), /private real directory/);
  fs.chmodSync(physical, 0o755);
  assert.throws(() => openHome(physical), /private real directory/);
  fs.chmodSync(physical, 0o700);
  const a = openHome(physical), source = path.join(root, "source.json");
  fs.writeFileSync(source, "{}", { mode: 0o600 });
  fs.symlinkSync(source, a.files.state);
  assert.throws(() => a.state(), /private regular file/);
  fs.rmSync(a.files.state);
  fs.linkSync(source, a.files.ledger);
  assert.throws(() => a.day(Date.now()), /private regular file/);
  fs.rmSync(a.files.ledger);
  a.save({ walletAddress: ME });
  assert.equal(a.state().walletAddress, ME, "normal private state remains usable");
});
test("century-scale timestamps remain exact and outstanding journal reservations never age out", () => {
  const dir = tmp(), home = openHome(dir);
  const year = 2126, at = `${year}-06-15T12:00:00.000Z`, now = Date.parse(at), id = "ab".repeat(16);
  home.save({ pending: { id, leg: "eco", chain: "base", name: "buy", hash: null, at }, ledgerExpected: true });
  const reservation = { id, phase: "reserved", leg: "eco", chain: "base", name: "buy",
    at, hash: null, valueWei: "200", feeBoundWei: "40", kvcmUnits: "0", usdcUnits: "0" };
  home.record(reservation);
  assert.equal(home.day(now).spendWei, 200n);
  assert.equal(home.day(now + 90 * 365 * 24 * 3600_000).spendWei, 0n);
  const altered = home.state(); delete altered.pending; home.save(altered);
  assert.throws(() => home.day(now + 90 * 365 * 24 * 3600_000), /unresolved send/,
    "a 90-year-old unresolved send cannot be cleared by changing the clock");
  assert.equal(recordedTime("2200-02-28T23:59:59.000Z"), Date.UTC(2200, 1, 28, 23, 59, 59));
  assert.throws(() => recordedTime("2200-02-29T00:00:00Z"), /invalid calendar date/,
    "the Gregorian 2100/2200/2300 century leap-day rule must not normalize a false date");
});
test("journal reader streams across block boundaries, blank lines, and final unterminated records", () => {
  const dir = tmp(), file = path.join(dir, "journal-test.jsonl");
  const rows = Array.from({ length: 1300 }, (_, i) => JSON.stringify({ i, data: "x".repeat(i % 150) }));
  fs.writeFileSync(file, rows.slice(0, 600).join("\n") + "\n\n" + rows.slice(600).join("\n"));
  const results = [];
  scanJournalFile(file, (line, row) => results.push([JSON.parse(line).i, row]));
  assert.deepEqual(results.map((r) => r[0]), Array.from({ length: 1300 }, (_, i) => i));
  assert.equal(results.at(-1)[1], 1300, "the blank line increments the line count without creating an event");
  assert.ok(fs.statSync(file).size > 64 * 1024, "the fixture crosses the internal read buffer");
});

test("journal scanner rejects oversized rows instead of allocating unbounded memory", () => {
  const dir = tmp(), file = path.join(dir, "oversized.jsonl");
  fs.writeFileSync(file, "x".repeat(64 * 1024));
  const accepted = [];
  scanJournalFile(file, (line) => accepted.push(line.length));
  assert.deepEqual(accepted, [64 * 1024], "the maximum single row is accepted");
  fs.appendFileSync(file, "x");
  assert.throws(() => scanJournalFile(file, () => {}), /oversized journal row/);
  assert.equal(MAX_LEDGER_BYTES, 64 * 1024 * 1024);
});
test("format version is explicit for new state and journal and unknown future formats cannot trade", () => {
  const home = openHome(tmp()), at = "2026-11-20T00:00:00.000Z";
  home.save({ pending: { leg: "eco", hash: null } });
  const baseline = home.state();
  assert.equal(baseline.schemaVersion, STORAGE_SCHEMA_VERSION);
  assert.throws(() => home.save({ schemaVersion: STORAGE_SCHEMA_VERSION + 1 }), /unknown bot state schema/);
  home.record({ at, leg: "eco", feeBoundWei: "1", valueWei: "2" });
  const line = JSON.parse(fs.readFileSync(home.files.ledger, "utf8").trim());
  assert.equal(line.schemaVersion, STORAGE_SCHEMA_VERSION);
  assert.equal(home.day(Date.parse(at)).spendWei, 2n);
  fs.writeFileSync(home.files.state, JSON.stringify({ ...baseline, schemaVersion: STORAGE_SCHEMA_VERSION + 1 }));
  assert.throws(() => home.state(), /unknown bot state format version/);
  home.save(baseline);
  fs.writeFileSync(home.files.ledger, JSON.stringify({ ...line, schemaVersion: STORAGE_SCHEMA_VERSION + 1 }) + "\n");
  assert.throws(() => home.day(Date.parse(at)), /unknown journal format/);
  const { schemaVersion, ...knownLegacy } = line;
  fs.writeFileSync(home.files.ledger, JSON.stringify(knownLegacy) + "\n");
  assert.equal(home.day(Date.parse(at)).spendWei, 2n, "existing legacy records remain readable during a reviewed migration");
});
test("bot state and ledger fail closed instead of silently resetting spend caps after corruption", () => {
  const home = openHome(tmp());
  const now = Date.parse("2026-11-20T00:00:00Z");
  assert.deepEqual(home.state(), {});
  assert.deepEqual(home.day(now), { feeWei: 0n, spendWei: 0n, kvcmUnits: 0n, usdcUnits: 0n });
  fs.writeFileSync(home.files.state, "{malformed", { mode: 0o600 });
  assert.throws(() => home.state(), /malformed/);
  fs.writeFileSync(home.files.state, "null");
  assert.throws(() => home.state(), /not an object/);
  home.save({ pending: { leg: "gmx", hash: null } });
  assert.equal(home.state().pending.leg, "gmx", "valid records survive a durable state save");
  assert.equal(fs.statSync(home.files.state).mode & 0o777, 0o600);

  fs.writeFileSync(home.files.ledger, "{not-json\n", { mode: 0o600 });
  assert.throws(() => home.day(now), /ledger row 1/);
  fs.writeFileSync(home.files.ledger, JSON.stringify({ at: "nonsense", feeBoundWei: "1", valueWei: "1" }) + "\n");
  assert.throws(() => home.day(now), /timestamp/);
  fs.writeFileSync(home.files.ledger, JSON.stringify({ at: "2026-11-20T00:00:00Z", feeBoundWei: "-1", valueWei: "1" }) + "\n");
  assert.throws(() => home.day(now), /canonical nonnegative decimal/);
  fs.writeFileSync(home.files.ledger, JSON.stringify({ at: "2026-11-20T00:00:00Z", feeBoundWei: true, valueWei: "1" }) + "\n");
  assert.throws(() => home.day(now), /canonical nonnegative decimal/, "boolean is not a recorded fee");
  fs.writeFileSync(home.files.ledger, JSON.stringify({ at: "2026-11-20T00:00:00Z", feeBoundWei: "0x0", valueWei: "1" }) + "\n");
  assert.throws(() => home.day(now), /canonical nonnegative decimal/, "hex is not an auditable decimal ledger amount");
  fs.writeFileSync(home.files.ledger, JSON.stringify({ at: "2026-11-20T00:00:00Z", feeBoundWei: "3", valueWei: "42" }) + "\n");
  assert.deepEqual(home.day(now), { feeWei: 3n, spendWei: 42n, kvcmUnits: 0n, usdcUnits: 0n }, "valid ledger money counts toward both caps");
  home.record({ at: "2026-11-20T00:01:00Z", feeBoundWei: "2", valueWei: "4" });
  assert.deepEqual(home.day(now + 60_000), { feeWei: 5n, spendWei: 46n, kvcmUnits: 0n, usdcUnits: 0n }, "durably appended entries increase caps");
  assert.equal(fs.statSync(home.files.ledger).mode & 0o777, 0o600);
  fs.rmSync(home.files.state);
  assert.throws(() => home.state(), /state is missing but a transaction ledger exists/);
});

test("journal enforces lifecycle order, hash identity, and unresolved reservations regardless of age", () => {
  const home = openHome(tmp());
  const at = "2026-11-20T00:00:00Z";
  const id = "11".repeat(16), otherId = "22".repeat(16);
  const hash = "0x" + "ab".repeat(32), wrongHash = "0x" + "cd".repeat(32);
  const reservation = { id, phase: "reserved", at, leg: "eco", chain: "base", name: "buy", to: ADDR.universalRouter, valueWei: "100", feeBoundWei: "10", hash: null };
  const status = (phase, over = {}) => ({ ...reservation, phase, valueWei: "0", feeBoundWei: "0", hash, ...over });
  const write = (...rows) => fs.writeFileSync(home.files.ledger, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  home.save({ pending: { id, chain: "base", hash: null, leg: "eco", name: "buy", at }, ledgerExpected: true });
  write(reservation);
  assert.deepEqual(home.day(Date.parse(at)), { spendWei: 100n, feeWei: 10n, kvcmUnits: 0n, usdcUnits: 0n });
  assert.deepEqual(home.day(Date.parse(at) + 48 * 3600_000), { spendWei: 0n, feeWei: 0n, kvcmUnits: 0n, usdcUnits: 0n }, "expired cap does not imply settled journal");
  const cleared = home.state(); delete cleared.pending; home.save(cleared);
  assert.throws(() => home.day(Date.parse(at) + 48 * 3600_000), /unresolved send/, "orphaned reservation blocks forever until reconciled");
  home.save({ pending: { id, chain: "base", hash: null, leg: "eco", name: "buy", at }, ledgerExpected: true });
  write(reservation, reservation);
  assert.throws(() => home.day(Date.parse(at)), /duplicate journal reservation/);
  write(status("broadcast"));
  assert.throws(() => home.day(Date.parse(at)), /without a reservation/);
  write(reservation, status("receipt"));
  assert.throws(() => home.day(Date.parse(at)), /out of order/);
  write(reservation, status("broadcast"), status("receipt", { hash: wrongHash }));
  assert.throws(() => home.day(Date.parse(at)), /conflicting hashes/);
  write(reservation, status("broadcast"), status("receipt"));
  const ended = home.state(); delete ended.pending; home.save(ended);
  assert.deepEqual(home.day(Date.parse(at)), { spendWei: 100n, feeWei: 10n, kvcmUnits: 0n, usdcUnits: 0n }, "one reservation counts despite two zero-cost status events");
  write(reservation, status("reconciled", { hash }));
  assert.deepEqual(home.day(Date.parse(at)), { spendWei: 100n, feeWei: 10n, kvcmUnits: 0n, usdcUnits: 0n }, "crash after broadcast but before journal event can be reconciled");
  write(reservation, status("receipt", { id: otherId }));
  assert.throws(() => home.day(Date.parse(at)), /without a reservation/);
});
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

test("wallet creation fsyncs key and directory before returning its address",
  { skip: process.platform === "win32" }, () => {
  const dir = tmp(), key = path.join(dir, "wallet", "wallet.key");
  const orig = fs.fsyncSync, events = [];
  fs.fsyncSync = (fd) => { events.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file"); return orig(fd); };
  try {
    const w = makeWallet(key);
    assert.equal(w.made, true);
    assert.ok(events.length >= 3 && events[events.length - 2] === "file" && events.at(-1) === "directory",
      "key contents and the directory entry must both reach stable storage before an address is returned");
    assert.equal(loadAccount(key).address, w.address);
  } finally { fs.fsyncSync = orig; }
});

test("unsafe key destinations and hardlinks fail closed", { skip: process.platform === "win32" }, () => {
  const root = tmp(), directory = path.join(root, "world"), key = path.join(directory, "wallet.key");
  fs.mkdirSync(directory, { mode: 0o755 });
  assert.throws(() => makeWallet(key), /private, owner-held real directory/);
  fs.chmodSync(directory, 0o700);
  const w = makeWallet(key);
  assert.ok(w.address);
  const alias = path.join(directory, "second-hardlink.key");
  fs.linkSync(key, alias);
  assert.throws(() => loadAccount(key), /exactly one hardlink/);
  fs.rmSync(alias);
  assert.equal(loadAccount(key).address, w.address);
});

test("a failed key directory sync is not falsely reported as a made wallet",
  { skip: process.platform === "win32" }, () => {
  const dir = tmp(), key = path.join(dir, "wallet.key");
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error("simulated lost directory flush");
    return originalFsync(fd);
  };
  try { assert.throws(() => makeWallet(key), /cannot durably sync directory/); }
  finally { fs.fsyncSync = originalFsync; }
  assert.equal(fs.existsSync(key), true, "the conservatively retained key is not silently overwritten");
  assert.equal(makeWallet(key).made, false, "the existing key is reused rather than replaced after an uncertain write");
});
test("live helper code is byte-for-byte pinned to the reviewed sibling Git blobs", () => {
  assert.equal(gitBlobSha1(KIT), PINNED_KIT_GIT_SHA1.protocol);
  assert.equal(gitBlobSha1(CIRCLE), PINNED_KIT_GIT_SHA1.circle);
  assert.equal(verifyBundledKits(KIT, CIRCLE), true);
  const temp = tmp(), impersonator = path.join(temp, "protocol-guide.mjs");
  fs.writeFileSync(impersonator, fs.readFileSync(KIT));
  assert.equal(gitBlobSha1(impersonator), PINNED_KIT_GIT_SHA1.protocol,
    "the content hash is byte-exact, including Git blob header");
  assert.throws(() => verifyBundledKits(impersonator, CIRCLE), /bundled reviewed path/,
    "even a byte-identical helper at another pathname needs a deliberate review");
  fs.appendFileSync(impersonator, "\n// altered fixture\n");
  assert.notEqual(gitBlobSha1(impersonator), PINNED_KIT_GIT_SHA1.protocol);
  assert.throws(() => verifyBundledKits(KIT, impersonator), /bundled reviewed path/);
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
  assert.equal(parseArgs(["once", "--gmx-market", "ETH"], {}).gmxMarket, "ETH");
  assert.equal(parseArgs(["once", "--gmx-market", GMX_STARTER_MARKETS.ETH], {}).gmxMarket, GMX_STARTER_MARKETS.ETH);
  assert.throws(() => parseArgs(["once", "--gmx-market", "UNKNOWN"], {}), /gmx-market/);
  assert.throws(() => parseArgs(["once", "--gmx-collateral", "5.0000001"], {}), /6 decimal/);
  assert.throws(() => parseArgs(["once", "--gmx-collateral", "5.1"], {}), /at most 5 USDC/);
  assert.throws(() => parseArgs(["once", "--gmx-leverage", "10.1"], {}), /1x to 10x/);
  assert.throws(() => parseArgs(["once", "--gmx-leverage", "2.55"], {}), /1x to 10x/);
  assert.equal(parseArgs(["once", "--gmx-leverage", "2.5"], {}).gmxLeverage, "2.5");
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
    "regen prepare buy-regen": { code: 0, out: { sendable: true, prepared: { minOut: "3", tx: regenTx(parseEther("0.0002")) } } },
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
  const journal = fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(journal.length, 18, "six sends make three journal events each");
  assert.deepEqual(journal.map((row) => row.phase), Array.from({ length: 6 }, () => ["reserved", "broadcast", "receipt"]).flat());
  assert.equal(w.home.day(w.ctx.now()).spendWei, parseEther("0.0005"), "status rows cannot double charge");
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

test("Hydrex voting never signs pools or weights that differ from the chosen governance decision", async () => {
  const choice = POOL + ":10000", intent = { ...caps, hydrexVote: choice };
  assert.equal(checkTx("hydrex", voteTx(), intent), null);
  assert.match(checkTx("hydrex", voteTx(), caps), /explicit owner intent/);
  assert.match(checkTx("hydrex", tx(ADDR.hydrexVoter, call("vote", [[THIEF], [10000n]])), intent), /differ from the exact selected vote/);
  assert.match(checkTx("hydrex", tx(ADDR.hydrexVoter, call("vote", [[POOL], [9999n]])), intent), /differ from the exact selected vote/);
  assert.match(checkTx("hydrex", tx(ADDR.hydrexVoter, call("vote", [[POOL, THIEF], [5000n, 5000n]])), intent), /differ from the exact selected vote/);
  assert.equal(validVote(POOL + ":0," + THIEF + ":10000"), false, "zero-weight pools are not valid");
  assert.equal(validVote(POOL + ":5000," + POOL + ":5000"), false, "duplicate pool allocations are not valid");
  const altered = tx(ADDR.hydrexVoter, call("vote", [[THIEF], [10000n]]));
  const w = world({ live: true, args: ["--legs", "hydrex", "--hydrex-vote", choice], answers: {
    "hydrex prepare claim": { code: 10, out: null },
    "hydrex prepare vote": { code: 0, out: { sendable: true, prepared: { tx: altered } } },
  } });
  assert.equal(await pass(w.ctx), 4, "changed kit output must halt the Hydrex leg");
  assert.equal(w.sent.length, 0, "nothing signed for the altered vote");
  assert.ok(w.said.some((line) => /differ from the exact selected vote/.test(line)));
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
  assert.ok(waiting.said.some((l) => /is not yet final, or its finality cannot be verified\. No transactions will be sent/.test(l)));
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

test("only the exact canonical finalized transaction receipt can release pending", async () => {
  const hash = "0x" + "a1".repeat(32);
  const blockHash = "0x" + "b2".repeat(32);
  const foreignHash = "0x" + "c3".repeat(32);
  const original = { transactionHash: hash, blockHash, blockNumber: 123n, status: "success" };
  const client = (finalizedNumber = 124n, canonicalHash = blockHash) => ({
    getBlock: async ({ blockTag, blockNumber }) => {
      if (blockTag === "finalized") return { number: finalizedNumber };
      assert.equal(blockNumber, 123n);
      return { number: 123n, hash: canonicalHash };
    },
  });
  assert.equal(await finalizedReceiptStatus(client(), original, hash), true);
  assert.equal(await finalizedReceiptStatus(client(), { ...original, status: "reverted" }, hash), false);
  assert.equal(await finalizedReceiptStatus(client(122n), original, hash), null, "a one-block receipt is not final");
  assert.equal(await finalizedReceiptStatus(client(124n, foreignHash), original, hash), null, "reorganized block is not canonical");
  assert.equal(await finalizedReceiptStatus(client(), { ...original, transactionHash: foreignHash }, hash), null, "a replaced transaction cannot claim the original hash");
  assert.equal(await finalizedReceiptStatus(client(), { ...original, blockHash: "0xdead" }, hash), null, "malformed receipt cannot finalize");
  assert.equal(await finalizedReceiptStatus(client(), { ...original, status: "unknown" }, hash), null);
  assert.equal(await finalizedReceiptStatus({ getBlock: async () => ({ number: null }) }, original, hash), null, "missing finalized head must not free pending");
});
test("a live send durably flushes the state rename and new ledger directory entries before RPC",
  { skip: process.platform === "win32" }, async () => {
  const originalFsync = fs.fsyncSync;
  const events = [];
  fs.fsyncSync = (fd) => {
    events.push(fs.fstatSync(fd).isDirectory() ? "directory" : "file");
    return originalFsync(fd);
  };
  try {
    const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
    const originalSend = w.ctx.io.send;
    w.ctx.io.send = async (...args) => {
      assert.ok(events.filter((event) => event === "directory").length >= 3,
        "wallet binding, pending state rename and first ledger creation each require directory fsync before RPC");
      assert.deepEqual(events.slice(-2), ["file", "directory"],
        "the newly appended ledger row and its parent directory were both synced before sending");
      return originalSend(...args);
    };
    assert.equal(await pass(w.ctx), 0);
    assert.equal(w.sent.length, 1);
  } finally { fs.fsyncSync = originalFsync; }
});

test("a directory-fsync failure refuses to broadcast even after pending data was written",
  { skip: process.platform === "win32" }, async () => {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  const originalFsync = fs.fsyncSync;
  let directories = 0;
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory() && ++directories === 3)
      throw new Error("simulated parent directory sync error");
    return originalFsync(fd);
  };
  try {
    assert.equal(await pass(w.ctx), 4);
    assert.equal(w.sent.length, 0);
    assert.equal(directories, 3);
    assert.equal(w.home.state().pending.hash, null);
    assert.equal(w.home.day(w.ctx.now()).spendWei, parseEther("0.0002"));
    assert.ok(w.said.some((line) => /cannot durably sync directory/.test(line)));
  } finally { fs.fsyncSync = originalFsync; }
});
const FAKE_SIGNER = privateKeyToAccount("0x" + "ac".repeat(32)); // test-only local key, never funded
async function offlineSigned(txBody, nonce = 7, account = FAKE_SIGNER) {
  const raw = await account.signTransaction({
    type: "eip1559", chainId: 8453, nonce,
    to: txBody.to, data: txBody.data, value: BigInt(txBody.value),
    gas: BigInt(txBody.gas), maxFeePerGas: BigInt(txBody.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(txBody.maxPriorityFeePerGas),
  });
  return { raw, hash: keccak256(raw), nonce };
}

test("a wallet pending nonce must equal the confirmed nonce and stay unchanged until broadcast", () => {
  assert.equal(assertUncontendedNonce(0, 0), 0);
  assert.equal(assertUncontendedNonce(1234, 1234, 1234), 1234);
  for (const [latest, pending, expected] of [
    [0, 1, null], // someone else is waiting in the mempool
    [8, 9, 8], // signed while another sender took the next nonce
    [9, 9, 8], // mined while preparing, old signature cannot broadcast
    [10, 9, null], // inconsistent provider responses
    [-1, 0, null],
    [0, NaN, null],
    [0, 0, -1],
    [0, 0, 1],
    [1.5, 1.5, null],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1, null],
  ]) assert.throws(() => assertUncontendedNonce(latest, pending, expected), /nonce|unconfirmed/i);
});
test("pre-signed EIP-1559 authentication rejects any change to the intended transaction or signer", async () => {
  const txBody = swapTx(parseEther("0.0002")), signed = await offlineSigned(txBody);
  assert.equal(await verifySignedIntent(signed, txBody, "base", FAKE_SIGNER.address), true);
  for (const tamper of [
    { ...txBody, to: THIEF },
    { ...txBody, value: "0x1" },
    { ...txBody, maxFeePerGas: "0x1" },
    { ...txBody, gas: "0x1" },
    { ...txBody, data: "0x12345678" },
  ]) await assert.rejects(() => verifySignedIntent(signed, tamper, "base", FAKE_SIGNER.address), /differs from the exact guarded intent/);
  await assert.rejects(() => verifySignedIntent(signed, txBody, "arbitrum", FAKE_SIGNER.address), /differs from the exact guarded intent/);
  await assert.rejects(() => verifySignedIntent(signed, txBody, "base", ME), /differs from the exact guarded intent/);
  await assert.rejects(() => verifySignedIntent({ ...signed, nonce: 8 }, txBody, "base", FAKE_SIGNER.address), /differs from the exact guarded intent/);
  await assert.rejects(() => verifySignedIntent({ ...signed, hash: "0x" + "11".repeat(32) }, txBody, "base", FAKE_SIGNER.address), /invalid locally signed transaction hash/);
});

test("signed hash, nonce, exact raw bytes and budget are durable BEFORE the broadcast RPC", async () => {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  w.ctx.address = FAKE_SIGNER.address;
  let broadcasts = 0, expected = null;
  w.ctx.io.prepare = async (chain, candidate) => {
    assert.equal(chain, "base");
    expected = await offlineSigned(candidate);
    return expected;
  };
  w.ctx.io.broadcast = async (chain, serialized) => {
    broadcasts++;
    assert.equal(chain, "base");
    assert.equal(serialized, expected.raw, "the RPC can only see the persisted signed bytes");
    const state = w.home.state();
    assert.equal(state.pending.hash, expected.hash);
    assert.equal(state.pending.nonce, "7");
    assert.equal(state.pending.signedRaw, expected.raw);
    const rows = fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, "reserved");
    assert.equal(rows[0].hash, expected.hash);
    assert.equal(rows[0].nonce, "7");
    assert.equal(w.home.day(w.ctx.now()).spendWei, parseEther("0.0002"));
    return expected.hash;
  };
  assert.equal(await pass(w.ctx), 0);
  assert.equal(broadcasts, 1);
  assert.equal(w.sent.length, 0, "the unsigned high-level send path is never invoked");
  assert.equal(w.home.state().pending, undefined);
  assert.ok(w.home.state().eco?.at);
  assert.deepEqual(fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line).phase), ["reserved", "broadcast", "receipt"]);
});

test("lost broadcast reply retains original precomputed hash and prevents duplicate transactions", async () => {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  w.ctx.address = FAKE_SIGNER.address;
  let candidateHash = null, count = 0;
  w.ctx.io.prepare = async (_chain, txBody) => {
    const signed = await offlineSigned(txBody, 19); candidateHash = signed.hash; return signed;
  };
  w.ctx.io.broadcast = async () => { count++; throw new Error("RPC accepted raw bytes but reply was lost"); };
  assert.equal(await pass(w.ctx), 0);
  assert.equal(count, 1);
  assert.equal(w.home.state().pending.hash, candidateHash);
  assert.equal(w.home.state().pending.nonce, "19");
  assert.equal(w.home.day(w.ctx.now()).spendWei, parseEther("0.0002"));
  assert.equal(await pass(w.ctx), 0);
  assert.equal(count, 1, "no second broadcast even while the first result is unknown");
  const wrong = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  wrong.ctx.address = FAKE_SIGNER.address;
  wrong.ctx.io.prepare = async (_chain, txBody) => offlineSigned(txBody, 20);
  wrong.ctx.io.broadcast = async () => "0x" + "33".repeat(32);
  assert.equal(await pass(wrong.ctx), 4);
  assert.equal(wrong.home.state().pending.nonce, "20");
  assert.ok(wrong.home.state().pending.hash, "the expected hash remains available despite a lying RPC");
});
test("changing a signed pending hash, nonce or reservation is detected before recovery or spending", async () => {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  w.ctx.address = FAKE_SIGNER.address;
  w.ctx.io.prepare = async (_chain, txBody) => offlineSigned(txBody, 12);
  w.ctx.io.broadcast = async () => { throw new Error("RPC reply lost"); };
  assert.equal(await pass(w.ctx), 0);
  const pristine = w.home.state();
  assert.equal(pristine.pending.nonce, "12");
  const changedHash = structuredClone(pristine);
  changedHash.pending.hash = "0x" + "44".repeat(32);
  w.home.save(changedHash);
  assert.throws(() => w.home.state(), /no longer matches its exact hash/);
  w.home.save(pristine);
  const changedNonce = structuredClone(pristine);
  changedNonce.pending.nonce = "13";
  w.home.save(changedNonce);
  assert.throws(() => w.home.day(w.ctx.now()), /hash or nonce conflicts/);
  w.home.save(pristine);
  const raw = fs.readFileSync(w.home.files.ledger, "utf8");
  const row = JSON.parse(raw.trim());
  row.hash = "0x" + "55".repeat(32);
  fs.writeFileSync(w.home.files.ledger, JSON.stringify(row) + "\n");
  assert.throws(() => w.home.day(w.ctx.now()), /hash or nonce conflicts/);
});
test("the compact CLI archives complete old rows, keeps recent spend and audits the archived hashes", async () => {
  const dir = tmp(), home = openHome(dir);
  home.save({ walletAddress: ME, ledgerExpected: true });
  const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 3600_000).toISOString();
  for (const [id, at] of [["11".repeat(16), old], ["22".repeat(16), recent]]) {
    const hash = "0x" + id.repeat(2);
    home.record({ id, at, phase: "reserved", leg: "eco", name: "buy",
      chain: "base", hash: null, valueWei: "100", feeBoundWei: "10", kvcmUnits: "0", usdcUnits: "0" });
    home.record({ id, at, phase: "broadcast", leg: "eco", name: "buy",
      chain: "base", hash, valueWei: "0", feeBoundWei: "0", kvcmUnits: "0", usdcUnits: "0" });
    home.record({ id, at, phase: "receipt", leg: "eco", name: "buy",
      chain: "base", hash, status: "success", valueWei: "0", feeBoundWei: "0", kvcmUnits: "0", usdcUnits: "0" });
  }
  const log = console.log, error = console.error, output = [];
  console.log = (...args) => output.push(args.join(" "));
  console.error = () => {};
  try {
    assert.equal(parseArgs(["compact", "--home", dir]).cmd, "compact");
    assert.equal(await main(["compact", "--home", dir]), 0, "compact runs without wallet key or RPC");
    const compacted = JSON.parse(output.at(-1));
    assert.equal(compacted.archived, true);
    assert.equal(home.day(Date.now()).spendWei, 100n, "only recent spending stays in the active 24-hour journal");
    assert.equal(home.state().archives.length, 1);
    assert.equal(await main(["audit", "--home", dir]), 0);
    const audit = JSON.parse(output.at(-1));
    assert.equal(audit.archives.segments, 1);
    assert.equal(audit.rolling24Hours.spendWei, "100");
    assert.equal(await main(["compact", "--home", dir]), 0, "repeated compact has no duplicate archive effects");
    assert.equal(home.state().archives.length, 1);
  } finally { console.log = log; console.error = error; }
});

test("offline audit validates the same stopped-home journal without any private key or RPC", async () => {
  // `audit` reads the real clock, so the fixture must too: a fixed future date makes the guard
  // (rightly) refuse the row today, and makes the 24-hour total read zero once that date is past.
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"], nowMs: Date.now() });
  await pass(w.ctx);
  const log = console.log, error = console.error, output = [], errors = [];
  console.log = (...args) => output.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  try {
    assert.equal(await main(["audit", "--home", w.dir]), 0, errors.join(" | "));
    const audit = JSON.parse(output.at(-1));
    assert.equal(audit.wallet.toLowerCase(), ME.toLowerCase());
    assert.equal(audit.pending, null);
    assert.equal(audit.rolling24Hours.spendWei, String(parseEther("0.0002")));
    assert.ok(audit.ledgerBytes > 0);
    assert.equal(audit.schemaVersion, STORAGE_SCHEMA_VERSION);
    assert.equal(audit.ledgerSha256, await hashLocalFile(w.home.files.ledger));
    assert.equal(audit.stateSha256, await hashLocalFile(w.home.files.state));
    assert.equal(audit.ledgerSha256, createHash("sha256").update(fs.readFileSync(w.home.files.ledger)).digest("hex"));
    assert.match(audit.auditCommitment, /^[a-f0-9]{64}$/);
    assert.equal(audit.auditCommitment, createHash("sha256").update(JSON.stringify({
      schemaVersion: STORAGE_SCHEMA_VERSION, wallet: audit.wallet,
      ledgerSha256: audit.ledgerSha256, stateSha256: audit.stateSha256, archiveHead: audit.archives.root
    })).digest("hex"));
    const other = openHome(w.dir);
    assert.equal(other.lock(), true);
    try {
      assert.equal(await main(["audit", "--home", w.dir]), 2, "a concurrent auditor must not race the writer");
    } finally { other.unlock(); }
    assert.ok(errors.some((line) => /locked/.test(line)));
    fs.writeFileSync(w.home.files.ledger, "{broken\n");
    assert.equal(await main(["audit", "--home", w.dir]), 1, "corrupt history must fail rather than produce clean audit totals");
  } finally { console.log = log; console.error = error; }
});
test("a live send journals the reservation BEFORE its first RPC call", async () => {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  const original = w.ctx.io.send;
  let checked = 0;
  w.ctx.io.send = async (...args) => {
    checked++;
    const pending = w.home.state().pending;
    assert.ok(pending?.id && pending.hash === null);
    assert.equal(w.home.state().ledgerExpected, true);
    const rows = fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.at(-1).phase, "reserved");
    assert.equal(rows.at(-1).id, pending.id);
    assert.equal(BigInt(rows.at(-1).valueWei), parseEther("0.0002"));
    assert.equal(w.home.day(w.ctx.now()).spendWei, parseEther("0.0002"));
    return original(...args);
  };
  assert.equal(await pass(w.ctx), 0);
  assert.equal(checked, 1);
  assert.equal(w.home.state().pending, undefined);
  const rows = fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((r) => r.phase), ["reserved", "broadcast", "receipt"]);
  assert.ok(rows.every((r) => r.id === rows[0].id));
  assert.equal(w.home.day(w.ctx.now()).spendWei, parseEther("0.0002"));
});

test("lost RPC responses, invalid hashes and receipt timeouts never replay a reserved send", async () => {
  const args = ["--legs", "eco", "--eco-eth", "0.0002"];
  const badDisk = world({ live: true, args });
  badDisk.home.record = () => { throw new Error("simulated disk failure"); };
  await pass(badDisk.ctx);
  assert.equal(badDisk.sent.length, 0);
  // The state file kept the barrier, but the ledger row never landed. The bot must refuse to read the
  // home as healthy (it fails closed) rather than reset the day's caps; the owner reconciles it.
  const rawState = JSON.parse(fs.readFileSync(badDisk.home.files.state, "utf8"));
  assert.equal(rawState.pending.hash, null);
  assert.equal(rawState.ledgerExpected, true);
  assert.throws(() => badDisk.home.state(), /ledger is missing .* Nothing is sent until the owner reconciles it/);
  assert.throws(() => badDisk.home.day(badDisk.ctx.now()), /ledger/);
  await assert.rejects(() => pass(badDisk.ctx), /ledger is missing/, "a later pass on the same broken home refuses to run");
  assert.equal(badDisk.sent.length, 0);

  const lost = world({ live: true, args });
  lost.ctx.io.send = async () => { throw new Error("RPC response lost after broadcast"); };
  await pass(lost.ctx);
  assert.equal(lost.home.state().pending.hash, null);
  assert.equal(lost.home.day(lost.ctx.now()).spendWei, parseEther("0.0002"));
  assert.equal(await pass(lost.ctx), 0);
  assert.equal(lost.sent.length, 0);

  const malformed = world({ live: true, args });
  let tries = 0;
  malformed.ctx.io.send = async () => { tries++; return "not a transaction hash"; };
  await pass(malformed.ctx);
  assert.equal(malformed.home.state().pending.hash, null);
  assert.equal(await pass(malformed.ctx), 0);
  assert.equal(tries, 1);

  const timeout = world({ live: true, args });
  timeout.ctx.io.wait = async () => { throw new Error("receipt unavailable"); };
  await pass(timeout.ctx);
  assert.match(timeout.home.state().pending.hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(fs.readFileSync(timeout.home.files.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line).phase), ["reserved", "broadcast"]);
  assert.equal(await pass(timeout.ctx), 0);
  assert.equal(timeout.sent.length, 1);
  timeout.ctx.io.seen = async () => true;
  assert.equal(await pass(timeout.ctx), 0);
  assert.equal(timeout.home.state().pending, undefined);
  assert.equal(timeout.home.day(timeout.ctx.now()).spendWei, parseEther("0.0002"));
  assert.equal(timeout.sent.length, 1);
  assert.deepEqual(fs.readFileSync(timeout.home.files.ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line).phase), ["reserved", "broadcast", "reconciled"]);
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
  assert.ok(w.said.some((l) => /a send got no answer .* it may or may not have gone out\. Nothing more will be sent\..*do NOT delete pending without an audited reconciliation/.test(l)));
  // Clearing the JSON marker alone can NEVER remove an outstanding reservation.
  const s = w.home.state(); delete s.pending; w.home.save(s);
  await pass(w.ctx);
  assert.equal(w.sent.length, before, "an orphaned journal reservation blocks sends even after a manual pending deletion");
  assert.ok(w.said.some((l) => /journal has an unresolved send/.test(l)));
});

test("crash after finalized receipt but before saving completion cannot duplicate the purchase", async () => {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  const saved = w.home.save.bind(w.home);
  let crashed = false;
  w.home.save = (state) => {
    if (state.eco && !state.pending && !crashed) { crashed = true; throw new Error("power lost before final state write"); }
    return saved(state);
  };
  await pass(w.ctx);
  assert.equal(crashed, true);
  assert.equal(w.sent.length, 1);
  assert.ok(w.home.state().pending?.hash, "pending survives until the atomic completion checkpoint");
  const events = () => fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l).phase);
  assert.deepEqual(events(), ["reserved", "broadcast", "receipt"]);
  w.home.save = saved;
  w.ctx.io.seen = async () => true;
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.sent.length, 1, "recovered success is reflected in due state without re-sending");
  assert.ok(w.home.state().eco?.at, "confirmed completion is re-applied from the durable intent");
  assert.equal(w.home.state().pending, undefined);
  assert.deepEqual(events(), ["reserved", "broadcast", "receipt"], "a completed receipt needs no duplicate reconciliation event");
});

test("crash after recording reconciliation but before clearing pending is idempotent", async () => {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  w.ctx.io.wait = async () => { throw new Error("receipt timeout"); };
  await pass(w.ctx);
  assert.equal(w.sent.length, 1);
  w.ctx.io.seen = async () => true;
  const saved = w.home.save.bind(w.home);
  let failed = false;
  w.home.save = (state) => {
    if (!failed && !state.pending && state.eco?.at) { failed = true; throw new Error("power lost after reconciliation append"); }
    return saved(state);
  };
  await assert.rejects(() => pass(w.ctx), /power lost after reconciliation append/);
  assert.equal(failed, true);
  assert.ok(w.home.state().pending?.hash);
  w.home.save = saved;
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.sent.length, 1);
  assert.ok(w.home.state().eco?.at);
  const phases = fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l).phase);
  assert.deepEqual(phases, ["reserved", "broadcast", "reconciled"], "the same reconciliation event is never appended twice");
});
test("malformed or negative Base data-fee estimates never lower signing risk caps", async () => {
  for (const v of ["-999999999999999999999", "not-a-number", "0xnothex"]) {
    const bad = voteTx({ l1FeeBoundWei: v });
    assert.match(checkTx("hydrex", bad, caps), /data-fee bound is malformed or negative/);
    const w = world({ live: true, args: ["--legs", "hydrex"], answers: {
      "hydrex prepare claim": { code: 10, out: null },
      "hydrex prepare vote": { code: 0, out: { sendable: true, prepared: { tx: bad } } },
    } });
    assert.equal(await pass(w.ctx), 4);
    assert.equal(w.sent.length, 0, "a bad bound never reaches RPC");
    assert.equal(fs.existsSync(w.home.files.ledger), false);
  }
  assert.equal(checkTx("hydrex", voteTx({ l1FeeBoundWei: "3000" }), { ...caps, hydrexVote: POOL + ":10000" }), null, "a valid positive bound remains accepted");
});
test("daily kVCM and GMX USDC caps reserve actual asset amounts, not just ETH", async () => {
  const klima = world({ live: true, args: ["--legs", "klima"] });
  const retire = retirementTx(MAX_KVCM_APPROVE);
  assert.equal(await step(klima.ctx, "klima", "retire 1", retire, { klimaIntent: KLIMA_TEST_INTENT }), "sent");
  assert.equal(klima.home.day(klima.ctx.now()).kvcmUnits, MAX_KVCM_APPROVE);
  assert.equal(await step(klima.ctx, "klima", "retire 1 again", retire, { klimaIntent: KLIMA_TEST_INTENT }), "budget", "a second 100 kVCM retirement on the same day must be held");
  assert.equal(klima.sent.length, 1);
  assert.ok(klima.said.some((m) => /day\'s kVCM cap/.test(m)));
  const approval = tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, MAX_KVCM_APPROVE]));
  const separate = world({ live: true, args: ["--legs", "klima"] });
  assert.equal(await step(separate.ctx, "klima", "approve", approval), "sent");
  assert.equal(separate.home.day(separate.ctx.now()).kvcmUnits, 0n, "approval alone must not debit retirement budget");

  const gmx = world({ live: true, args: ["--legs", "gmx", "--gmx-market", "ETH", "--gmx-side", "long", "--gmx-collateral", "5", "--gmx-leverage", "2"] });
  const raw = kit.buildIncreaseTx({ from: ME, market: GMX_STARTER_MARKETS.ETH, isLong: true, collateralUnits: MAX_GMX_USDC, leverageTenths: 20n, acceptable: 1n, executionFee: 100n });
  const order = tx(raw.to, raw.data, { chainId: 42161, value: "0x64" });
  const intent = { action: "open", market: GMX_STARTER_MARKETS.ETH, isLong: true, collateralUnits: MAX_GMX_USDC, leverageTenths: 20n };
  assert.equal(await step(gmx.ctx, "gmx", "open first", order, { gmxIntent: intent }), "sent");
  assert.equal(gmx.home.day(gmx.ctx.now()).usdcUnits, MAX_GMX_USDC);
  assert.equal(await step(gmx.ctx, "gmx", "open again", order, { gmxIntent: intent }), "budget");
  assert.equal(gmx.sent.length, 1);
  assert.ok(gmx.said.some((m) => /day\'s GMX USDC cap/.test(m)));
  const rows = fs.readFileSync(gmx.home.files.ledger, "utf8").trim().split("\n").map((r) => JSON.parse(r));
  assert.deepEqual(rows.map((r) => r.phase), ["reserved", "broadcast", "receipt"]);
  assert.equal(rows[0].usdcUnits, String(MAX_GMX_USDC));
  assert.ok(rows.slice(1).every((r) => r.usdcUnits === "0"), "journal status events must not double-count USDC");
});
test("klima: approve, retire, take the approval back; gmx: open, hold, close", async () => {
  let klimaTurn = 0;
  const approve = tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, 10n ** 18n]));
  const retire = retirementTx();
  const k = world({ live: true, args: ["--legs", "klima", "--klima-class", POOL, "--klima-credit", POOL, "--klima-tonnes", "0.01", "--klima-name", "Test"], answers: {
    "klima prepare retire": () => ({ code: 0, out: { sendable: true, prepared: klimaTurn++ === 0 ? { step: "approve", tx: approve } : { step: "retire", tx: retire } } }),
    "klima prepare revoke": { code: 0, out: { sendable: true, prepared: { step: "revoke", tx: tx(ADDR.kvcm, call("approve", [ADDR.klimaAssetManager, 0n])) } } },
  } });
  assert.equal(await pass(k.ctx), 0);
  assert.ok(k.said.some((l) => /klima: As of 2026-11-18 EcoWealth holds a stake in Klima/.test(l)), "the klima leg says EcoWealth holds a stake in Klima");
  assert.deepEqual(k.sent.map((s) => s.sel), [SEL.approve, SEL.retireCreditViaKlima, SEL.approve]);
  assert.ok(k.home.state().klima.at);

  let open = false, turn = 0;
  const args = ["--legs", "gmx", "--gmx-market", "ETH", "--gmx-side", "long", "--gmx-collateral", "5", "--gmx-leverage", "2", "--gmx-hold-hours", "1"];
  const selectedMarket = GMX_STARTER_MARKETS.ETH;
  const kitOpenTx = kit.buildIncreaseTx({ from: ME, market: selectedMarket, isLong: true, collateralUnits: MAX_GMX_USDC, leverageTenths: 20n, acceptable: 1n, executionFee: 100n });
  const kitCloseTx = kit.buildDecreaseTx({ from: ME, market: selectedMarket, isLong: true, sizeInUsd: GMX_SIZE_2X, acceptable: 1n, executionFee: 100n });
  const answers = {
    "gmx orders": { code: 0, out: [] },
    "gmx positions": () => ({ code: 0, out: open ? [{ isLong: true, market: selectedMarket, collateralToken: ADDR.arbitrumUsdc, sizeInUsd: GMX_SIZE_2X }] : [] }),
    "gmx prepare open": () => ({ code: 0, out: { sendable: true, prepared: turn++ === 0 ? { step: "approve", tx: tx(ADDR.arbitrumUsdc, call("approve", [ADDR.gmxRouter, MAX_GMX_USDC]), { chainId: 42161 }) } : { step: "order", tx: tx(kitOpenTx.to, kitOpenTx.data, { chainId: 42161, value: "0x64" }) } } }),
    "gmx prepare close": { code: 0, out: { sendable: true, prepared: { tx: tx(kitCloseTx.to, kitCloseTx.data, { chainId: 42161, value: "0x64" }) } } },
  };
  const g = world({ live: true, args, answers });
  assert.equal(await pass(g.ctx), 0);
  assert.ok(g.said.some((l) => /gmx: As of 2026-11-18 EcoWealth holds a stake in GMX/.test(l)), "the gmx leg says EcoWealth holds a stake in GMX");
  assert.deepEqual(g.sent.map((s) => [s.chain, s.sel]), [["arbitrum", SEL.approve], ["arbitrum", SEL.multicall]]);
  open = true;
  await pass(g.ctx);
  assert.ok(g.home.state().gmx.positionObservedAt, "hold timer starts when the keeper-created position is first observed");
  assert.equal(g.sent.length, 2, "it holds until the hold time has passed");
  const laterSaid = [];
  const later = makeContext({ opts: g.ctx.opts, home: g.home, address: ME, io: g.ctx.io, kit: g.ctx.kit, say: (l) => laterSaid.push(l), now: () => Date.parse("2026-11-20T02:00:00Z") });
  assert.equal(await pass(later), 0, laterSaid.join(" | "));
  assert.equal(g.sent.length, 3);
  assert.ok(g.home.state().gmx.closeRequestedAt, "GMX keeper order is only submitted, not yet executed");
  assert.equal(g.home.state().gmx.closedAt, undefined, "onchain order receipt does not prove position closed");
  assert.equal(await pass(later), 4, `if a close order vanishes but the position remains, stop rather than abandon it: ${laterSaid.join(" | ")}`);
  assert.equal(g.sent.length, 3, "no duplicate close order is sent without reconciliation");
  const rebooted = makeContext({ opts: g.ctx.opts, home: g.home, address: ME, io: g.ctx.io, kit: g.ctx.kit, say: () => {}, now: () => Date.parse("2026-11-20T02:01:00Z") });
  assert.equal(await pass(rebooted), 4, "a restart cannot silently clear the unresolved keeper close");
  open = false;
  const executed = makeContext({ opts: g.ctx.opts, home: g.home, address: ME, io: g.ctx.io, kit: g.ctx.kit, say: () => {}, now: () => Date.parse("2026-11-20T02:02:00Z") });
  assert.equal(await pass(executed), 0);
  assert.ok(g.home.state().gmx.closedAt, "closure is recorded only after the position disappears");
  assert.equal(g.sent.length, 3);
  // A position this bot did not open is never touched.
  open = true;
  const foreign = world({ live: true, args, answers });
  await pass(foreign.ctx);
  assert.equal(foreign.sent.length, 0);
});

test("a delayed GMX keeper cannot silently consume the owner selected hold period", async () => {
  const args = ["--legs", "gmx", "--gmx-market", "ETH", "--gmx-side", "long", "--gmx-collateral", "5", "--gmx-leverage", "2", "--gmx-hold-hours", "1"];
  const market = GMX_STARTER_MARKETS.ETH;
  const close = kit.buildDecreaseTx({ from: ME, market, isLong: true, sizeInUsd: GMX_SIZE_2X, acceptable: 1n, executionFee: 100n });
  let queued = true;
  const w = world({ live: true, args, answers: {
    "gmx orders": () => ({ code: 0, out: queued ? [{ orderKey: "fake-pending" }] : [] }),
    "gmx positions": { code: 0, out: [{ isLong: true, market, collateralToken: ADDR.arbitrumUsdc, sizeInUsd: GMX_SIZE_2X }] },
    "gmx prepare close": { code: 0, out: { sendable: true, prepared: { tx: tx(close.to, close.data, { chainId: 42161, value: "0x64" }) } } },
  } });
  const submittedAt = Date.parse("2026-11-20T00:00:00Z");
  w.home.save({ gmx: { openedAt: new Date(submittedAt).toISOString() } });
  const withTime = (hours) => makeContext({ opts: w.ctx.opts, home: w.home, address: ME, io: w.ctx.io, kit: w.ctx.kit, say: w.ctx.say, now: () => submittedAt + hours * 3600_000 });
  assert.equal(await pass(withTime(4)), 0);
  assert.equal(w.sent.length, 0, "an unexecuted order remains queued");
  queued = false;
  assert.equal(await pass(withTime(5)), 0);
  assert.equal(w.home.state().gmx.positionObservedAt, new Date(submittedAt + 5 * 3600_000).toISOString());
  assert.equal(w.sent.length, 0, "first observation starts a new hold, never sends a close immediately");
  assert.equal(await pass(withTime(5.5)), 0);
  assert.equal(w.sent.length, 0, "still inside the owner held hour");
  assert.equal(await pass(withTime(6.1)), 0);
  assert.equal(w.sent.length, 1, "the close order is submitted only after a true observed hour");
  assert.ok(w.home.state().gmx.closeRequestedAt);
  assert.equal(w.home.state().gmx.closedAt, undefined);
});
test("GMX refuses mislabeled kit acts, altered approvals, and missing owner intent without sending", async () => {
  const args = ["--legs", "gmx", "--gmx-market", "ETH", "--gmx-side", "long", "--gmx-collateral", "1", "--gmx-leverage", "2"];
  const built = kit.buildIncreaseTx({ from: ME, market: GMX_STARTER_MARKETS.ETH, isLong: true,
    collateralUnits: 1_000_000n, leverageTenths: 20n, acceptable: 1n, executionFee: 100n });
  const orderTx = tx(built.to, built.data, { chainId: 42161, value: "0x64" });
  const approval = (amount) => tx(ADDR.arbitrumUsdc, call("approve", [ADDR.gmxRouter, amount]), { chainId: 42161 });
  const cases = [
    ["unknown kit step", { step: "mystery", tx: orderTx }, /unrecognized open step/],
    ["order falsely labeled approval", { step: "approve", tx: orderTx }, /step name does not match/],
    ["approval falsely labeled order", { step: "order", tx: approval(1_000_000n) }, /step name does not match/],
    ["approval exceeds owner's exact 1 USDC", { step: "approve", tx: approval(5_000_000n) }, /exact collateral size/],
  ];
  for (const [label, prepared, why] of cases) {
    const w = world({ live: true, args, answers: {
      "gmx orders": { code: 0, out: [] },
      "gmx positions": { code: 0, out: [] },
      "gmx prepare open": { code: 0, out: { sendable: true, prepared } },
    } });
    assert.equal(await pass(w.ctx), 4, label);
    assert.equal(w.sent.length, 0, label);
    assert.ok(w.said.some((line) => why.test(line)), label);
    assert.equal(w.home.state().pending, undefined, label);
  }
  const direct = world({ live: true, args });
  await assert.rejects(() => step(direct.ctx, "gmx", "unlabeled order", orderTx), /explicit owner intent/);
  assert.equal(direct.sent.length, 0);
});

test("the key never reaches a kit's command line, and GuardError is what a refusal throws", async () => {
  const w = world({ live: true, args: ["--eco-eth", "0.0002"] });
  await pass(w.ctx);
  for (const c of w.calls) assert.ok(!/0x[0-9a-fA-F]{64}/.test(c), "no 32-byte secret in any kit argument");
  assert.ok(new GuardError("x") instanceof Error);
});

// ---- the regen-retire leg: it asks the kit for the Regen Ledger retirement message and prints it. It signs nothing. -----
const REGEN_ME = `regen1${"q".repeat(38)}`;
const REGEN_OTHER = `regen1${"p".repeat(38)}`;
const BATCH = "C01-001-20150101-20151231-001";
const RETIRE_ARGS = ["--regen-retire-owner", REGEN_ME, "--regen-retire-batch", BATCH, "--regen-retire-amount", "1.5", "--regen-retire-jurisdiction", "US-CA", "--regen-retire-reason", "retired by my bot"];
const RETIRE_FLAGS = { regenRetireOwner: REGEN_ME, regenRetireBatch: BATCH, regenRetireAmount: "1.5", regenRetireJurisdiction: "US-CA", regenRetireReason: "retired by my bot" };
// The pretend kit answers with the message the real kit's own builder makes, so the leg is held against what the kit really prints.
const RETIRE_MSG = kit.buildRetireMessage({ owner: REGEN_ME, batchDenom: BATCH, amount: "1.5", jurisdiction: "US-CA", reason: "retired by my bot" });
const retireAnswer = (message = RETIRE_MSG) => ({ code: 0, out: { sendable: true, prepared: { sendable: true, reason: null, chainId: "regen-1", message, note: "sign with your own Regen Ledger tooling" } } });
const WOULD_SIGN = "regen-retire: DRY, would sign this Regen message: ";

test("regen-retire signs nothing: it has no rule list, and the gate refuses any step named for it", () => {
  assert.ok(LEG_ORDER.includes("regen-retire"));
  assert.deepEqual(UNSIGNED_LEGS, ["regen-retire"]);
  assert.equal(RULES["regen-retire"], undefined, "the RULES list is untouched: this leg adds no contract call");
  assert.match(checkTx("regen-retire", voteTx(), caps), /no rules/);
  assert.match(checkTx("regen-retire", swapTx(1000n), { ...caps, sizeWei: 1000n }), /no rules/);
  assert.match(listText(), /regen-retire +signs nothing/);
  assert.match(HELP, /--regen-retire-owner/);
  assert.match(HELP, /never signs/);
  assert.equal(REGEN_RETIRE_TYPE_URL, "/regen.ecocredit.v1.MsgRetire");
});

test("regen-retire flags are the kit's own patterns, plain words only, and every one starts unset", () => {
  const off = parseArgs(["once", "--address", ME], {});
  for (const k of Object.keys(RETIRE_FLAGS)) assert.equal(off[k], undefined, k);
  assert.equal(off.regenLcd, undefined);
  const on = parseArgs(["once", "--address", ME, ...RETIRE_ARGS, "--regen-lcd", "https://lcd.example.org"], {});
  for (const [k, v] of Object.entries(RETIRE_FLAGS)) assert.equal(on[k], v, k);
  assert.equal(on.regenLcd, "https://lcd.example.org");
  assert.equal(REGEN_RETIRE_RE.owner.source, kit.REGEN_ADDRESS.source);
  assert.equal(REGEN_RETIRE_RE.batch.source, kit.BATCH_DENOM.source);
  assert.equal(REGEN_RETIRE_RE.jurisdiction.source, kit.JURISDICTION.source);
  // The amount is accepted or refused exactly as the kit would, so a flag the bot takes is never one the kit then rejects.
  for (const a of ["1", "0.000001", "12.5", "0", "0.0000001", "01", "-1", "1e3", "1.", ".5", "99999999999999999999", "123456789012345678"]) {
    let kitOk = true; try { kit.buildRetireMessage({ owner: REGEN_ME, batchDenom: BATCH, amount: a, jurisdiction: "US", reason: "x" }); } catch { kitOk = false; }
    let botOk = true; try { parseArgs(["once", "--address", ME, ...RETIRE_ARGS, "--regen-retire-amount", a], {}); } catch { botOk = false; }
    assert.equal(botOk, kitOk, `amount ${a}`);
  }
  for (const [flag, bad] of [["owner", "regen1abc"], ["owner", REGEN_ME.toUpperCase()], ["batch", "C01-1"], ["jurisdiction", "california"], ["reason", "--json"], ["reason", "-x"], ["reason", "a".repeat(201)], ["reason", "café"], ["reason", "two  spaces"], ["reason", ""]]) {
    assert.throws(() => parseArgs(["once", "--address", ME, ...RETIRE_ARGS, `--regen-retire-${flag}`, bad], {}), ArgError, `${flag} ${JSON.stringify(bad)}`);
  }
  for (const lcd of ["http://lcd.example.org", "https://user:pw@lcd.example.org", "not a url"]) assert.throws(() => parseArgs(["once", "--address", ME, "--regen-lcd", lcd], {}), ArgError, lcd);
  assert.doesNotThrow(() => parseArgs(["once", "--address", ME, "--regen-retire-reason", "a".repeat(200)], {}));
});

test("checkRegenRetire passes exactly the message the kit builds from the flags, and nothing else", () => {
  assert.equal(checkRegenRetire(RETIRE_MSG, RETIRE_FLAGS), null);
  const v = RETIRE_MSG.value;
  const cases = [
    [null, /no message/], ["x", /no message/], [[], /no message/],
    [{ ...RETIRE_MSG, typeUrl: "/cosmos.bank.v1beta1.MsgSend" }, /not a retirement/],
    [{ ...RETIRE_MSG, extra: 1 }, /unexpected field/],
    [{ ...RETIRE_MSG, value: { ...v, extra: 1 } }, /unexpected field/],
    [{ ...RETIRE_MSG, value: { ...v, owner: REGEN_OTHER } }, /owner/],
    [{ ...RETIRE_MSG, value: { ...v, jurisdiction: "US" } }, /jurisdiction/],
    [{ ...RETIRE_MSG, value: { ...v, reason: "other" } }, /reason/],
    [{ ...RETIRE_MSG, value: { ...v, credits: [] } }, /credits/],
    [{ ...RETIRE_MSG, value: { ...v, credits: [...v.credits, ...v.credits] } }, /credits/],
    [{ ...RETIRE_MSG, value: { ...v, credits: [{ batch_denom: BATCH, amount: "2" }] } }, /credits/],
    [{ ...RETIRE_MSG, value: { ...v, credits: [{ batch_denom: "C01-001-20150101-20151231-002", amount: "1.5" }] } }, /credits/],
    [{ ...RETIRE_MSG, value: { ...v, credits: [{ ...v.credits[0], extra: 1 }] } }, /credits/],
  ];
  for (const [m, why] of cases) assert.match(checkRegenRetire(m, RETIRE_FLAGS) ?? "passed", why);
});

test("regen-retire is off by default: no kit call, one plain line, and partial flags say what is missing", async () => {
  const w = world({ args: ["--legs", "regen-retire"] });
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.calls.length, 0);
  assert.ok(w.said.some((l) => /^regen-retire: off \(set --regen-retire-owner/.test(l)), w.said.join(" | "));
  const part = world({ args: ["--legs", "regen-retire", "--regen-retire-owner", REGEN_ME, "--regen-retire-batch", BATCH] });
  assert.equal(await pass(part.ctx), 0);
  assert.equal(part.calls.length, 0);
  assert.ok(part.said.some((l) => /^regen-retire: off .*--regen-retire-amount.*--regen-retire-jurisdiction.*--regen-retire-reason/.test(l)), part.said.join(" | "));
  // Inside the whole loop, with every other leg on and no retire flags, it still asks the kit nothing.
  const all = world({ args: ["--eco-eth", "0.0002", "--regen-eth", "0.0002", "--circle-eth", "0.0001"] });
  assert.equal(await pass(all.ctx), 0);
  assert.ok(!all.calls.some((c) => c.startsWith("regen prepare retire")));
  assert.ok(all.said.some((l) => /^regen-retire: off/.test(l)));
});

test("regen-retire with its flags asks the kit for the message and prints it DRY, saying plainly that signing is a separate step", async () => {
  const w = world({ args: ["--legs", "regen-retire", ...RETIRE_ARGS], answers: { "regen prepare retire": retireAnswer() } });
  assert.equal(await pass(w.ctx), 0);
  assert.deepEqual(w.calls, [`regen prepare retire --owner ${REGEN_ME} --batch ${BATCH} --amount 1.5 --jurisdiction US-CA --reason retired by my bot`]);
  const line = w.said.find((l) => l.startsWith(WOULD_SIGN));
  assert.ok(line, w.said.join(" | "));
  assert.deepEqual(JSON.parse(line.slice(WOULD_SIGN.length)), RETIRE_MSG);
  const said = w.said.join("\n");
  assert.match(said, /sink: what it retires is gone for good, by design/);
  assert.match(said, /no return promised/);
  assert.match(said, /regen-retire: As of 2026-11-18 EcoWealth holds REGEN and may gain if it rises/);
  assert.match(said, /written onchain, public and permanent/);
  assert.match(said, /signs no Regen message, with or without --live, and sends nothing/);
  assert.match(said, /Signing it is a separate step you do with your own Regen wallet/);
  assert.equal(w.sent.length, 0);
  assert.equal(fs.existsSync(w.home.files.ledger), false);
  assert.equal(fs.existsSync(w.home.files.state), false, "the leg keeps no state");
  // --regen-lcd reaches the kit as its own --lcd flag, and nowhere else.
  const lcd = world({ args: ["--legs", "regen-retire", ...RETIRE_ARGS, "--regen-lcd", "https://lcd.example.org"], answers: { "regen prepare retire": retireAnswer() } });
  await pass(lcd.ctx);
  assert.ok(lcd.calls[0].endsWith("--lcd https://lcd.example.org"), lcd.calls[0]);
});

test("regen-retire sends nothing even with --live, never touches the chain, and adds no send to the loop", async () => {
  const solo = world({ live: true, args: ["--legs", "regen-retire", ...RETIRE_ARGS], answers: { "regen prepare retire": retireAnswer() } });
  const trap = () => { throw new Error("regen-retire reached for the chain"); };
  solo.ctx.io = { send: trap, wait: trap, seen: trap };
  assert.equal(await pass(solo.ctx), 0);
  assert.ok(solo.said.some((l) => l.startsWith(WOULD_SIGN)), "under --live it still prints, and only prints");
  assert.equal(solo.sent.length, 0);
  assert.equal(fs.existsSync(solo.home.files.ledger), false);
  assert.equal(fs.existsSync(solo.home.files.state), false);
  // Beside every other leg the sends are exactly what they were without it, and the ledger and the pending lock are not its business.
  const base = ["--eco-eth", "0.0002", "--regen-eth", "0.0002", "--circle-eth", "0.0001"];
  const without = world({ live: true, args: base });
  const withLeg = world({ live: true, args: [...base, ...RETIRE_ARGS], answers: { "regen prepare retire": retireAnswer() } });
  assert.equal(await pass(without.ctx), 0);
  assert.equal(await pass(withLeg.ctx), 0);
  assert.deepEqual(withLeg.sent, without.sent);
  assert.deepEqual(withLeg.sent.map((s) => s.sel), [SEL.claimFees, SEL.claimBribes, SEL.vote, SEL.execute, SEL.execute, SEL.execute]);
  assert.ok(withLeg.said.some((l) => l.startsWith(WOULD_SIGN)));
  assert.equal(fs.readFileSync(withLeg.home.files.ledger, "utf8").trim().split("\n").length, 18);
  assert.ok(!JSON.stringify(withLeg.home.state()).includes("regen-retire"));
  assert.equal(withLeg.home.state().pending, undefined);
});

test("regen-retire stops cleanly when the kit cannot prepare: a plain line, and every other leg goes on", async () => {
  const cannot = { code: 10, out: { sendable: false, prepared: { sendable: false, reason: "the account holds 0.5 tradable credits of that batch, less than 1.5" } } };
  const none = world({ live: true, args: ["--eco-eth", "0.0002", ...RETIRE_ARGS], answers: { "regen prepare retire": cannot } });
  assert.equal(await pass(none.ctx), 0);
  assert.ok(none.said.some((l) => /^regen-retire: prepare: nothing to do now \(the account holds 0\.5 tradable credits/.test(l)), none.said.join(" | "));
  assert.ok(!none.said.some((l) => /would sign this Regen message/.test(l)));
  assert.ok(none.sent.some((s) => s.sel === SEL.execute), "the eco leg after it still went on");
  // A copy of the kit with no retire act, or a kit that fails, stops this leg only.
  const old = world({ live: true, args: ["--eco-eth", "0.0002", ...RETIRE_ARGS], answers: { "regen prepare retire": { code: 2, out: null, err: "unknown act" } } });
  assert.equal(await pass(old.ctx), 1);
  assert.ok(old.said.some((l) => /^regen-retire: STOPPED: prepare stopped with exit 2/.test(l)), old.said.join(" | "));
  assert.ok(old.sent.some((s) => s.sel === SEL.execute));
  assert.equal(await pass(old.ctx), 1, "a stopped leg stays stopped");
  // A failed read counts like any leg's: three in a row stop it.
  const down = world({ args: ["--legs", "regen-retire", ...RETIRE_ARGS], answers: { "regen prepare retire": { code: 1, out: null, err: "lcd down" } } });
  assert.equal(await pass(down.ctx), 0);
  await pass(down.ctx);
  assert.equal(await pass(down.ctx), 1);
  assert.equal(down.sent.length, 0);
  // A kit that says yes and prints no message is a failed read, never a printed line.
  const empty = world({ args: ["--legs", "regen-retire", ...RETIRE_ARGS], answers: { "regen prepare retire": { code: 0, out: { sendable: true, prepared: { sendable: true } } } } });
  assert.equal(await pass(empty.ctx), 0);
  assert.ok(empty.said.some((l) => /^regen-retire: prepare: the kit printed no retirement message/.test(l)), empty.said.join(" | "));
  assert.ok(!empty.said.some((l) => /would sign/.test(l)));
});

test("regen-retire prints only the retirement it was asked for: any other message is refused and never shown", async () => {
  const send = { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { from_address: REGEN_ME, to_address: REGEN_OTHER, amount: [{ denom: "uregen", amount: "1000000" }] } };
  const other = { ...RETIRE_MSG, value: { ...RETIRE_MSG.value, owner: REGEN_OTHER } };
  for (const message of [send, other]) {
    const w = world({ live: true, args: ["--eco-eth", "0.0002", ...RETIRE_ARGS], answers: { "regen prepare retire": retireAnswer(message) } });
    assert.equal(await pass(w.ctx), 4);
    assert.ok(w.said.some((l) => /^regen-retire: STOPPED: regen-retire: refused the kit's message/.test(l)), w.said.join(" | "));
    assert.ok(!w.said.some((l) => /would sign/.test(l)));
    assert.ok(!w.said.join("\n").includes(REGEN_OTHER) && !w.said.join("\n").includes("MsgSend"), "nothing from the refused message is printed");
    assert.ok(w.sent.some((s) => s.sel === SEL.execute), "the other legs go on");
  }
});

test("regen-retire with STOP set does not even call the kit, at the start of a pass or inside the leg", async () => {
  const w = world({ args: ["--legs", "regen-retire", ...RETIRE_ARGS], answers: { "regen prepare retire": retireAnswer() } });
  fs.writeFileSync(w.home.files.stop, "");
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.calls.length, 0);
  // STOP can appear after a pass began (an earlier leg was slow): the leg checks it itself before it asks.
  await LEGS["regen-retire"](w.ctx);
  assert.equal(w.calls.length, 0);
  assert.ok(w.said.some((l) => /^regen-retire: STOP is set, so the kit was not asked/.test(l)), w.said.join(" | "));
  assert.ok(!w.said.some((l) => /would sign/.test(l)));
  fs.rmSync(w.home.files.stop);
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.calls.length, 1, "with STOP gone it asks again");
});

test("regen-retire never reads a key file, hands the kit no key, and has no signing code of its own", async () => {
  const dir = tmp(), keyFile = path.join(dir, "wallet.key"), marker = `0x${"ab".repeat(32)}`;
  fs.writeFileSync(keyFile, `${marker}\n`, { mode: 0o600 });
  const w = world({ live: true, args: ["--legs", "regen-retire", "--key-file", keyFile, ...RETIRE_ARGS], answers: { "regen prepare retire": retireAnswer() } });
  assert.equal(w.ctx.opts.keyFile, keyFile);
  // Watch every file call that names a path while the leg runs: the key file must never be one of them.
  const touched = [], originals = {};
  const names = ["readFileSync", "openSync", "createReadStream", "readFile", "lstatSync", "statSync", "existsSync", "accessSync"];
  for (const n of names) { originals[n] = fs[n]; fs[n] = function spy(...args) { touched.push(String(args[0])); return originals[n].apply(this, args); }; }
  try { assert.equal(await pass(w.ctx), 0); } finally { for (const n of names) fs[n] = originals[n]; }
  assert.ok(touched.length > 0, "the watch saw the pass's own reads (the STOP file and the state)");
  assert.ok(!touched.some((p) => p === keyFile || /\.key$/.test(p)), `no read of the key file: ${touched.join(", ")}`);
  assert.ok(w.said.some((l) => l.startsWith(WOULD_SIGN)));
  for (const c of w.calls) { assert.ok(!c.includes(marker)); assert.ok(!/key|wallet\.key/i.test(c), "no key word in a kit argument"); }
  // The leg's own code names no key, no signer and no chain send.
  const own = LEGS["regen-retire"].toString();
  for (const word of ["loadAccount", "makeWallet", "keyFile", "readFileSync", "ctx.io", "step(", "privateKey", "account", "sign("]) assert.ok(!own.includes(word), `the leg names ${word}`);
});

test("the bot gains no Regen or Cosmos signer: the same imports as before, and viem is still its one dependency", () => {
  const src = fs.readFileSync(path.join(HERE, "bot.mjs"), "utf8");
  const mods = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
  // the one local file it may import is the archive helper that ships beside it (named in package.json "files"); no other local file, no new package
  assert.deepEqual(mods, ["./journal-archive.mjs", "node:child_process", "node:crypto", "node:fs", "node:os", "node:path", "node:url", "viem", "viem/accounts", "viem/chains"]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).files.includes("journal-archive.mjs"), "the archive helper is shipped with the package");
  assert.ok(!/\bimport\s*\(/.test(src) && !/\brequire\s*\(/.test(src), "no dynamic import or require");
  const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies), ["viem"]);
});

// ---- the NET circle kit's one-way buy: the eco-buy and net-buy legs --------------------------------------------------
/** A buy as the circle kit itself encodes it, wrapped in the step fields a kit prints. */
const buyTx = (token, routeId, value, over) => {
  const route = circle.BUY_ROUTES[token].find((r) => r.id === routeId);
  const b = circle.buildBuyTx({ token, route, pools: CIRCLE_POOLS, amountInWei: value, minOutWei: 5n, deadline: 2_000_000_000n });
  return tx(b.to, b.data, { value: hex(value), ...over });
};
const sweepTok = (recipient, token, floor = 5n) => [ROUTER_CMD.SWEEP, enc("address, address, uint256", [token, recipient, floor])];
const nativeHop = (amount = 1000n, recipient = ADDRESS_THIS) => [ROUTER_CMD.V4_SWAP, v4([settle(NATIVE, amount), swapAct, take(recipient)])];
const laterHop = (amount = CONTRACT_BALANCE) => [ROUTER_CMD.V4_SWAP, v4([settle(POOL, amount), swapAct, take(ADDRESS_THIS)])];
const wrap = (amount = 1000n, recipient = ADDRESS_THIS) => [ROUTER_CMD.WRAP_ETH, enc("address, uint256", [recipient, amount])];
const v3Hop = (amount = 1000n, recipient = ADDRESS_THIS, payerIsUser = false) => [ROUTER_CMD.V3_SWAP_EXACT_IN, enc("address, uint256, uint256, bytes, bool", [recipient, amount, 0n, "0x", payerIsUser])];
const nativeHopWeth = () => laterHop(CONTRACT_BALANCE);
const SIZE_1000 = { ...caps, sizeWei: 1000n };
const preparedBuySteps = (token, route) => {
  const decoded = decodeFunctionData({ abi: ABI.execute, data: buyTx(token, route, 1000n).data });
  const bytes = decoded.args[0].slice(2).match(/../g).map((x) => parseInt(x, 16));
  return bytes.map((cmd, i) => [cmd, decoded.args[1][i]]);
};
const alterPreparedBuy = (token, route, mutate) => {
  const steps = preparedBuySteps(token, route);
  mutate(steps);
  return router(steps);
};
const editV4 = (steps, index, edit) => {
  const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), steps[index][1]);
  const changed = [...params];
  edit(changed);
  steps[index] = [ROUTER_CMD.V4_SWAP, enc("bytes, bytes[]", [actions, changed])];
};
const editV3 = (steps, index, edit) => {
  const args = [...decodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), steps[index][1])];
  edit(args);
  steps[index] = [ROUTER_CMD.V3_SWAP_EXACT_IN, enc("address, uint256, uint256, bytes, bool", args)];
};

test("the buy legs: the pinned tokens are the kit's own, and the gate passes every route the kit builds, only for its own token", () => {
  assert.equal(ADDR.net, circle.TOKENS.NET);
  assert.equal(ADDR.eco, circle.TOKENS.ECO);
  assert.equal(CONTRACT_BALANCE, circle.CONTRACT_BALANCE);
  for (const [token, leg, other] of [["NET", "net-buy", "eco-buy"], ["ECO", "eco-buy", "net-buy"]]) {
    for (const route of circle.BUY_ROUTES[token]) {
      const t = buyTx(token, route.id, 1000n);
      assert.equal(checkTx(leg, t, SIZE_1000), null, `${leg} ${route.id}`);
      assert.match(checkTx(other, t, SIZE_1000), /must end in the token this leg buys/, `${other} refuses ${route.id}`);
    }
  }
  assert.match(checkTx("eco", buyTx("ECO", "WETH>NET>ECO", 1000n), SIZE_1000), /not on the list|one v4 swap/, "the old eco leg never took the new shape");
});

test("the buy gate refuses everything but ETH in, one token out, to you, with a floor", () => {
  const net = (steps, value = 1000n) => checkTx("net-buy", router(steps, value), { ...caps, sizeWei: 1000n });
  const good = preparedBuySteps("NET", "ETH>NET");
  assert.equal(net(good), null);
  assert.equal(net(preparedBuySteps("NET", "WETH>NET")), null, "a wrapped start: the first hop settles the wrapped amount");
  const eco = (steps) => checkTx("eco-buy", router(steps), SIZE_1000);
  assert.equal(eco(preparedBuySteps("ECO", "ETH>NET>ECO")), null, "a second hop spends the router's balance");
  assert.equal(eco(preparedBuySteps("ECO", "WETH>ZORA>ECO")), null, "a v3 first hop after a wrap");
  // where the token goes
  assert.match(net([nativeHop(), sweepTok(THIEF, ADDR.net)]), /not yours/);
  assert.match(net([nativeHop(), sweepTok(MSG_SENDER, ADDR.net, 0n)]), /no floor/);
  assert.match(net([nativeHop(), sweepTok(MSG_SENDER, ADDR.eco)]), /must end in the token this leg buys/);
  assert.match(net([nativeHop(), sweepTok(MSG_SENDER, NATIVE)]), /must end in the token this leg buys/);
  assert.match(net([nativeHop(1000n, ME), sweepTok(MSG_SENDER, ADDR.net)]), /pay out to the router/);
  assert.match(net([nativeHop(1000n, THIEF), sweepTok(MSG_SENDER, ADDR.net)]), /pay out to the router/);
  // the shape of the call
  assert.match(net([sweepTok(ME, ADDR.net)]), /do not line up/);
  assert.match(net([nativeHop(), nativeHop()]), /must end by sweeping/);
  assert.match(net([nativeHop(), sweepTok(ME, ADDR.net), nativeHop()]), /must end by sweeping/);
  assert.match(net([nativeHop(), sweep(ME), sweepTok(ME, ADDR.net)]), /command that is not on the list \(0x04\)/);
  assert.match(net([nativeHop(), [ROUTER_CMD.UNWRAP_WETH, enc("address, uint256", [ME, 1n])], sweepTok(ME, ADDR.net)]), /command that is not on the list \(0x0c\)/);
  assert.match(net([[0x0a, "0x"], nativeHop(), sweepTok(ME, ADDR.net)]), /command that is not on the list \(0x0a\)/);
  assert.match(net([[ROUTER_CMD.V4_SWAP, v4([settle(NATIVE, 1000n), swapAct])], sweepTok(ME, ADDR.net)]), /exactly settle, swap, take/);
  assert.match(net([wrap(), sweepTok(ME, ADDR.net)]), /must hold a swap/);
  // what it spends
  assert.match(net([nativeHop(999n), sweepTok(ME, ADDR.net)]), /exactly the ETH the step carries/);
  assert.match(net([[ROUTER_CMD.V4_SWAP, v4([settle(NATIVE, 1000n, true), swapAct, take(ADDRESS_THIS)])], sweepTok(ME, ADDR.net)]), /pull a token from your wallet/);
  assert.match(net([wrap(999n), laterHop(999n), sweepTok(ME, ADDR.net)]), /wrap exactly the ETH/);
  assert.match(net([wrap(1001n), laterHop(1001n), sweepTok(ME, ADDR.net)]), /wrap exactly the ETH/);
  assert.match(net([wrap(1000n, THIEF), laterHop(1000n), sweepTok(ME, ADDR.net)]), /not the router/);
  assert.match(net([nativeHop(), wrap(), sweepTok(ME, ADDR.net)]), /only at its start/);
  assert.match(net([wrap(), nativeHop(), sweepTok(ME, ADDR.net)]), /must spend what the step started with/);
  assert.match(net([[ROUTER_CMD.V4_SWAP, v4([settle(POOL, 1000n), swapAct, take(ADDRESS_THIS)])], sweepTok(ME, ADDR.net)]), /must spend what the step started with/);
  assert.match(net([nativeHop(), laterHop(5n), sweepTok(ME, ADDR.net)]), /spend the router's balance, nothing else/);
  assert.match(net([v3Hop(), sweepTok(ME, ADDR.net)]), /cannot spend native ETH/);
  assert.match(net([wrap(), v3Hop(1000n, THIEF), sweepTok(ME, ADDR.net)]), /pay out to the router/);
  assert.match(net([wrap(), v3Hop(1000n, ADDRESS_THIS, true), sweepTok(ME, ADDR.net)]), /pull a token from your wallet/);
  assert.match(net([wrap(), v3Hop(999n), sweepTok(ME, ADDR.net)]), /exactly the ETH the step carries/);
  assert.match(net([wrap(), laterHop(1000n), v3Hop(7n), sweepTok(ME, ADDR.net)]), /spend the router's balance, nothing else/);
  // the size rules every swap leg has
  assert.match(net(good, 1001n), /above/);
  assert.match(checkTx("net-buy", router(good, 1000n), caps), /no size set/);
  assert.match(checkTx("net-buy", voteTx(), SIZE_1000), /not on the list/);
});

test("the buy gate decodes the complete permitted route: unknown pools, diverted outputs and mismatched inputs are refused", () => {
  const net = (t) => checkTx("net-buy", t, SIZE_1000);
  const eco = (t) => checkTx("eco-buy", t, SIZE_1000);
  // The kit's six concrete routes, including its Zora hook, remain valid.
  for (const [token, id, check] of [
    ...circle.BUY_ROUTES.NET.map((r) => ["NET", r.id, net]),
    ...circle.BUY_ROUTES.ECO.map((r) => ["ECO", r.id, eco]),
  ]) assert.equal(check(buyTx(token, id, 1000n)), null, id);

  const mutateV4 = (token, route, index, position, types, transform) => alterPreparedBuy(token, route, (steps) => {
    editV4(steps, index, (params) => {
      const args = [...decodeAbiParameters(parseAbiParameters(types), params[position])];
      transform(args);
      params[position] = enc(types, args);
    });
  });
  assert.match(net(mutateV4("NET", "ETH>NET", 0, 0, "address, uint256, bool", (a) => { a[0] = ADDR.eco; })), /different input token|must spend what the step started with/);
  assert.match(net(mutateV4("NET", "ETH>NET", 0, 1, "(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", (a) => {
    a[0] = [ADDR.eco, a[0][1], a[0][2], a[0][3]];
  })), /different input token|must spend what the step started with/);
  assert.match(net(mutateV4("NET", "ETH>NET", 0, 1, "(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", (a) => {
    a[0] = [a[0][0], [[ADDR.net, 500n, 1, NATIVE, "0x"]], a[0][2], a[0][3]];
  })), /pool, fee or hook is not on/);
  assert.match(net(mutateV4("NET", "ETH>NET", 0, 1, "(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", (a) => {
    a[0] = [a[0][0], [[POOL, 100, 1, NATIVE, "0x"]], a[0][2], a[0][3]];
  })), /pool, fee or hook is not on/);
  assert.match(net(mutateV4("NET", "ETH>NET", 0, 1, "(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", (a) => {
    a[0] = [a[0][0], a[0][1], 1n, a[0][3]];
  })), /not the kit's exact-input shape/);
  assert.match(net(mutateV4("NET", "ETH>NET", 0, 1, "(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", (a) => {
    a[0] = [a[0][0], a[0][1], a[0][2], 1n];
  })), /not the kit's exact-input shape/);
  assert.match(net(mutateV4("NET", "ETH>NET", 0, 2, "address, address, uint256", (a) => { a[0] = ADDR.eco; })), /take currency or amount/);
  assert.match(net(mutateV4("NET", "ETH>NET", 0, 2, "address, address, uint256", (a) => { a[2] = 1n; })), /take currency or amount/);
  // The coin-pool hook is identity, not an arbitrary contract suggested by a kit.
  assert.match(eco(mutateV4("ECO", "WETH>ZORA>ECO", 2, 1, "(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", (a) => {
    const old = a[0]; a[0] = [old[0], [[old[1][0][0], 30000, 200, THIEF, "0x"]], old[2], old[3]];
  })), /pool, fee or hook is not on/);
  assert.match(eco(mutateV4("ECO", "WETH>ZORA>ECO", 2, 1, "(address, (address, uint24, int24, address, bytes)[], uint128, uint128)", (a) => {
    const old = a[0]; a[0] = [old[0], [[old[1][0][0], 30000, 200, old[1][0][3], "0xaa"]], old[2], old[3]];
  })), /pool, fee or hook is not on/);
  const divertedV3 = alterPreparedBuy("ECO", "WETH>ZORA>ECO", (steps) => {
    editV3(steps, 1, (args) => { args[3] = `0x${ADDR.net.slice(2)}000bb8${circle.TOKENS.ZORA.slice(2)}`; });
  });
  assert.match(eco(divertedV3), /v3 path does not begin|v3 pool or fee/);
  const wrongFeeV3 = alterPreparedBuy("ECO", "WETH>ZORA>ECO", (steps) => {
    editV3(steps, 1, (args) => { const p = args[3]; args[3] = `${p.slice(0, 42)}000001${p.slice(48)}`; });
  });
  assert.match(eco(wrongFeeV3), /v3 pool or fee/);
  const routedThroughNet = alterPreparedBuy("ECO", "WETH>NET>ECO", (steps) => {
    editV4(steps, 1, (params) => { const v = [...decodeAbiParameters(parseAbiParameters("address, address, uint256"), params[2])]; v[0] = ADDR.net; params[2] = enc("address, address, uint256", v); });
  });
  assert.match(eco(routedThroughNet), /take currency or amount/);
  // This was the precise old-gate bypass: spend WETH into NET, then request an
  // unrelated ECO sweep. An old router balance of ECO would make it appear to
  // succeed without the buyer receiving ECO from the ETH they spent.
  const forgedEcoSweep = alterPreparedBuy("NET", "WETH>NET", (steps) => {
    steps[steps.length - 1] = sweepTok(ME, ADDR.eco, 5n);
  });
  assert.match(eco(forgedEcoSweep), /decoded token path is not one of the permitted routes/);
  const forgedNetSweep = alterPreparedBuy("ECO", "ETH>ECO", (steps) => {
    steps[steps.length - 1] = sweepTok(ME, ADDR.net, 5n);
  });
  assert.match(net(forgedNetSweep), /decoded token path is not one of the permitted routes/);
});

test("the buy legs: dry says what they would buy and the kit's own words; live sends through the same gate, caps and ledger; a refused step sends nothing", async () => {
  const size = parseEther("0.0002");
  const answers = {
    "buy --token NET": { code: 0, out: { sendable: true, prepared: { route: "WETH>NET", minOut: "5", disclosure: circle.BUY_DISCLOSURE.NET, tx: buyTx("NET", "WETH>NET", size) } } },
    "buy --token ECO": { code: 0, out: { sendable: true, prepared: { route: "WETH>NET>ECO", minOut: "7", disclosure: circle.BUY_DISCLOSURE.ECO, tx: buyTx("ECO", "WETH>NET>ECO", size) } } },
  };
  const args = ["--legs", "net-buy,eco-buy", "--net-eth", "0.0002", "--eco-buy-eth", "0.0002"];
  const dry = world({ args, answers });
  assert.equal(await pass(dry.ctx), 0);
  assert.equal(dry.sent.length, 0);
  assert.ok(dry.said.some((l) => /net-buy: As of 2026-11-18, EcoWealth created NET and holds it/.test(l)));
  assert.ok(dry.said.some((l) => /eco-buy: As of 2026-11-18, EcoWealth created ECO/.test(l)));
  assert.ok(dry.said.some((l) => /net-buy: DRY, would send buy at least 5 units of NET by WETH>NET with 0\.0002 ETH/.test(l)));
  assert.ok(dry.said.some((l) => /eco-buy: DRY, would send buy at least 7 units of ECO by WETH>NET>ECO with 0\.0002 ETH/.test(l)));
  assert.ok(dry.calls.includes(`buy --token NET --from ${ME} --size 0.0002`) && dry.calls.includes(`buy --token ECO --from ${ME} --size 0.0002`));
  assert.ok(dry.said.some((l) => /net-buy: off|eco-buy: off/.test(l)) === false, "both legs are on");
  // off without a size
  const off = world({ args: ["--legs", "net-buy,eco-buy"], answers });
  assert.equal(await pass(off.ctx), 0);
  assert.ok(off.said.some((l) => /net-buy: off \(set --net-eth/.test(l)) && off.said.some((l) => /eco-buy: off \(set --eco-buy-eth/.test(l)));
  assert.equal(off.calls.length, 0, "no size, no kit call");
  // live: both send, are in the ledger, and are not due again
  const live = world({ live: true, args, answers });
  assert.equal(await pass(live.ctx), 0);
  assert.deepEqual(live.sent.map((s) => [s.sel, s.value]), [[SEL.execute, size], [SEL.execute, size]]);
  const rows = fs.readFileSync(live.home.files.ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.filter((r) => r.phase === "reserved").map((r) => r.leg), ["eco-buy", "net-buy"], "in the loop's own order");
  assert.deepEqual(rows.map((r) => r.phase), ["reserved", "broadcast", "receipt", "reserved", "broadcast", "receipt"]);
  assert.equal(await pass(live.ctx), 0);
  assert.equal(live.sent.length, 2, "not due again the same day");
  // the day spend cap counts the buys like any other spend
  const capped = world({ live: true, args: [...args, "--day-spend-eth", "0.0003"], answers });
  assert.equal(await pass(capped.ctx), 0);
  assert.equal(capped.sent.length, 1, "the second buy waits: the day's spend cap is reached");
  // a step that pays out to someone else is refused, nothing is sent, and the leg stays stopped
  const bad = world({ live: true, args: ["--legs", "net-buy", "--net-eth", "0.0002"], answers: { "buy --token NET": { code: 0, out: { sendable: true, prepared: { route: "WETH>NET", minOut: "5", tx: tx(ADDR.universalRouter, call("execute", [cmdHex([ROUTER_CMD.V4_SWAP, ROUTER_CMD.SWEEP]), [nativeHop(size)[1], sweepTok(THIEF, ADDR.net)[1]], 2_000_000_000n]), { value: hex(size) }) } } } } });
  assert.equal(await pass(bad.ctx), 4);
  assert.equal(bad.sent.length, 0);
  assert.ok(bad.said.some((l) => /net-buy: STOPPED: net-buy: refused buy at least 5 units of NET by WETH>NET: the buy sweeps to an address that is not yours/.test(l)));
  // STOP and an unconfirmed transaction hold the buys like every other send
  const stopped = world({ live: true, args, answers });
  fs.writeFileSync(stopped.home.files.stop, "");
  await pass(stopped.ctx);
  assert.equal(stopped.sent.length, 0);
  assert.ok(listText().includes("net-buy") && listText().includes("eco-buy"), "the list command prints both rules");
});

// ---- crashes at every durable boundary, and a restore drill ------------------------------------------------------------
// Offline only: pretend chain, throwaway test keys in temporary folders, nothing real is signed or sent.
const POWER_LOSS = "simulated power loss";
/** One live ECO buy whose process dies just BEFORE its `crashBefore`-th durable write (state save or ledger append). */
async function sendThatDiesBefore({ signed, crashBefore, nowMs }) {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"], ...(nowMs === undefined ? {} : { nowMs }) });
  const counts = { ops: 0, broadcasts: 0 };
  let dead = false;
  const durable = () => {
    if (dead) throw new Error(`${POWER_LOSS} (the process is gone)`);
    counts.ops += 1;
    if (counts.ops === crashBefore) { dead = true; throw new Error(POWER_LOSS); }
  };
  const save = w.home.save.bind(w.home), record = w.home.record.bind(w.home);
  w.home.save = (state) => { durable(); return save(state); };
  w.home.record = (row) => { durable(); return record(row); };
  let signedTx = null;
  if (signed) {
    w.ctx.address = FAKE_SIGNER.address;
    w.ctx.io.prepare = async (_chain, body) => { signedTx = await offlineSigned(body, 7); return signedTx; };
    w.ctx.io.broadcast = async () => { counts.broadcasts += 1; return signedTx.hash; };
  }
  await pass(w.ctx).catch(() => {});
  const sends = () => (signed ? counts.broadcasts : w.sent.length);
  // The restarted process: same folder, fresh memory, and the chain answering `seen` about the pending hash.
  const restart = (seen) => makeContext({
    opts: w.ctx.opts, home: openHome(w.dir), address: w.ctx.address, kit: w.ctx.kit, say: (l) => w.said.push(l), now: w.ctx.now,
    io: { ...w.ctx.io, seen: async () => seen },
  });
  return { w, counts, sends, restart, died: () => dead };
}

test("a crash before EVERY durable write of a send never replays it and never forgets its spend", async () => {
  const value = parseEther("0.0002");
  for (const signed of [false, true]) {
    const clean = await sendThatDiesBefore({ signed, crashBefore: Infinity });
    assert.equal(clean.sends(), 1);
    const boundaries = clean.counts.ops;
    assert.ok(boundaries >= 6, `a send has at least six durable writes (found ${boundaries})`);
    for (let crashBefore = 1; crashBefore <= boundaries; crashBefore++) {
      for (const seen of [null, true, false]) {
        const label = `${signed ? "signed" : "unsigned"} send, power lost before durable write ${crashBefore} of ${boundaries}, chain says ${seen}`;
        const run = await sendThatDiesBefore({ signed, crashBefore });
        assert.equal(run.died(), true, label);
        const sentAtCrash = run.sends();
        let refused = false;
        try { await pass(run.restart(seen)); } catch { refused = true; }
        // Only a finalized REVERT (chain says false) frees the buy to be tried once more; an unknown or successful
        // outcome must never lead to a second send of something that may already be out.
        const most = seen === false ? 2 : 1;
        assert.ok(run.sends() <= most, `${label}: the one purchase was sent ${run.sends()} times`);
        if (sentAtCrash === 1 && seen !== false) assert.equal(run.sends(), 1, `${label}: a restart replayed a send that may already be out`);
        if (run.sends() >= 1) {
          let spend;
          try { spend = openHome(run.w.dir).day(run.w.ctx.now()).spendWei; } catch { spend = "refused"; }
          assert.ok(spend === value * BigInt(run.sends()) || spend === "refused", `${label}: a spend was forgotten (read ${spend} after ${run.sends()} sends)`);
        }
        assert.equal(typeof refused, "boolean");
      }
    }
  }
});

test("--expect-commitment belongs to audit only and must be a full SHA-256 hex", () => {
  const good = "ab".repeat(32);
  assert.equal(parseArgs(["audit", "--home", "/tmp/h", "--expect-commitment", good], {}).expectCommitment, good);
  for (const bad of ["", "AB".repeat(32), "ab".repeat(31), `${good}0`, "0x" + good.slice(2)])
    assert.throws(() => parseArgs(["audit", "--expect-commitment", bad], {}), /64 hex characters/);
  assert.throws(() => parseArgs(["once", "--address", ME, "--expect-commitment", good], {}), /belongs to `audit`/);
  assert.match(HELP, /exit 3 unless the home matches the commitment you saved/);
});

test("disaster-recovery drill: snapshot, outage, restore; a restored home keeps its memory and a stale one is caught", async () => {
  const T0 = Date.now() - 26 * 3_600_000;
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"], nowMs: T0 });
  const runMain = async (argv) => {
    const log = console.log, error = console.error, out = [], err = [];
    console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
    try { const code = await main(argv); return { code, out: out.join("\n"), err: err.join("\n") }; }
    finally { console.log = log; console.error = error; }
  };
  const commitmentOf = async (dir) => JSON.parse((await runMain(["audit", "--home", dir])).out).auditCommitment;
  const copyOf = (dir) => { const dest = tmp(); fs.rmSync(dest, { recursive: true }); fs.cpSync(dir, dest, { recursive: true }); return dest; };
  const liveCtx = (dir, { address = ME, at }) => makeContext({
    opts: parseArgs(["once", "--address", address, "--home", dir, "--live", "--legs", "eco", "--eco-eth", "0.0002"], {}),
    home: openHome(dir), address, kit: w.ctx.kit, io: w.ctx.io, say: (l) => w.said.push(l), now: () => at,
  });

  // 1. The first purchase, then the owner's off-device copy of the folder and its commitment.
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.sent.length, 1);
  const lockedHolder = openHome(w.dir);
  assert.equal(lockedHolder.lock(), true);
  const staleSnapshot = copyOf(w.dir);            // taken while the bot held its lock
  lockedHolder.unlock();
  const staleCommitment = await commitmentOf(w.dir);

  // 2. The bot goes on for another day and makes a second purchase; the owner saves the newer copy and commitment.
  const T1 = T0 + 25 * 3_600_000;
  assert.equal(await pass(liveCtx(w.dir, { at: T1 })), 0);
  assert.equal(w.sent.length, 2);
  const currentCommitment = await commitmentOf(w.dir);
  assert.notEqual(currentCommitment, staleCommitment);
  const currentSnapshot = copyOf(w.dir);

  // 3. Outage: the machine and its folder are gone.
  fs.rmSync(w.dir, { recursive: true });

  // 4. Restore the current copy: it matches the saved commitment and does not buy again an hour later.
  const restored = copyOf(currentSnapshot);
  assert.equal((await runMain(["audit", "--home", restored, "--expect-commitment", currentCommitment])).code, 0);
  assert.equal(await pass(liveCtx(restored, { at: T1 + 3_600_000 })), 0);
  assert.equal(w.sent.length, 2, "a restored home remembers its last purchase and sends nothing new");
  assert.equal(openHome(restored).day(T1 + 3_600_000).spendWei, parseEther("0.0002"), "the spend of the last day survives the restore");

  // 5. Restore an OLDER copy: the audit catches it. The bot alone cannot know a purchase is missing from its
  //    memory, which is why the commitment is saved somewhere else and checked before every restart.
  const stale = copyOf(staleSnapshot);
  fs.rmSync(path.join(stale, "lock"), { force: true });
  const caught = await runMain(["audit", "--home", stale, "--expect-commitment", currentCommitment]);
  assert.equal(caught.code, 3, caught.err);
  assert.match(caught.err, /older backup/);
  assert.equal((await runMain(["audit", "--home", stale, "--expect-commitment", staleCommitment])).code, 0, "it is a valid history, just not the newest");

  // 6. A snapshot taken while the bot ran carries its lock: the restored home stays locked until the owner clears it.
  const withLock = copyOf(staleSnapshot);
  assert.equal(openHome(withLock).lock(), false);

  // 7. Broken restores fail closed and send nothing.
  const sentBefore = w.sent.length;
  const noLedger = copyOf(currentSnapshot); fs.rmSync(path.join(noLedger, "ledger.jsonl"));
  await assert.rejects(() => pass(liveCtx(noLedger, { at: T1 + 3_600_000 })), /ledger is missing/);
  const noState = copyOf(currentSnapshot); fs.rmSync(path.join(noState, "state.json"));
  await assert.rejects(() => pass(liveCtx(noState, { at: T1 + 3_600_000 })), /state is missing/);
  const torn = copyOf(currentSnapshot);
  const ledgerText = fs.readFileSync(path.join(torn, "ledger.jsonl"), "utf8");
  fs.writeFileSync(path.join(torn, "ledger.jsonl"), ledgerText.slice(0, ledgerText.length - 20));
  assert.equal((await runMain(["audit", "--home", torn])).code, 1, "a torn last row fails the audit");
  assert.equal(await pass(liveCtx(torn, { at: T1 + 30 * 3_600_000 })), 4, "when the next purchase is due the torn history stops it");
  const otherSigner = copyOf(currentSnapshot);
  assert.equal(await pass(liveCtx(otherSigner, { address: THIEF, at: T1 + 30 * 3_600_000 })), 4, "a home bound to one wallet refuses another signer");
  const loose = copyOf(currentSnapshot); fs.chmodSync(loose, 0o755);
  assert.throws(() => openHome(loose), /private real directory/, "a restore that loosened the folder's permissions is refused");
  assert.equal(w.sent.length, sentBefore, "no broken restore sent anything");
});

async function runCli(argv) {
  const log = console.log, error = console.error, out = [], err = [];
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  try { const code = await main(argv); return { code, out: out.join("\n"), err: err.join("\n") }; }
  finally { console.log = log; console.error = error; }
}
const treeNames = (dir) => fs.readdirSync(dir, { recursive: true }).map(String).sort();

test("backup and restore: the bot's memory is copied without its key, proven, and rebuilt only into a new home", async () => {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"], nowMs: Date.now() - 3_600_000 });
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.sent.length, 1);
  // things that must never travel in a backup
  fs.writeFileSync(path.join(w.dir, "wallet.key"), "0x" + "ee".repeat(32), { mode: 0o600 });
  fs.writeFileSync(w.home.files.stop, "");
  const parent = tmp(), backup = path.join(parent, "bk"), restoredHome = path.join(parent, "restored");
  const saved = JSON.parse((await runCli(["audit", "--home", w.dir])).out).auditCommitment;

  // 1. the backup: new private folder, only the bot's memory, a manifest, and it reads back to the same commitment
  const made = await runCli(["backup", "--home", w.dir, "--to", backup]);
  assert.equal(made.code, 0, made.err);
  assert.equal(JSON.parse(made.out).auditCommitment, saved);
  assert.deepEqual(treeNames(backup), ["MANIFEST.json", "archives", "ledger.jsonl", "state.json"], "no key, no lock, no STOP");
  assert.equal(fs.statSync(backup).mode & 0o077, 0, "the backup folder is private");
  for (const f of ["state.json", "ledger.jsonl", "MANIFEST.json"]) assert.equal(fs.statSync(path.join(backup, f)).mode & 0o077, 0, `${f} is private`);
  assert.equal((await runCli(["backup", "--home", w.dir, "--to", backup])).code, 2, "a backup never overwrites a folder");
  assert.equal((await runCli(["backup", "--home", w.dir, "--to", path.join(w.dir, "inside")])).code, 2, "not inside the home");
  assert.equal(fs.existsSync(path.join(w.dir, "inside")), false);
  fs.writeFileSync(path.join(w.dir, "lock"), "held");
  assert.equal((await runCli(["backup", "--home", w.dir, "--to", path.join(parent, "bk-locked")])).code, 2, "a running bot's home is not backed up");
  fs.rmSync(path.join(w.dir, "lock"));

  // 2. outage, then restore into a NEW home: matches the commitment saved elsewhere, binds the same wallet, holds no key
  fs.rmSync(w.dir, { recursive: true });
  const back = await runCli(["restore", "--from", backup, "--home", restoredHome, "--expect-commitment", saved]);
  assert.equal(back.code, 0, back.err);
  assert.equal(JSON.parse(back.out).auditCommitment, saved);
  assert.deepEqual(treeNames(restoredHome), ["archives", "ledger.jsonl", "state.json"]);
  assert.equal((await runCli(["audit", "--home", restoredHome, "--expect-commitment", saved])).code, 0);
  assert.equal(openHome(restoredHome).state().walletAddress, ME);
  assert.equal(fs.readdirSync(parent).some((n) => n.startsWith(".vealth-bot-restore-")), false, "no staging folder is left behind");
  const sentBefore = w.sent.length;
  const later = makeContext({ opts: parseArgs(["once", "--address", ME, "--home", restoredHome, "--live", "--legs", "eco", "--eco-eth", "0.0002"], {}),
    home: openHome(restoredHome), address: ME, kit: w.ctx.kit, io: w.ctx.io, say: () => {}, now: () => Date.now() });
  assert.equal(await pass(later), 0);
  assert.equal(w.sent.length, sentBefore, "a restored home remembers its purchase and does not buy again");

  // 3. restore never overwrites, never builds from a wrong commitment, and refuses every kind of altered backup
  const mark = fs.readFileSync(path.join(restoredHome, "state.json"), "utf8");
  assert.equal((await runCli(["restore", "--from", backup, "--home", restoredHome])).code, 2, "an existing home is never overwritten");
  assert.equal(fs.readFileSync(path.join(restoredHome, "state.json"), "utf8"), mark);
  const wrong = path.join(parent, "wrong-commitment");
  const refused = await runCli(["restore", "--from", backup, "--home", wrong, "--expect-commitment", "ab".repeat(32)]);
  assert.equal(refused.code, 3);
  assert.match(refused.err, /older backup/);
  assert.equal(fs.existsSync(wrong), false, "a mismatch builds nothing");
  const attempt = (name, damage, message) => async () => {
    const copy = path.join(parent, `bk-${name}`); fs.cpSync(backup, copy, { recursive: true });
    damage(copy);
    const target = path.join(parent, `home-${name}`);
    const r = await runCli(["restore", "--from", copy, "--home", target]);
    assert.notEqual(r.code, 0, `${name}: restore must refuse`);
    assert.match(r.err, message, `${name}: ${r.err}`);
    assert.equal(fs.existsSync(target), false, `${name}: nothing is built`);
    assert.equal(fs.readdirSync(parent).some((n) => n.startsWith(".vealth-bot-restore-")), false, `${name}: no staging folder is left`);
  };
  await attempt("flipped-ledger-byte", (d) => { const f = path.join(d, "ledger.jsonl"); const b = fs.readFileSync(f); b[b.length - 5] ^= 1; fs.writeFileSync(f, b); }, /ledger\.jsonl in the backup/)();
  await attempt("edited-state", (d) => { const f = path.join(d, "state.json"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(ME, THIEF)); }, /state\.json in the backup/)();
  await attempt("manifest-hash-edited", (d) => { const f = path.join(d, "MANIFEST.json"); const m = JSON.parse(fs.readFileSync(f, "utf8")); m.files[0].sha256 = "00".repeat(32); fs.writeFileSync(f, JSON.stringify(m)); }, /altered|not the file/)();
  await attempt("commitment-edited", (d) => { const f = path.join(d, "MANIFEST.json"); const m = JSON.parse(fs.readFileSync(f, "utf8")); m.auditCommitment = "00".repeat(32); fs.writeFileSync(f, JSON.stringify(m)); }, /do not reproduce the commitment/)();
  await attempt("smuggled-key", (d) => fs.writeFileSync(path.join(d, "wallet.key"), "0x" + "ee".repeat(32)), /does not list: wallet\.key/)();
  await attempt("missing-ledger", (d) => fs.rmSync(path.join(d, "ledger.jsonl")), /missing ledger\.jsonl/)();
  await attempt("manifest-lists-a-key", (d) => { const f = path.join(d, "MANIFEST.json"); const m = JSON.parse(fs.readFileSync(f, "utf8")); m.files.push({ path: "wallet.key", bytes: 1, sha256: "00".repeat(32) }); fs.writeFileSync(f, JSON.stringify(m)); }, /never backs up/)();
  await attempt("no-manifest", (d) => fs.rmSync(path.join(d, "MANIFEST.json")), /manifest/)();

  // 4. a corrupt home is refused, not copied as if it were good
  const bad = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"], nowMs: Date.now() - 3_600_000 });
  assert.equal(await pass(bad.ctx), 0);
  const text = fs.readFileSync(bad.home.files.ledger, "utf8");
  fs.writeFileSync(bad.home.files.ledger, text.slice(0, text.length - 20));
  const corrupt = await runCli(["backup", "--home", bad.dir, "--to", path.join(parent, "bk-corrupt")]);
  assert.equal(corrupt.code, 1);
  assert.equal(fs.existsSync(path.join(parent, "bk-corrupt")), false, "nothing is created for a corrupt home");

  // 5. arguments
  assert.throws(() => parseArgs(["once", "--address", ME, "--to", "/x"], {}), /--to belongs to `backup`/);
  assert.throws(() => parseArgs(["audit", "--from", "/x"], {}), /--from belongs to `restore`/);
  assert.throws(() => parseArgs(["restore", "--from", "/x"], {}), /restore needs --home/);
  assert.equal(parseArgs(["restore", "--from", "/x", "--home", "/y", "--expect-commitment", "ab".repeat(32)], {}).expectCommitment, "ab".repeat(32));
});

test("one wallet runs from one bot home at a time on this machine, and a crash never hands the lease to a second home", () => {
  const dir = path.join(tmp(), "leases");
  const first = acquireWalletLease(ME, "/homes/one", { dir });
  assert.equal(fs.statSync(dir).mode & 0o077, 0, "the lease folder is private");
  assert.equal(fs.statSync(first.file).mode & 0o077, 0, "the lease file is private");
  assert.throws(() => acquireWalletLease(ME.toUpperCase().replace("0X", "0x"), "/homes/two", { dir }), /already in use by the bot home \/homes\/one .*remove .* and start again/s,
    "the same address in any letter case is the same wallet");
  assert.doesNotThrow(() => acquireWalletLease(THIEF, "/homes/two", { dir }).release(), "another wallet is free");
  // a copy of the lease that is not ours is never removed by a stranger's release
  const ours = fs.readFileSync(first.file, "utf8");
  fs.writeFileSync(first.file, JSON.stringify({ ...JSON.parse(ours), nonce: "someone-else" }));
  first.release();
  assert.equal(fs.existsSync(first.file), true, "release removes only the lease it created");
  fs.writeFileSync(first.file, ours);
  first.release();
  assert.equal(fs.existsSync(first.file), false);
  // a crash leaves the lease in place on purpose; an unreadable one still blocks
  const crashed = acquireWalletLease(ME, "/homes/crashed", { dir });
  fs.writeFileSync(crashed.file, "{garbled");
  assert.throws(() => acquireWalletLease(ME, "/homes/next", { dir }), /already in use by another bot/);
  // the folder must be private, real and ours
  const loose = path.join(tmp(), "loose"); fs.mkdirSync(loose, { mode: 0o755 }); fs.chmodSync(loose, 0o755);
  assert.throws(() => acquireWalletLease(ME, "/homes/x", { dir: loose }), /private real directory/);
  const target = tmp(), link = path.join(tmp(), "link"); fs.symlinkSync(target, link);
  assert.throws(() => acquireWalletLease(ME, "/homes/x", { dir: link }), /private real directory/);
  assert.throws(() => acquireWalletLease("0x12", "/homes/x", { dir }), /valid wallet address/);
});

/** A pretend chain node on the loopback address only: just enough JSON-RPC for the bot's real chain IO, driven by `state`. */
async function pretendNode(initial = {}) {
  const state = { chainId: "0x2105", nonce: 7, pendingNonce: 7, finalized: 100, receiptBlock: 100, status: "0x1", canonicalHash: null, mined: false, received: [], ...initial };
  const hex = (n) => `0x${BigInt(n).toString(16)}`;
  const word = (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
  const zero32 = word(0), zeroAddr = `0x${"0".repeat(40)}`, bloom = `0x${"00".repeat(256)}`;
  const block = (n, hash) => ({ number: hex(n), hash, parentHash: word(BigInt(n) - 1n), timestamp: hex(1_900_000_000n + BigInt(n)), nonce: "0x0000000000000000",
    sha3Uncles: zero32, logsBloom: bloom, transactionsRoot: zero32, stateRoot: zero32, receiptsRoot: zero32, miner: zeroAddr, difficulty: "0x0",
    totalDifficulty: "0x0", extraData: "0x", size: "0x1", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], uncles: [], baseFeePerGas: "0x1" });
  const answer = (method, params) => {
    switch (method) {
      case "eth_chainId": return state.chainId;
      case "eth_getTransactionCount": return hex(params[1] === "pending" ? state.pendingNonce : state.nonce);
      case "eth_sendRawTransaction": state.received.push(params[0]); state.mined = true; return keccak256(params[0]);
      case "eth_getTransactionReceipt": return !state.mined ? null : { transactionHash: keccak256(state.received.at(-1)), transactionIndex: "0x0",
        blockHash: word(state.receiptBlock), blockNumber: hex(state.receiptBlock), from: FAKE_SIGNER.address, to: ME, cumulativeGasUsed: "0x5208",
        gasUsed: "0x5208", contractAddress: null, logs: [], logsBloom: bloom, status: state.status, effectiveGasPrice: "0x1", type: "0x2" };
      case "eth_getBlockByNumber": {
        const tag = params[0];
        if (tag === "finalized") return block(state.finalized, word(state.finalized));
        if (tag === "latest") return block(state.receiptBlock + 5, word(state.receiptBlock + 5));
        const n = BigInt(tag);
        return block(n, n === BigInt(state.receiptBlock) && state.canonicalHash ? state.canonicalHash : word(n));
      }
      default: throw new Error(`the pretend node does not know ${method}`);
    }
  };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const call = JSON.parse(body);
      let reply;
      try { reply = { jsonrpc: "2.0", id: call.id, result: answer(call.method, call.params) }; }
      catch (e) { reply = { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: String(e.message) } }; }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the real chain IO against a pretend node: a first receipt that is not final waits instead of halting, and only finality settles it", async () => {
  const node = await pretendNode({ finalized: 90, receiptBlock: 100 });
  try {
    const io = makeChainIo(FAKE_SIGNER, { base: node.url, arbitrum: node.url });
    const signed = await io.prepare("base", swapTx(parseEther("0.0002")));
    assert.equal(signed.nonce, 7);
    assert.equal(await io.broadcast("base", signed.raw), signed.hash);
    assert.deepEqual(node.state.received, [signed.raw], "the node saw exactly the signed bytes");
    assert.equal(await io.wait("base", signed.hash), null, "included, but the finalized block has not reached it yet");
    assert.equal(await io.seen("base", signed.hash), null);
    node.state.finalized = 100;
    assert.equal(await io.wait("base", signed.hash), true);
    assert.equal(await io.seen("base", signed.hash), true);
    node.state.status = "0x0";
    assert.equal(await io.seen("base", signed.hash), false, "a finalized revert is a revert");
    node.state.status = "0x1"; node.state.canonicalHash = `0x${"ab".repeat(32)}`;
    assert.equal(await io.seen("base", signed.hash), null, "a receipt whose block is not the canonical one (a reorg) is never final");
  } finally { await node.close(); }
});

test("the real chain IO refuses a node on another chain, a contended nonce and a nonce that moved after signing", async () => {
  const node = await pretendNode();
  try {
    const io = makeChainIo(FAKE_SIGNER, { base: node.url, arbitrum: node.url });
    node.state.chainId = "0x1";
    await assert.rejects(() => io.prepare("base", swapTx(parseEther("0.0002"))), /another chain/);
    node.state.chainId = "0x2105"; node.state.pendingNonce = 8;
    await assert.rejects(() => io.prepare("base", swapTx(parseEther("0.0002"))), /unconfirmed transaction or inconsistent nonce/);
    node.state.pendingNonce = 7;
    const signed = await io.prepare("base", swapTx(parseEther("0.0002")));
    node.state.nonce = 8; node.state.pendingNonce = 8;
    await assert.rejects(() => io.broadcast("base", signed.raw), /nonce changed since local signing/);
    assert.deepEqual(node.state.received, [], "nothing reached the node");
    await assert.rejects(() => io.send("base", swapTx(parseEther("0.0002"))), /direct send is disabled/);
  } finally { await node.close(); }
});

test("a Hydrex claim that is included but not final stops the leg's later steps instead of sending the next claim or the vote", async () => {
  const w = world({ live: true, args: ["--legs", "hydrex"] });
  w.ctx.io.wait = async () => null;
  assert.equal(await pass(w.ctx), 0);
  assert.deepEqual(w.sent.map((s) => s.sel), [SEL.claimFees], "only the first claim went out; the second claim and the vote wait");
  assert.ok(w.home.state().pending?.hash);
  assert.deepEqual(w.ctx.halted, {});
});

test("STOP arriving after a send is reserved and before it is broadcast sends nothing, and removing STOP alone does not release the reservation", async () => {
  for (const signed of [false, true]) {
    const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
    let broadcasts = 0, signedTx = null;
    if (signed) {
      w.ctx.address = FAKE_SIGNER.address;
      w.ctx.io.prepare = async (_chain, body) => { signedTx = await offlineSigned(body, 7); return signedTx; };
      w.ctx.io.broadcast = async () => { broadcasts += 1; return signedTx.hash; };
    }
    const sends = () => (signed ? broadcasts : w.sent.length);
    const record = w.home.record.bind(w.home);
    w.home.record = (row) => { record(row); if (row.phase === "reserved") fs.writeFileSync(w.home.files.stop, ""); }; // the owner touches STOP right then
    assert.equal(await pass(w.ctx), 0);
    assert.equal(sends(), 0, `${signed ? "signed" : "unsigned"}: STOP held the send back`);
    assert.ok(w.home.state().pending, "the reservation stays");
    assert.equal(w.home.day(w.ctx.now()).spendWei, parseEther("0.0002"), "and its spend stays counted");
    fs.rmSync(w.home.files.stop);
    w.ctx.io.seen = async () => null;
    await pass(w.ctx); await pass(w.ctx);
    assert.equal(sends(), 0, "removing STOP alone releases nothing");
    assert.ok(w.home.state().pending);
  }
});

test("a send that is included but not final stays pending without halting the leg, and the next pass settles it once", async () => {
  const w = world({ live: true, args: ["--legs", "eco", "--eco-eth", "0.0002"] });
  w.ctx.io.wait = async () => null;
  assert.equal(await pass(w.ctx), 0, "not final yet is not a failure");
  assert.equal(w.sent.length, 1);
  assert.ok(w.said.some((l) => /not final yet.*stays pending.*next pass checks it again/.test(l)));
  assert.equal(w.said.some((l) => /STOPPED|stopped this pass/.test(l)), false, "no halt, no failure counted");
  assert.deepEqual(w.ctx.halted, {});
  assert.deepEqual(w.ctx.fails, {});
  assert.ok(w.home.state().pending?.hash);
  assert.deepEqual(fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l).phase), ["reserved", "broadcast"]);
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.sent.length, 1, "nothing is sent while it is unresolved");
  w.ctx.io.seen = async () => true;
  assert.equal(await pass(w.ctx), 0);
  assert.equal(w.sent.length, 1);
  assert.equal(w.home.state().pending, undefined);
  assert.ok(w.home.state().eco?.at, "the buy's completion is applied once it is final");
  assert.deepEqual(fs.readFileSync(w.home.files.ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l).phase), ["reserved", "broadcast", "reconciled"]);
});

test("a send that was in doubt when the backup was made is still in doubt after the restore", async () => {
  // broadcast went out; the receipt was never written. The real clock, because backup audits against it.
  const run = await sendThatDiesBefore({ signed: true, crashBefore: 6, nowMs: Date.now() - 3_600_000 });
  const pendingBefore = openHome(run.w.dir).state().pending;
  assert.ok(pendingBefore?.hash);
  const parent = tmp(), backup = path.join(parent, "bk"), restoredHome = path.join(parent, "restored");
  assert.equal((await runCli(["backup", "--home", run.w.dir, "--to", backup])).code, 0);
  fs.rmSync(run.w.dir, { recursive: true });
  assert.equal((await runCli(["restore", "--from", backup, "--home", restoredHome])).code, 0);
  const after = openHome(restoredHome).state().pending;
  assert.equal(after.hash, pendingBefore.hash);
  assert.equal(after.signedRaw, pendingBefore.signedRaw);
  const ctx = makeContext({ opts: { ...run.w.ctx.opts, home: restoredHome },
    home: openHome(restoredHome), address: run.w.ctx.address, kit: run.w.ctx.kit, say: () => {}, now: run.w.ctx.now,
    io: { ...run.w.ctx.io, seen: async () => null } });
  assert.equal(await pass(ctx), 0);
  assert.equal(run.sends(), 1, "the restored home does not send again while that transaction is unresolved");
});
