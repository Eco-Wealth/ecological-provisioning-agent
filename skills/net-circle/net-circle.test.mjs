// Offline tests for net-circle: `node --test net-circle.test.mjs` (no network, no key).
// Each loop is one Universal Router call that trades exactly the stated input, refunds any extra ETH outside the floor,
// and pays the sender only above a floor that must exceed the input. Network failures never pass for empty pools.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAbiParameters, decodeFunctionData, parseAbi, parseAbiParameters } from "viem";
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
