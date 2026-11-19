---
name: net-circle
description: Quote every ETH loop through the NET token's pools on Base (the buying in NET's pools is the house's own) and take one with your own wallet. prepare returns ONE unsigned Universal Router transaction that trades exactly the size it states and reverts unless at least input plus gas comes back. buy prepares a one-way swap of ETH into NET or ECO as ONE unsigned transaction that reverts unless at least a printed minimum of the token arrives. Holds no key, signs nothing, sends nothing.
---

# The NET circle

NET trades in four small Uniswap V4 pools on Base that this kit quotes, against WETH, native ETH, ECO and VVV (the buying in NET's pools is the house's own). NET has a fifth pool, against HYDROC, that this kit does not quote; the sibling kit `skills/protocol-guide` reads the pools with ETH, WETH, ECO and HYDROC. ECO in turn trades against ZORA, MfT, axlREGEN and ETH. When one pool moves and the others have not caught up, a trade around a loop returns more ETH than it took. This program quotes twelve such loops, finds the size that pays most after gas, and prepares that trade as one transaction you sign. It also has one act that is not a loop: `buy`, a one-way swap of ETH into NET or into ECO (see "The buy act" below).

| Loop (`--loop`) | Legs in the `buy-net` direction (`sell-net` is the reverse) | Pool fees |
|---|---|---|
| `zora` | ETH → NET → ECO → ZORA (Zora coin pool) → ETH | 3.32% |
| `mft` | ETH → NET → ECO → MfT → ETH | 1.02% plus a dynamic hook fee |
| `axlregen` | ETH → NET → ECO → axlREGEN → ETH | 2.02% |
| `eth` | ETH → NET → ECO → ETH | 1.02% |
| `vvv` | ETH → NET → VVV → ETH | 1.02% |
| `net-pools` | ETH → NET (NET/WETH) → ETH (NET/ETH native) | 0.02% |

## Install and run

Node 20 or newer. Use an RPC node you trust: the program refuses fees above 10 gwei and gas estimates above 6M, but a node can still lie about prices and simulations.

```bash
npm ci                                           # installs viem from the lockfile; this package has no install scripts
npm test                                         # offline tests, including real viem errors from a mock node
node net-circle.mjs                              # every loop: gap, fees, and whether any size pays after gas
node net-circle.mjs pools                        # every pool's id and liquidity; the NET pools' holdings and burned positions (the buying in NET's pools is the house's own)
node net-circle.mjs selftest --from 0xYOU        # proves every loop's path executes today (simulation)
node net-circle.mjs prepare --from 0xYOU --json  # the best loop as one unsigned tx, only when it is worth sending
node net-circle.mjs watch --from 0xYOU --every 30 > trades.jsonl   # one JSON line per sendable trade
node net-circle.mjs buy --token NET --from 0xYOU --size 0.001 --json   # a one-way buy: ETH into NET (or --token ECO) as one unsigned tx with a floor
node net-circle.mjs --help
```

`--rpc <url>` or `BASE_RPC_URL` picks the node; the default is `https://mainnet.base.org`. `prepare` and `watch` also take:
- `--loop <id or family>`
- `--size <ETH>`, at most 1 ETH
- `--min-profit-wei <wei>`, 0 or more
- `--deadline-seconds`, from 5 to 600 (default 30)
- for `watch`, `--every`, from 10 to 3600 seconds

A full quote takes about 2 to 3 seconds.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | ok; for `prepare` or `buy`, a sendable tx was printed |
| `2` | bad arguments, including an unknown `--loop` and, for `buy`, a size above 0.05 ETH |
| `3` | the RPC is not Base |
| `4` | `selftest`: a loop's path fails |
| `10` | `prepare` found nothing worth sending, or `buy` found nothing sendable (the reason is printed, and in `prepared.reason`) |
| `1` | a read failed, or the RPC returned an implausible fee or gas; nothing was decided |

## Reading the output

- **gap**: how much more ETH comes back than goes in, at the smallest size that fills, after pool fees, before gas. A positive gap means the loop is out of line. The pools are shallow, so the gap shrinks fast as the size grows.
- **PAYS x at y in**: at input `y` the loop returns `x` more ETH than it took, after gas priced the way the floor prices it. Otherwise the line reads **no size pays after gas**, meaning no size from 0.000002 to 0.01 ETH, with the gas one try would cost.
- `prepare --json` always carries:
  - `sendable` (true or false).
  - `prepared`, with these fields:

    | Field | Meaning |
    |---|---|
    | `loop` | the loop id |
    | `amountInWei` | the trade size |
    | `minEthOutWei` | the floor |
    | `gasEstimate` | the gas estimate |
    | `gasLimit` | 1.5 times the estimate |
    | `gasCostWei` | the floor's gas budget |
    | `l1FeeWei` | the L1 data-fee bound |
    | `deadline` | unix seconds, from the chain's clock |
    | `pathExecutes` | whether the path runs at all |
    | `guardedError` | the revert reason under the floor, if any |
    | `reason` | why it is not sendable, if it is not |
    | `tx` | the transaction; `null` unless `sendable` |

- `tx` is ready for a wallet: `to`, `data`, `value`, `gas`, `maxFeePerGas` and `maxPriorityFeePerGas` as hex quantities, plus `valueWei` in decimal and `chainId` 8453.
- `watch` prints one line per sendable trade: `{ at, block, loop, deadline, floorWei, tx }`. It never prints the same loop again while its last line is still inside its deadline, so a signer that sends every line never has two live transactions for one loop.

## Sign and send

Send `tx` exactly as given, before `deadline`, with its fee fields.

viem, with an account you control:

```js
import { createWalletClient, http, hexToBigInt } from "viem";
import { base } from "viem/chains";
const { sendable, prepared } = JSON.parse(output);   // output of: node net-circle.mjs prepare --from <account> --json (or buy, with the same tx fields)
if (sendable) {
  const { tx } = prepared;
  const wallet = createWalletClient({ account, chain: base, transport: http() });
  await wallet.sendTransaction({ to: tx.to, data: tx.data, value: hexToBigInt(tx.value), gas: hexToBigInt(tx.gas),
    maxFeePerGas: hexToBigInt(tx.maxFeePerGas), maxPriorityFeePerGas: hexToBigInt(tx.maxPriorityFeePerGas) });
}
```

**Any wallet over JSON-RPC:** call `eth_sendTransaction` with `[{ from, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas }]`, the fields as printed.

**A smart wallet (EIP-5792):** call `wallet_sendCalls` with `{ version: "2.0.0", chainId: "0x2105", from, atomicRequired: true, calls: [{ to, data, value }] }`. Run `prepare --from` with the smart wallet's own address. Its bundler sets the fee, so the floor covers your input but not what the bundler charges; add `--min-profit-wei` to cover it.

## The buy act (one way, ETH into NET or ECO)

`buy` is not a loop. It spends ETH and ends holding the token. It prepares ONE unsigned Universal Router transaction that swaps the ETH it carries into NET or into ECO, and reverts unless at least a printed minimum of the token arrives. It holds no key, signs nothing and sends nothing: you sign what it prints, with the same `tx` fields and the same send steps as above.

```bash
node net-circle.mjs buy --token NET|ECO --from 0xYOU --size <ETH> [--slippage-bps 100] [--max-impact-bps 300] [--deadline-seconds 60] [--json]
```

| Flag | Meaning |
|---|---|
| `--token` | `NET` or `ECO` (required) |
| `--from` | your address; the simulation runs as you (required) |
| `--size` | the ETH to spend: above 0 and at most 0.05 (required) |
| `--slippage-bps` | the room between the quote and the floor, a whole number from 1 to 500 (default 100) |
| `--max-impact-bps` | the price-impact guard below, a whole number from 1 to 1000 (default 300) |
| `--deadline-seconds` | from 5 to 600 (default 60), counted from the chain's clock |

**The routes.** `buy` tries a fixed list of paths over this kit's own pools and takes the one whose exact quote pays the most token. The list is fixed on purpose: each token's disclosure (below) is fixed wording, so it has to be complete for every path that token can take.

| Token | Route id | Pools |
|---|---|---|
| NET | `ETH>NET` | NET/ETH V4 (native ETH) |
| NET | `WETH>NET` | NET/WETH V4 (the ETH is wrapped first) |
| ECO | `ETH>ECO` | ETH/ECO V4 1% |
| ECO | `WETH>ZORA>ECO` | ZORA/WETH V3 0.3%, then the Zora coin pool (ECO's own market; read live from `ECO.getPoolKey()`, and refused if ECO is no longer paired with ZORA) |
| ECO | `ETH>NET>ECO` | NET/ETH V4, then NET/ECO V4 |
| ECO | `WETH>NET>ECO` | NET/WETH V4, then NET/ECO V4 |

Every route is quoted exactly with the same V4 and V3 quoters the loops use, at your size and at a small probe size. A route whose quote reverts or pays nothing is LEFT OUT with a plain line (`WETH>ZORA>ECO left out: its quote at your size reverted or pays nothing`), also listed in `prepared.leftOut`. It is never counted as zero. A failed read (a node error or a rate limit) is not a revert: it exits 1 and decides nothing. `prepared.quotes` lists every route that quoted, best first.

**What it can cost.** The ETH you state with `--size`, at most 0.05, plus gas. At least the printed `minOut` of the token reaches your address in that one transaction, or the whole transaction reverts and you pay only the gas of the revert. The swap spends only the ETH the transaction carries: it never pulls a token from your wallet and needs no approval. `tx.value` equals `--size` exactly.

**The floor.** `minOut` is the best route's quote less `--slippage-bps`: `minOut = quote x (10000 - slippage-bps) / 10000`, rounded down, in the token's smallest unit. It is enforced inside the transaction, as the amount minimum of the LAST command (a sweep of the token to you), so it is checked after every swap. If less arrives the transaction reverts. The floor protects the amount that arrives. It does not protect the price you accept: the pools are small, and the quote is a reading of one moment.

**The impact guard.** After it picks the best route, `buy` measures price impact on that route against a probe of the same route at one hundredth of your size (never below 0.000002 ETH, never above your size). In whole numbers: `impactBps = 10000 - floor(quoteOut x probeIn x 10000 / (probeOut x sizeIn))`, or 0 if that is negative. That is how many basis points less token per ETH your size gets than the probe gets. It rounds against you. The probe has a little impact of its own, which is not counted, so the figure reads slightly low. If `impactBps` is above `--max-impact-bps`, `buy` refuses (exit 10, a plain reason, nothing to sign) and does not try a lesser route: use a smaller `--size`, or raise the guard on purpose. A route whose probe cannot be quoted is left out, because its impact cannot be measured.

**What is in the transaction**, for a program that checks it before signing:
- Only these Universal Router commands, by exact byte, none with the allow-revert flag: `V3_SWAP_EXACT_IN` 0x00, `SWEEP` 0x04, `WRAP_ETH` 0x0b, `V4_SWAP` 0x10. Inside `V4_SWAP` only `SETTLE` 0x0b, `SWAP_EXACT_IN` 0x07, `TAKE` 0x0e. (`UNWRAP_WETH` 0x0c never appears.)
- `payerIsUser` is false in every swap and every settle. `WRAP_ETH`, when present, wraps `--size` (at most the value) to the router. Every intermediate recipient is the router (`ADDRESS_THIS`, 0x…02).
- The LAST command is a `SWEEP` of the bought token to `MSG_SENDER` (0x…01) with `amountMin` equal to `minOut`. There is nothing after it.
- `tx.value` is `--size` in wei, `tx.to` is the Universal Router `0x6fF5693b99212Da76ad316178A184AB56D299b43`, `tx.chainId` is 8453. The command bytes are `0x1004` for the native routes, `0x0b1004` for the wrapped routes through V4, and `0x0b001004` for `WETH>ZORA>ECO`.

**The output.** `--json` prints `{ "sendable": true|false, "prepared": { ... } }`. `prepared` always carries:

| Field | Meaning |
|---|---|
| `sendable` | the same as the top-level flag |
| `token` | `NET` or `ECO` |
| `route` | the route id taken, or `null` when none could be quoted |
| `amountInWei` | the size, a decimal string |
| `quoteOut` | the exact quote, in the token's smallest unit (18 decimals), a decimal string |
| `minOut` | the floor, in the same unit; the same number as the last sweep's `amountMin` |
| `impactBps` | the measured impact, whole basis points |
| `slippageBps` | the value used |
| `deadline` | unix seconds, from the chain's clock |
| `disclosure` | the line for this token, below |
| `quotes` | `[{ route, quoteOut }]`, best first |
| `leftOut` | one plain line per route left out |
| `reason` | why it is not sendable, or `null` |
| `tx` | `to`, `data`, `value`, `valueWei`, `chainId`, `gas`, `maxFeePerGas`, `maxPriorityFeePerGas`, the same fields `prepare` prints; `null` unless sendable |

The program refuses a node fee above 10 gwei or a gas estimate above 6M, as `prepare` does, and simulates the transaction as `--from` at the pending block before it prints it. A transaction that reverts in simulation is not printed.

**What `buy` says about itself.** It prints these lines in its human output and in `prepared.disclosure`. They are facts about EcoWealth's interest. `buy` is not an offer or advice, it promises no return, and it says nothing about where any price will go.
- For NET: "As of 2026-11-18, EcoWealth created NET and holds it. The buying in NET's pools is the house's own."
- For ECO: "As of 2026-11-18, EcoWealth created ECO, holds it and gains if it rises. ECO bought through WETH>NET>ECO or ETH>NET>ECO passes through NET's pools, and the buying in NET's pools is the house's own. Buying through the Zora coin pool may pay ECO creator fees to EcoWealth."

## What the floor protects in a loop, and what it does not

The transaction trades exactly the stated input and sends back any extra ETH you attached. Then it runs the loop and pays you only if at least `input + gas + --min-profit-wei` comes back. Below that, the whole transaction reverts.

The gas share of the floor is the whole gas limit it hands you at its `maxFeePerGas`, plus twice the L1 data-fee bound. An ordinary account that sends with those fields cannot pay more L2 gas than the floor allows for. The L1 fee could only exceed its share if Ethereum's data fee more than doubled before the deadline. The program refuses a floor at or below the input, and a negative `--min-profit-wei`.

It does **not** protect profit, and it does not stop someone else from closing the gap first:
- Base has no public mempool, but your RPC provider sees what you send, and blocks order by priority fee.
- Other bots watch these same pools. When you lose that race, the transaction reverts and you pay its gas. Expect to lose some.
- Gas also grows with size, because larger trades cross more ticks in these thin pools. If prices move between `prepare` and inclusion, a trade can run past its 1.5x limit and revert out of gas, which also costs its gas.

## What it is honestly worth

- **The pools are tiny.** Run `pools` to see them (the buying in NET's pools is the house's own). On 2026-11-08 and 09:
  - NET/WETH held about 0.0158 WETH, about $34.
  - NET/ETH held about 0.0009 ETH.
  - NET/VVV held about 0.098 VVV.
  - NET/ECO held about 12M ECO.

  What comes back here is cents at most, and gas can be more than any gap.
- **Gas for one try** (a revert costs the same as a success), measured with `eth_estimateGas` on 2026-11-08:

  | Loop | Gas at 0.00005 to 0.0001 ETH | Larger sizes |
  |---|---|---|
  | `zora` (Zora's coin hook) | 1.39M to 1.51M | |
  | `mft` | about 445k | |
  | `axlregen` | about 260k | |
  | `eth` | about 222k | 277k at 0.001 ETH, 585k at 0.01 |
  | `net-pools` | 214k to 244k | 542k at 0.001 ETH, 1.35M at 0.01 |

  At 0.006 to 0.007 gwei, a dust-size try costs roughly a third of a US cent to two cents.
- **The largest gaps on 2026-11-09:** `vvv:buy-net` +4.69%, `axlregen:buy-net` +2.94% and `mft:buy-net` +2.44%. None paid after gas, because the pools are too shallow to carry a size where the gap beats the gas. Gaps open when NET, ECO, ZORA, MfT, axlREGEN or VVV move. As of 2026-11-18, EcoWealth buys NET regularly in small amounts.
- **The buying in NET's pools is the house's own.** NET's market value is mostly EcoWealth's own buying, which is our own demand, not outside demand. What any holder can take out of a pool is its reserve, never a quoted price.

## EcoWealth's interest, disclosed

EcoWealth created ECO and NET and holds both, so it gains when they rise. In the Zora coin pool, about 42% of the 3% fee comes back to EcoWealth as ECO's creator, from a measurement made in September 2026 that is not a current rate. That is about 1.26% of whatever passes through the `zora` loops' ECO leg. ECO's other Zora pool (ECO/MfT V3) may also pay its creator a share.

The NET pools' only liquidity is their burned founding positions, so their 0.01% fees go to no one. Loops that buy NET pay ETH into a NET pool. Loops that sell NET take it out. Any spread there is, you keep, and gas can exceed it.

## Pools and proofs (Base, chain 8453)

The four NET pools this kit quotes (the buying in NET's pools is the house's own). NET also has a fifth pool, against HYDROC, that this kit does not quote.

| Pool | V4 pool id | Founding position |
|---|---|---|
| NET/WETH 0.01% | `0x9d11774f380cff94a226e3f79d52daeb7e093fddb2646fd2ade68794e30b2ba3` | #2868574, owned by `0x…dEaD` |
| NET/ETH 0.01% (native) | `0x9f2ff5c43e7f8cd421a120a985d186ecb0a7a3f6ee915fa5e406282bc53549a8` | #3184094, owned by `0x…dEaD` |
| NET/ECO 0.01% | `0xf3a5143f135434ef4e500cc128b19af0bc2dcb90b6e04c4613e3338711074301` | #2865929, owned by `0x…dEaD` |
| NET/VVV 0.01% | `0x455e9cdf582db22cba682a385e53761aa47676ac6c95309d8b6431b968ab6f6a` | #3208643, owned by `0x…dEaD` |

`pools` reads each founding position's owner, and its share of the pool's liquidity, live from the V4 PositionManager. On 2026-11-09 each was owned by `0x…dEaD` and held 100% of its pool. Anyone may still add or remove other liquidity. The coin pool and the V3 pools are not burned.

The coin pool's key (fee, tick spacing, hook) is read from `ECO.getPoolKey()` on every run, and the program refuses to route if ECO stops being paired with ZORA.

**Tokens:**
- NET `0xE37A9125B6b14D5e8Ec056C744a99F4deC975022`
- ECO `0x170dC0ca26F1247CED627D8aBcaFA90ecf1e1519`
- ZORA `0x1111111111166b7FE7bd91427724B487980aFc69`
- MfT `0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3`
- axlREGEN `0x2E6C05f1f7D1f4Eb9A088bf12257f1647682b754`
- VVV `0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf`
- WETH `0x4200000000000000000000000000000000000006`

**Contracts:**
- Universal Router `0x6fF5693b99212Da76ad316178A184AB56D299b43`. Its four-field V4 swap encoding is specific to this deployment, so do not point the program at another router.
- V4 Quoter `0x0d5e0f971ed27fbff6c2837bf31316121532048d`
- V3 Quoter `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`

Licensed Apache-2.0, as is the rest of this repository (see its root `LICENSE`).
