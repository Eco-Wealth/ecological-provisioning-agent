// Offline tests for net-circle: `node --test net-circle.test.mjs` (no network, no key).
// Each loop is one Universal Router call that trades exactly the stated input, refunds any extra ETH outside the floor,
// and pays the sender only above a floor that must exceed the input. Network failures never pass for empty pools.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAbiParameters, decodeFunctionData, encodeFunctionResult, multicall3Abi, parseAbi, parseAbiParameters, toFunctionSelector } from "viem";
import * as circle from "./net-circle.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "net-circle.mjs");
const ROUTER_ABI = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const COIN_KEY = { currency0: circle.TOKENS.ZORA, currency1: circle.TOKENS.ECO, fee: 30000, tickSpacing: 200, hooks: "0xd61A675F8a0c67A73DC3B54FB7318B4D91409040" };
const POOLS = { ...circle.POOLS, coin: { ...circle.POOLS.coin, key: COIN_KEY } };
const IN = 10n ** 14n;
const loop = (id) => circle.LOOPS.find((l) => l.id === id);
const build = (id, minEthOutWei = IN + 1n) => circle.buildLoopTx({ loop: loop(id), pools: POOLS, amountInWei: IN, minEthOutWei, deadline: 2_000_000_000n });
const decode = (tx) => decodeFunctionData({ abi: ROUTER_ABI, data: tx.data }).args;
const sweepArgs = (input) => decodeAbiParameters(parseAbiParameters("address, address, uint256"), input);
const lower = (a) => a.toLowerCase();

describe("loops", () => {
  it("twelve loops, each starting and ending in ETH or WETH, never native at both ends, all crossing NET/WETH", () => {
    assert.equal(circle.LOOPS.length, 12);
    for (const l of circle.LOOPS) {
      const [a, z] = [l.tokens[0], l.tokens[l.tokens.length - 1]];
      assert.ok(["ETH", "WETH"].includes(a) && ["ETH", "WETH"].includes(z), l.id);
      assert.ok(!(a === "ETH" && z === "ETH"), l.id);
      assert.ok(l.pools.includes("netWeth"), l.id);
      assert.equal(l.tokens.length, l.pools.length + 1, l.id);
    }
  });

  it("merges consecutive V4 pools into one command, keeps V3 apart, and needs the live coin key", () => {
    assert.deepEqual(circle.segmentsOf(loop("mft:buy-net"), POOLS).map((s) => s.v), [4, 3, 4]);
    assert.throws(() => circle.segmentsOf(loop("zora:buy-net"), circle.POOLS), /no key/);
  });

  it("sums each loop's pool fees and flags a dynamic-fee pool", () => {
    assert.deepEqual(circle.loopFees(loop("zora:buy-net"), POOLS), { pct: 3.32, dynamic: false });
    assert.deepEqual(circle.loopFees(loop("mft:buy-net"), POOLS), { pct: 1.02, dynamic: true });
  });
});

describe("the transaction", () => {
  it("encodes wrap + immediate refund for a WETH start, the segments in loop order, then the payout", () => {
    const cmds = (id) => decode(build(id))[0];
    assert.equal(cmds("zora:buy-net"), "0x0b0410000c04");
    assert.equal(cmds("zora:sell-net"), "0x0b0400100c04");
    assert.equal(cmds("mft:buy-net"), "0x0b041000100c04");
    assert.equal(cmds("axlregen:buy-net"), "0x0b041004");
    assert.equal(cmds("axlregen:sell-net"), "0x100c04");
    assert.equal(cmds("net-pools:buy-net"), "0x0b041004");
  });

  it("refunds extra msg.value outside the floor: right after the wrap, or after the WETH payout for a native start", () => {
    for (const l of circle.LOOPS) {
      const [commands, inputs] = decode(build(l.id));
      const c = commands.slice(2).match(/../g);
      if (l.tokens[0] === "WETH") {
        assert.deepEqual(c.slice(0, 2), ["0b", "04"], l.id);
        const [token, to, min] = sweepArgs(inputs[1]);
        assert.deepEqual([token, lower(to), min], [circle.ETH, circle.MSG_SENDER, 0n], l.id);
      }
      if (l.tokens[l.tokens.length - 1] === "WETH") {
        assert.deepEqual(c.slice(-2), ["0c", "04"], l.id);
        const [token, to, min] = sweepArgs(inputs[inputs.length - 1]);
        assert.deepEqual([token, lower(to), min], [circle.ETH, circle.MSG_SENDER, 0n], l.id);
      }
    }
  });

  it("puts the floor on the payout: UNWRAP_WETH for a WETH ending, a native SWEEP otherwise", () => {
    const floor = IN + 987654321n;
    for (const l of circle.LOOPS) {
      const [, inputs] = decode(build(l.id, floor));
      if (l.tokens[l.tokens.length - 1] === "WETH") {
        const [to, min] = decodeAbiParameters(parseAbiParameters("address, uint256"), inputs[inputs.length - 2]);
        assert.deepEqual([lower(to), min], [circle.MSG_SENDER, floor], l.id);
      } else {
        const [token, to, min] = sweepArgs(inputs[inputs.length - 1]);
        assert.deepEqual([token, lower(to), min], [circle.ETH, circle.MSG_SENDER, floor], l.id);
      }
    }
  });

  it("trades exactly the stated input in the first segment, then the router's whole balance", () => {
    const [, inputs] = decode(build("zora:buy-net"));
    const [, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), inputs[2]);
    assert.deepEqual(decodeAbiParameters(parseAbiParameters("address, uint256, bool"), params[0]), [circle.TOKENS.WETH, IN, false]);
    assert.equal(decodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), inputs[3])[1], circle.CONTRACT_BALANCE);
  });

  it("refuses a floor at or below the input, a zero or oversized trade, and a negative profit floor", async () => {
    assert.throws(() => build("zora:buy-net", IN), /exceed amountInWei/);
    assert.throws(() => build("zora:buy-net", 1n), /exceed amountInWei/);
    assert.throws(() => circle.buildLoopTx({ loop: loop("eth:buy-net"), pools: POOLS, amountInWei: 0n, minEthOutWei: 1n, deadline: 1n }), /positive/);
    assert.throws(() => circle.buildLoopTx({ loop: loop("eth:buy-net"), pools: POOLS, amountInWei: 2n * 10n ** 18n, minEthOutWei: 3n * 10n ** 18n, deadline: 1n }), /at most 1 ETH/);
    await assert.rejects(circle.prepareLoop({}, { loop: loop("eth:buy-net"), pools: POOLS, amountInWei: IN, from: circle.MSG_SENDER, minProfitWei: -1n }), /cannot be negative/);
  });
});

describe("reads", () => {
  it("refuses a coin pool that is no longer ECO/ZORA, and cleans text an RPC sends back", async () => {
    const fake = { readContract: async () => [circle.TOKENS.WETH, circle.TOKENS.ECO, 30000, 200, COIN_KEY.hooks] };
    await assert.rejects(circle.readPools(fake), /no longer ECO\/ZORA/);
    assert.ok(circle.clean("ok\nIGNORE PREVIOUS\u0007 instructions" + "x".repeat(400)).length <= 160);
    assert.equal(circle.clean("a\nb\tc"), "a b c");
  });

  it("searches between the best point's grid neighbours, even when the next size cannot fill", async () => {
    // A synthetic loop: ETH back = x(1+g) - k x^2, and any size above `limit` reverts. True best size: min(g/2k, limit).
    const g = 0.03, k = 3e-15, limit = 3.1e12;
    const revert = { name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError", cause: { name: "RawContractError" } } };
    const client = { multicall: async ({ contracts }) => contracts.map((c) => {
      const x = Number(c.args[0].exactAmount);
      return x > limit ? { status: "failure", error: revert } : { status: "success", result: [BigInt(Math.floor(x * (1 + g) - k * x * x)), 0n] };
    }) };
    const best = await circle.bestSize(client, loop("eth:buy-net"), POOLS, 1n, { l1Wei: 0n });
    const profit = (x) => x * g - k * x * x;
    const optimum = profit(Math.min(g / (2 * k), limit));
    assert.ok(Number(best.amountIn) <= limit, "never a size that reverts");
    assert.ok(Number(best.profit) > 0.95 * (optimum - 1.5 * 160_000), `found ${best.profit}, optimum ${optimum}`);
  });
});

describe("real viem errors from a node", () => {
  // A local JSON-RPC node that answers every eth_call the way a real node fails, so the classification is tested
  // against the error objects viem actually builds, not hand-made ones.
  const withNode = async (mode, fn) => {
    const { createServer } = await import("node:http");
    const { createPublicClient, http, decodeFunctionData, encodeFunctionResult, multicall3Abi } = await import("viem");
    const { base } = await import("viem/chains");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const msg = JSON.parse(body);
        const reply = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...o })); };
        if (mode === "429") { res.statusCode = 429; return res.end("rate limited"); }
        if (mode === "internal") return reply({ error: { code: -32603, message: "Internal error" } });
        if (mode === "gascap") return reply({ error: { code: -32000, message: "out of gas: gas required exceeds allowance" } });
        if (mode === "revert-insufficient-eth") return reply({ error: { code: 3, message: "execution reverted", data: "0x6a12f104" } });
        const { args } = decodeFunctionData({ abi: multicall3Abi, data: msg.params[0].data });
        reply({ result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: args[0].map(() => ({ success: false, returnData: "0x" })) }) });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      return await fn(createPublicClient({ chain: base, transport: http(`http://127.0.0.1:${server.address().port}`, { retryCount: 0 }) }));
    } finally { server.close(); }
  };

  it("a reverted quote inside the batch is a size that cannot fill", async () => {
    const rows = await withNode("subrevert", (c) => circle.quoteLoop(c, loop("eth:buy-net"), POOLS, [IN]));
    assert.equal(rows[0].out, null);
  });

  for (const mode of ["429", "internal", "gascap"]) {
    it(`a whole-batch node failure (${mode}) throws instead of reading as an empty pool`, async () => {
      await assert.rejects(withNode(mode, (c) => circle.quoteLoop(c, loop("eth:buy-net"), POOLS, [IN])), /not a revert/);
    });
  }

  it("simulate names a transaction revert, and throws on a node failure", async () => {
    const tx = build("eth:buy-net");
    assert.equal(await withNode("revert-insufficient-eth", (c) => circle.simulate(c, tx, circle.MSG_SENDER)), "InsufficientETH");
    await assert.rejects(withNode("429", (c) => circle.simulate(c, tx, circle.MSG_SENDER)));
    await assert.rejects(withNode("internal", (c) => circle.simulate(c, tx, circle.MSG_SENDER)));
  });
});

describe("command line", () => {
  it("runs through a symlink, as npm's bin link does (the offline loops command)", () => {
    const link = join(mkdtempSync(join(tmpdir(), "net-circle-")), "link.mjs");
    symlinkSync(SRC, link);
    const out = execFileSync(process.execPath, [link, "loops"], { encoding: "utf8" });
    assert.match(out, /zora:buy-net\s+WETH -> NET -> ECO -> ZORA -> WETH/);
    assert.equal(out.trim().split("\n").length, 12);
  });

  it("rejects bad arguments before touching the network, and prints help", () => {
    const run = (args) => { try { execFileSync(process.execPath, [SRC, ...args], { encoding: "utf8", stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
    assert.equal(run(["prepare", "--from", "0x1"]), 2);
    assert.equal(run(["prepare", "--from", circle.MSG_SENDER, "--min-profit-wei", "-5"]), 2);
    assert.equal(run(["prepare", "--from", circle.MSG_SENDER, "--deadline-seconds", "1.5"]), 2);
    assert.equal(run(["prepare", "--from", circle.MSG_SENDER, "--size", "5"]), 2);
    assert.equal(run(["quote", "--bogus", "1"]), 2);
    assert.equal(run(["quote", "--loop", "nope"]), 2);
    assert.equal(run(["watch", "--from", circle.MSG_SENDER, "--every", "99999999"]), 2);
    assert.equal(run(["prepare"]), 2);
    assert.match(execFileSync(process.execPath, [SRC, "--help"], { encoding: "utf8" }), /Exit codes/);
  });

  it("never holds a key, signs or sends", () => {
    const src = readFileSync(SRC, "utf8");
    // (the env-var spelling is assembled so this file itself passes secret scanners)
    for (const banned of ["privateKey", ["PRIVATE", "KEY"].join("_"), "sendTransaction", "sendRawTransaction", "eth_sendTransaction", "signTransaction", "signMessage", "createWalletClient", "walletClient", "mnemonic", "privateKeyToAccount"]) {
      assert.ok(!src.includes(banned), banned);
    }
  });
});

// ---- buy: one way, ETH into NET or ECO -----------------------------------------------------------------------------
const SIZE = 10n ** 15n; // 0.001 ETH
const FLOOR = 123_456_789n;
const FROM = "0x000000000000000000000000000000000000a11c";
const routeOf = (token, id) => circle.BUY_ROUTES[token].find((r) => r.id === id);
const buyTx = (token, id, { size = SIZE, floor = FLOOR } = {}) => circle.buildBuyTx({ token, route: routeOf(token, id), pools: POOLS, amountInWei: size, minOutWei: floor, deadline: 2_000_000_000n });
const hexBytes = (h) => h.slice(2).match(/../g).map((x) => parseInt(x, 16));
const ALLOWED_COMMANDS = new Set([0x00, 0x04, 0x0b, 0x10]); // V3_SWAP_EXACT_IN, SWEEP, WRAP_ETH, V4_SWAP; no allow-revert flag (0x80) is in the set
const ALLOWED_ACTIONS = new Set([0x07, 0x0b, 0x0e]); // SWAP_EXACT_IN, SETTLE, TAKE

/** Decode a buy transaction and assert every property another program checks. Returns the command bytes. */
function inspectBuy(tx, { token, size = SIZE, floor = FLOOR }) {
  const [commands, inputs] = decode(tx);
  const cmds = hexBytes(commands);
  assert.equal(cmds.length, inputs.length);
  assert.equal(tx.value, size, "the value equals the size exactly");
  assert.equal(lower(tx.to), lower(circle.CONTRACTS.UNIVERSAL_ROUTER));
  let swaps = 0;
  cmds.forEach((c, i) => {
    assert.ok(ALLOWED_COMMANDS.has(c), `command 0x${c.toString(16)} is not allowed`);
    if (c === 0x0b) {
      const [to, amount] = decodeAbiParameters(parseAbiParameters("address, uint256"), inputs[i]);
      assert.equal(lower(to), circle.ADDRESS_THIS);
      assert.equal(amount, size, "the wrap is the size, which is at most the value");
    }
    if (c === 0x00) {
      const [to, amountIn, , , payerIsUser] = decodeAbiParameters(parseAbiParameters("address, uint256, uint256, bytes, bool"), inputs[i]);
      assert.equal(lower(to), circle.ADDRESS_THIS);
      assert.equal(payerIsUser, false);
      assert.equal(amountIn, swaps === 0 ? size : circle.CONTRACT_BALANCE);
      swaps += 1;
    }
    if (c === 0x10) {
      const [actions, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), inputs[i]);
      const acts = hexBytes(actions);
      assert.deepEqual(acts, [0x0b, 0x07, 0x0e], "settle, swap exact in, take");
      acts.forEach((a, j) => {
        assert.ok(ALLOWED_ACTIONS.has(a));
        if (a === 0x0b) {
          const [, amount, payerIsUser] = decodeAbiParameters(parseAbiParameters("address, uint256, bool"), params[j]);
          assert.equal(payerIsUser, false);
          assert.equal(amount, swaps === 0 ? size : circle.CONTRACT_BALANCE);
        }
        if (a === 0x0e) assert.equal(lower(decodeAbiParameters(parseAbiParameters("address, address, uint256"), params[j])[1]), circle.ADDRESS_THIS);
      });
      swaps += 1;
    }
  });
  const last = cmds.length - 1;
  assert.equal(cmds[last], 0x04, "the last command is a sweep");
  assert.equal(cmds.filter((c) => c === 0x04).length, 1, "one sweep only: no refund sweep follows it");
  const [sweepToken, to, min] = sweepArgs(inputs[last]);
  assert.deepEqual([lower(sweepToken), lower(to), min], [lower(circle.TOKENS[token]), circle.MSG_SENDER, floor], "the floor is the last command's amountMin");
  return cmds;
}

describe("buy: the routes", () => {
  it("is a fixed table over the kit's own pools, never part of LOOPS, with every route ending in the token and holding ETH or WETH only at its start", () => {
    assert.deepEqual(Object.keys(circle.BUY_ROUTES), ["NET", "ECO"]);
    assert.deepEqual(circle.BUY_TOKENS, ["NET", "ECO"]);
    assert.equal(circle.LOOPS.length, 12);
    for (const [token, routes] of Object.entries(circle.BUY_ROUTES)) {
      for (const r of routes) {
        assert.equal(r.tokens[r.tokens.length - 1], token, r.id);
        assert.ok(["ETH", "WETH"].includes(r.tokens[0]), r.id);
        assert.ok(r.tokens.slice(1).every((t) => !["ETH", "WETH"].includes(t)), r.id);
        assert.equal(r.tokens.length, r.pools.length + 1, r.id);
        assert.equal(r.id, r.tokens.join(">"));
        for (const p of r.pools) assert.ok(circle.POOLS[p], `${r.id} names a pool the kit has: ${p}`);
      }
    }
  });

  it("pins the route table the fixed disclosure is written against: NET only through its own ETH and WETH pools; ECO through the direct, coin-pool and NET-pool routes", () => {
    assert.deepEqual(circle.BUY_ROUTES.NET.map((r) => r.pools), [["netEth"], ["netWeth"]]);
    assert.deepEqual(circle.BUY_ROUTES.ECO.map((r) => r.id), ["ETH>ECO", "WETH>ZORA>ECO", "ETH>NET>ECO", "WETH>NET>ECO"]);
    assert.deepEqual(routeOf("ECO", "WETH>ZORA>ECO").pools, ["zoraWeth", "coin"]);
  });

  it("carries the exact disclosure words for each token", () => {
    assert.equal(circle.BUY_DISCLOSURE.NET, "As of 2026-11-18, EcoWealth created NET and holds it. The buying in NET's pools is the house's own.");
    assert.equal(circle.BUY_DISCLOSURE.ECO, "As of 2026-11-18, EcoWealth created ECO, holds it and gains if it rises. ECO bought through WETH>NET>ECO or ETH>NET>ECO passes through NET's pools, and the buying in NET's pools is the house's own. Buying through the Zora coin pool may pay ECO creator fees to EcoWealth.");
  });
});

describe("buy: the transaction", () => {
  it("encodes every route of both tokens within the allowed commands and actions, payerIsUser false, recipients the router, the floor in the last sweep and the value equal to the size", () => {
    for (const [token, routes] of Object.entries(circle.BUY_ROUTES)) for (const r of routes) inspectBuy(buyTx(token, r.id), { token });
  });

  it("pins each route's command bytes", () => {
    const cmds = (token, id) => decode(buyTx(token, id))[0];
    assert.equal(cmds("NET", "ETH>NET"), "0x1004"); // V4_SWAP, SWEEP
    assert.equal(cmds("NET", "WETH>NET"), "0x0b1004"); // WRAP_ETH, V4_SWAP, SWEEP
    assert.equal(cmds("ECO", "ETH>ECO"), "0x1004");
    assert.equal(cmds("ECO", "WETH>ZORA>ECO"), "0x0b001004"); // WRAP_ETH, V3_SWAP_EXACT_IN, V4_SWAP, SWEEP
    assert.equal(cmds("ECO", "ETH>NET>ECO"), "0x1004"); // two V4 pools merge into one swap
    assert.equal(cmds("ECO", "WETH>NET>ECO"), "0x0b1004");
  });

  it("puts the quote-derived floor, whatever it is, in the last sweep, and spends exactly the size in the first swap", () => {
    for (const floor of [1n, FLOOR, 10n ** 30n]) inspectBuy(buyTx("ECO", "WETH>ZORA>ECO", { floor }), { token: "ECO", floor });
    for (const size of [1n, 10n ** 12n, circle.MAX_BUY_WEI]) inspectBuy(buyTx("NET", "WETH>NET", { size }), { token: "NET", size });
  });

  it("refuses a size of zero or above 0.05 ETH, a zero floor, a bad token, and a route that does not end in the token", () => {
    assert.throws(() => buyTx("NET", "ETH>NET", { size: 0n }), /positive and at most 0\.05 ETH/);
    assert.throws(() => buyTx("NET", "ETH>NET", { size: circle.MAX_BUY_WEI + 1n }), /at most 0\.05 ETH/);
    assert.throws(() => buyTx("NET", "ETH>NET", { floor: 0n }), /floor/);
    assert.throws(() => circle.buildBuyTx({ token: "MFT", route: routeOf("NET", "ETH>NET"), pools: POOLS, amountInWei: SIZE, minOutWei: 1n, deadline: 1n }), /token must be one of/);
    assert.throws(() => circle.buildBuyTx({ token: "ECO", route: routeOf("NET", "ETH>NET"), pools: POOLS, amountInWei: SIZE, minOutWei: 1n, deadline: 1n }), /does not end in ECO/);
    assert.throws(() => circle.buildBuyTx({ token: "ECO", route: { id: "x", tokens: ["ETH", "NET", "WETH", "ECO"], pools: ["netEth", "netWeth", "ecoEth"] }, pools: POOLS, amountInWei: SIZE, minOutWei: 1n, deadline: 1n }), /only at its start/);
    assert.throws(() => circle.buildBuyTx({ token: "ECO", route: routeOf("ECO", "WETH>ZORA>ECO"), pools: circle.POOLS, amountInWei: SIZE, minOutWei: 1n, deadline: 1n }), /no key/);
  });
});

describe("buy: the impact guard, measured", () => {
  it("probes one hundredth of the size, never below 0.000002 ETH and never above the size", () => {
    assert.equal(circle.probeSizeOf(10n ** 16n), 10n ** 14n);
    assert.equal(circle.probeSizeOf(10n ** 14n), circle.MIN_SIZE_WEI);
    assert.equal(circle.probeSizeOf(10n ** 12n), 10n ** 12n);
    assert.equal(circle.probeSizeOf(1n), 1n);
  });

  it("reads the impact as the token per ETH kept at your size against the probe's, in whole basis points rounded against the buyer", () => {
    const impact = (quoteOut, probeOut, amountInWei = 100n, probeInWei = 1n) => circle.buyImpactBps({ amountInWei, quoteOut, probeInWei, probeOut });
    assert.equal(impact(10_000n, 100n), 0);
    assert.equal(impact(9_900n, 100n), 100);
    assert.equal(impact(9_899n, 100n), 101); // rounds against the buyer
    assert.equal(impact(12_000n, 100n), 0); // never negative
    assert.equal(impact(0n, 100n), null);
    assert.equal(impact(9_900n, 0n), null);
  });
});

// A model of the pools for the offline reads: each hop "A>B" has a rate (B per A) and, optionally, a depth (the input at which the
// fill falls to nothing) and a minimum input. A hop that is missing, or a size under its minimum, reverts like a quote that cannot fill.
const SYM = Object.fromEntries(Object.entries(circle.TOKENS).map(([s, a]) => [a.toLowerCase(), s]));
const REVERT = { name: "ContractFunctionExecutionError", cause: { name: "ContractFunctionRevertedError", cause: { name: "RawContractError" } } };
const callOf = (c) => {
  if (c.args[0] && typeof c.args[0] === "object" && "exactCurrency" in c.args[0]) {
    return { v4: true, from: SYM[c.args[0].exactCurrency.toLowerCase()], seq: c.args[0].path.map((h) => SYM[h.intermediateCurrency.toLowerCase()]), amount: c.args[0].exactAmount };
  }
  const hex = c.args[0].toLowerCase().slice(2);
  const toks = [];
  for (let i = 0; i + 40 <= hex.length; i += 46) toks.push(SYM[`0x${hex.slice(i, i + 40)}`]);
  return { v4: false, from: toks[0], seq: toks.slice(1), amount: c.args[1] };
};
const modelOut = (hops, call) => {
  let x = Number(call.amount), from = call.from;
  for (const to of call.seq) {
    const h = hops[`${from}>${to}`];
    if (!h || x < (h.minIn ?? 0)) return null;
    x = Math.floor(x * h.rate * Math.max(0, 1 - x / (h.depth ?? Infinity)));
    from = to;
  }
  return x > 0 ? BigInt(x) : null;
};
const RATES = { "ETH>NET": { rate: 1000 }, "WETH>NET": { rate: 900 }, "ETH>ECO": { rate: 10 }, "WETH>ZORA": { rate: 100 }, "ZORA>ECO": { rate: 5 }, "NET>ECO": { rate: 20 } };
const fakeMulticall = (hops) => async ({ contracts }) => contracts.map((c) => {
  const call = callOf(c);
  const out = modelOut(hops, call);
  return out === null ? { status: "failure", error: REVERT } : { status: "success", result: call.v4 ? [out, 0n] : [out, [], [], 0n] };
});
const sweepFloorOf = (tx) => { const [, inputs] = decode(tx); return sweepArgs(inputs[inputs.length - 1])[2]; };
const fakeClient = ({ hops = RATES, simError = null, gas = 350_000n, fees = { maxFeePerGas: 7_000_000n, maxPriorityFeePerGas: 1_000_000n } } = {}) => {
  const seen = { calls: [] };
  return Object.assign({
    multicall: fakeMulticall(hops),
    getBlock: async () => ({ timestamp: 1_900_000_000n }),
    call: async (args) => { seen.calls.push(args); if (simError) throw simError; return { data: "0x" }; },
    estimateGas: async () => gas,
    estimateFeesPerGas: async () => fees,
  }, { seen });
};

describe("buy: quoting and choosing a route", () => {
  it("quotes every route exactly, and leaves out a route whose quote reverts with a plain line, never counting it as zero", async () => {
    const hops = { ...RATES };
    delete hops["ZORA>ECO"]; // the coin pool cannot fill
    const { quoted, leftOut } = await circle.quoteBuyRoutes(fakeClient({ hops }), { token: "ECO", pools: POOLS, amountInWei: SIZE });
    assert.deepEqual(quoted.map((q) => q.route.id).sort(), ["ETH>ECO", "ETH>NET>ECO", "WETH>NET>ECO"]);
    assert.equal(leftOut.length, 1);
    assert.match(leftOut[0], /^WETH>ZORA>ECO left out: its quote at your size reverted or pays nothing$/);
    assert.ok(quoted.every((q) => q.out > 0n));
  });

  it("leaves a route out when only its small probe cannot be quoted, because its impact cannot be measured", async () => {
    const hops = { ...RATES, "ETH>NET": { rate: 1000, minIn: Number(SIZE) } }; // fills at the size, reverts at the probe
    const { quoted, leftOut } = await circle.quoteBuyRoutes(fakeClient({ hops }), { token: "NET", pools: POOLS, amountInWei: SIZE });
    assert.deepEqual(quoted.map((q) => q.route.id), ["WETH>NET"]);
    assert.match(leftOut[0], /^ETH>NET left out: its small probe could not be quoted/);
  });

  it("throws on a failure that is not a revert: a read that failed says nothing about a route", async () => {
    const client = { multicall: async () => { throw Object.assign(new Error("rate limited"), { name: "HttpRequestError" }); } };
    await assert.rejects(circle.quoteBuyRoutes(client, { token: "NET", pools: POOLS, amountInWei: SIZE }), /rate limited|not a revert/);
  });

  it("takes the route that pays the most token, floors the quote by the slippage, and carries that floor in the transaction's last sweep", async () => {
    const client = fakeClient();
    const p = await circle.prepareBuy(client, { token: "ECO", from: FROM, amountInWei: SIZE, slippageBps: 250, pools: POOLS });
    assert.equal(p.sendable, true);
    assert.equal(p.route, "ETH>NET>ECO", "1000 x 20 beats 900 x 20, 500 and 10");
    assert.deepEqual(p.quotes.map((q) => q.route), ["ETH>NET>ECO", "WETH>NET>ECO", "WETH>ZORA>ECO", "ETH>ECO"], "best first");
    assert.equal(p.minOut, (p.quoteOut * 9_750n) / 10_000n);
    assert.equal(sweepFloorOf(p.tx), p.minOut);
    inspectBuy({ data: p.tx.data, to: p.tx.to, value: p.tx.valueWei }, { token: "ECO", floor: p.minOut });
    assert.equal(p.deadline, 1_900_000_060n);
    assert.equal(p.slippageBps, 250);
    assert.deepEqual(p.leftOut, []);
    assert.deepEqual(client.seen.calls.map((c) => [lower(c.account), c.value]), [[lower(FROM), SIZE]], "simulated once, as the sender, with the size as value");
  });

  it("buys NET only on its two routes, WETH or native, whichever pays more", async () => {
    const p = await circle.prepareBuy(fakeClient({ hops: { ...RATES, "WETH>NET": { rate: 2000 } } }), { token: "NET", from: FROM, amountInWei: SIZE, pools: POOLS });
    assert.equal(p.route, "WETH>NET");
    assert.deepEqual(p.quotes.map((q) => q.route), ["WETH>NET", "ETH>NET"]);
    assert.equal(p.disclosure, circle.BUY_DISCLOSURE.NET);
  });

  it("hands a native-ETH route's transaction to the simulation hook for both NET and ECO (a fake chain: it proves the route is chosen and encoded, not that it executes)", async () => {
    for (const token of ["NET", "ECO"]) {
      const client = fakeClient({ hops: { ...RATES, "WETH>NET": { rate: 1 }, "WETH>ZORA": { rate: 1 } } });
      const p = await circle.prepareBuy(client, { token, from: FROM, amountInWei: SIZE, pools: POOLS });
      assert.equal(p.sendable, true, token);
      assert.ok(p.route.startsWith("ETH>"), `${token}: expected a native-ETH route`);
      assert.equal(client.seen.calls.length, 1, `${token}: simulated once`);
      assert.equal(client.seen.calls[0].value, SIZE);
      inspectBuy({ data: p.tx.data, to: p.tx.to, value: p.tx.valueWei }, { token, floor: p.minOut });
    }
  });

  it("refuses when the best route's fill is worse than its probe by more than --max-impact-bps, and tries no lesser route", async () => {
    // depth 2e17 on the first hop: a 0.01 ETH fill keeps about 95% of what the probe's does, so about 500 bps of impact.
    // The lesser route has no depth limit, so it would pass the guard if it were ever tried: it must not be.
    const hops = { ...RATES, "ETH>NET": { rate: 1000, depth: 2e17 }, "WETH>NET": { rate: 900 } };
    const size = 10n ** 16n;
    const refused = await circle.prepareBuy(fakeClient({ hops }), { token: "NET", from: FROM, amountInWei: size, pools: POOLS });
    assert.equal(refused.sendable, false);
    assert.equal(refused.tx, null);
    assert.ok(refused.impactBps > 300 && refused.impactBps < 600, `impact ${refused.impactBps}`);
    assert.match(refused.reason, /above your --max-impact-bps 300/);
    assert.equal(refused.route, "ETH>NET");
    const allowed = await circle.prepareBuy(fakeClient({ hops }), { token: "NET", from: FROM, amountInWei: size, maxImpactBps: 1000, pools: POOLS });
    assert.equal(allowed.sendable, true);
    assert.equal(allowed.impactBps, refused.impactBps);
  });

  it("is not sendable, with a plain reason, when every route reverts, and when the simulation reverts", async () => {
    const none = await circle.prepareBuy(fakeClient({ hops: {} }), { token: "NET", from: FROM, amountInWei: SIZE, pools: POOLS });
    assert.equal(none.sendable, false);
    assert.equal(none.route, null);
    assert.equal(none.tx, null);
    assert.match(none.reason, /no route could be quoted/);
    assert.equal(none.leftOut.length, 2);
    const simError = Object.assign(new Error("reverted"), { data: toFunctionSelector("InsufficientToken()") });
    const failed = await circle.prepareBuy(fakeClient({ simError }), { token: "NET", from: FROM, amountInWei: SIZE, pools: POOLS });
    assert.equal(failed.sendable, false);
    assert.equal(failed.tx, null);
    assert.match(failed.reason, /reverts in simulation \(InsufficientToken\)/);
  });

  it("refuses a node's fee or gas above the kit's caps rather than pricing a transaction with it", async () => {
    await assert.rejects(circle.prepareBuy(fakeClient({ fees: { maxFeePerGas: circle.MAX_FEE_PER_GAS_WEI + 1n, maxPriorityFeePerGas: 1n } }), { token: "NET", from: FROM, amountInWei: SIZE, pools: POOLS }), /fee above/);
    await assert.rejects(circle.prepareBuy(fakeClient({ gas: circle.MAX_GAS + 1n }), { token: "NET", from: FROM, amountInWei: SIZE, pools: POOLS }), /above 6000000/);
  });

  it("refuses arguments outside their range before any read", async () => {
    const bad = (over) => circle.prepareBuy({}, { token: "NET", from: FROM, amountInWei: SIZE, ...over });
    await assert.rejects(bad({ amountInWei: 0n }), /--size must be above 0 and at most 0\.05 ETH/);
    await assert.rejects(bad({ amountInWei: circle.MAX_BUY_WEI + 1n }), /at most 0\.05 ETH/);
    await assert.rejects(bad({ token: "MFT" }), /--token is one of NET, ECO/);
    for (const slippageBps of [0, 501, 1.5, -1]) await assert.rejects(bad({ slippageBps }), /--slippage-bps is a whole number from 1 to 500/);
    for (const maxImpactBps of [0, 1001, 2.5]) await assert.rejects(bad({ maxImpactBps }), /--max-impact-bps is a whole number from 1 to 1000/);
    await assert.rejects(bad({ deadlineSeconds: 4 }), /--deadline-seconds/);
  });
});

// A local JSON-RPC node that is Base for the buy act: it answers the coin pool key, the quoters (through multicall3) from the model above,
// the simulation, the block and the fee reads, so the real command line runs end to end with no network.
const V4Q = parseAbi(["function quoteExactInput((address exactCurrency, (address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)[] path, uint128 exactAmount) params) returns (uint256 amountOut, uint256 gasEstimate)"]);
const V3Q = parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"]);
const COIN_ABI = parseAbi(["function getPoolKey() view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)"]);
const BLOCK = { number: "0x64", hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}`, nonce: "0x0000000000000000", sha3Uncles: `0x${"00".repeat(32)}`, logsBloom: `0x${"00".repeat(256)}`, transactionsRoot: `0x${"00".repeat(32)}`, stateRoot: `0x${"00".repeat(32)}`, receiptsRoot: `0x${"00".repeat(32)}`, miner: circle.ETH, difficulty: "0x0", totalDifficulty: "0x0", extraData: "0x", size: "0x100", gasLimit: "0x1c9c380", gasUsed: "0x0", timestamp: "0x70000000", transactions: [], uncles: [], baseFeePerGas: "0x5f5e100", mixHash: `0x${"00".repeat(32)}` };

async function withBuyNode({ hops = RATES, chainId = "0x2105", sim = "ok", status = 200 } = {}, fn) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (status !== 200) { res.statusCode = status; return res.end("no"); }
      const msg = JSON.parse(body);
      const reply = (o) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, ...o })); };
      const ok = (result) => reply({ result });
      if (msg.method === "eth_chainId") return ok(chainId);
      if (msg.method === "eth_getBlockByNumber") return ok(BLOCK);
      if (msg.method === "eth_maxPriorityFeePerGas") return ok("0xf4240");
      if (msg.method === "eth_estimateGas") return ok("0x57508");
      if (msg.method !== "eth_call") return reply({ error: { code: -32601, message: "method not found" } });
      const { to, data } = msg.params[0];
      if (lower(to) === lower(circle.TOKENS.ECO)) return ok(encodeFunctionResult({ abi: COIN_ABI, functionName: "getPoolKey", result: [COIN_KEY.currency0, COIN_KEY.currency1, COIN_KEY.fee, COIN_KEY.tickSpacing, COIN_KEY.hooks] }));
      if (lower(to) === lower(circle.CONTRACTS.UNIVERSAL_ROUTER)) {
        if (sim === "ok") return ok("0x");
        return reply({ error: { code: 3, message: "execution reverted", data: toFunctionSelector("InsufficientToken()") } });
      }
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      const results = args[0].map((c) => {
        const v4 = lower(c.target) === lower(circle.CONTRACTS.V4_QUOTER);
        const call = callOf({ args: decodeFunctionData({ abi: v4 ? V4Q : V3Q, data: c.callData }).args });
        const out = modelOut(hops, call);
        if (out === null) return { success: false, returnData: "0x" };
        return { success: true, returnData: encodeFunctionResult({ abi: v4 ? V4Q : V3Q, functionName: "quoteExactInput", result: v4 ? [out, 0n] : [out, [], [], 0n] }) };
      });
      return ok(encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const runCli = (args) => new Promise((resolve) => {
  execFile(process.execPath, [SRC, ...args], { encoding: "utf8" }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});

describe("buy: the command line, end to end against a local node", () => {
  const args = (rpc, ...more) => ["buy", "--token", "ECO", "--from", FROM, "--size", "0.001", "--rpc", rpc, ...more];

  it("prints { sendable, prepared } as JSON with the tx in the fields prepare prints, and exits 0", async () => {
    const r = await withBuyNode({}, (rpc) => runCli(args(rpc, "--json")));
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), ["prepared", "sendable"]);
    assert.equal(out.sendable, true);
    const p = out.prepared;
    for (const k of ["token", "route", "amountInWei", "quoteOut", "minOut", "impactBps", "slippageBps", "deadline", "disclosure", "tx"]) assert.ok(k in p, k);
    assert.equal(p.token, "ECO");
    assert.equal(p.route, "ETH>NET>ECO");
    assert.equal(p.amountInWei, SIZE.toString());
    assert.match(p.quoteOut, /^\d+$/);
    assert.equal(BigInt(p.minOut), (BigInt(p.quoteOut) * 9_900n) / 10_000n);
    assert.equal(p.slippageBps, 100);
    assert.equal(p.deadline, "1879048252", "the chain's block time (0x70000000) plus 60 seconds");
    assert.equal(p.disclosure, circle.BUY_DISCLOSURE.ECO);
    assert.deepEqual(Object.keys(p.tx), ["to", "data", "value", "valueWei", "chainId", "gas", "maxFeePerGas", "maxPriorityFeePerGas"]);
    assert.equal(p.tx.value, "0x38d7ea4c68000");
    assert.equal(p.tx.valueWei, SIZE.toString());
    assert.equal(p.tx.chainId, 8453);
    assert.equal(BigInt(p.tx.gas), (357_640n * 3n) / 2n, "the node's estimate (0x57508) times 1.5");
    assert.equal(lower(p.tx.to), lower(circle.CONTRACTS.UNIVERSAL_ROUTER));
    inspectBuy({ data: p.tx.data, to: p.tx.to, value: BigInt(p.tx.valueWei) }, { token: "ECO", floor: BigInt(p.minOut) });
  });

  it("prints the human output with the disclosure words and the floor, and exits 0", async () => {
    const r = await withBuyNode({}, (rpc) => runCli(args(rpc)));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /route ETH>NET>ECO: NET\/ETH V4 0\.01% \(native ETH\), then NET\/ECO V4 0\.01%/);
    assert.match(r.stdout, /at least the floor arrives in one transaction, or the whole transaction reverts; you pay the ETH stated and gas/);
    assert.match(r.stdout, /SENDABLE: sign and send the tx below/);
    assert.ok(r.stdout.includes(circle.BUY_DISCLOSURE.ECO));
  });

  it("exits 10 with the reason in prepared.reason when the simulation reverts, and when the impact is over the guard", async () => {
    const reverted = await withBuyNode({ sim: "revert" }, (rpc) => runCli(args(rpc, "--json")));
    assert.equal(reverted.code, 10);
    const a = JSON.parse(reverted.stdout);
    assert.equal(a.sendable, false);
    assert.match(a.prepared.reason, /reverts in simulation \(InsufficientToken\)/);
    assert.equal(a.prepared.tx, null);
    const hops = { ...RATES, "ETH>NET": { rate: 1000, depth: 2e16 }, "WETH>NET": { rate: 900, depth: 2e16 } };
    const heavy = await withBuyNode({ hops }, (rpc) => runCli(["buy", "--token", "NET", "--from", FROM, "--size", "0.01", "--rpc", rpc, "--json"]));
    assert.equal(heavy.code, 10);
    const b = JSON.parse(heavy.stdout);
    assert.equal(b.sendable, false);
    assert.match(b.prepared.reason, /--max-impact-bps 300/);
    assert.equal(b.prepared.tx, null);
    assert.equal(b.prepared.disclosure, circle.BUY_DISCLOSURE.NET);
  });

  it("exits 3 on a node that is not Base, and 1 when a read fails", async () => {
    assert.equal((await withBuyNode({ chainId: "0x1" }, (rpc) => runCli(args(rpc)))).code, 3);
    assert.equal((await withBuyNode({ status: 500 }, (rpc) => runCli(args(rpc)))).code, 1);
  });

  it("exits 2 on bad arguments, before touching any network", () => {
    const run = (more) => { try { execFileSync(process.execPath, [SRC, "buy", ...more], { encoding: "utf8", stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
    const ok = ["--token", "NET", "--from", FROM, "--size", "0.001"];
    const without = (flag) => ok.filter((_, i, a) => a[i] !== flag && a[i - 1] !== flag);
    assert.equal(run(without("--token")), 2);
    assert.equal(run(without("--size")), 2);
    assert.equal(run(without("--from")), 2);
    assert.equal(run(["--token", "MFT", "--from", FROM, "--size", "0.001"]), 2);
    for (const size of ["0", "0.0500001", "1", "abc", "-1"]) assert.equal(run(["--token", "NET", "--from", FROM, "--size", size]), 2, size);
    for (const slip of ["0", "501", "1.5", "x"]) assert.equal(run([...ok, "--slippage-bps", slip]), 2, slip);
    for (const imp of ["0", "1001", "2.5"]) assert.equal(run([...ok, "--max-impact-bps", imp]), 2, imp);
    assert.equal(run([...ok, "--deadline-seconds", "4"]), 2);
    assert.equal(run([...ok, "--loop", "mft"]), 2);
    assert.equal(run([...ok, "--min-profit-wei", "1"]), 2);
    const runOther = (cmd, more) => { try { execFileSync(process.execPath, [SRC, cmd, ...more], { encoding: "utf8", stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
    assert.equal(runOther("prepare", ["--from", FROM, "--token", "NET"]), 2, "--token is for buy only");
    assert.equal(runOther("prepare", ["--from", FROM, "--slippage-bps", "50"]), 2);
    assert.equal(runOther("quote", ["--max-impact-bps", "50"]), 2);
  });

  it("lists buy in the help, with its exit codes", () => {
    const help = execFileSync(process.execPath, [SRC, "--help"], { encoding: "utf8" });
    assert.match(help, /node net-circle\.mjs buy --token NET\|ECO --from 0xYOU --size <ETH>/);
    assert.match(help, /10 prepare, buy: nothing sendable now/);
  });
});
