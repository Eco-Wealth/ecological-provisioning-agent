---
name: net-circle
description: Quote every ETH loop through the NET token's pools on Base and take one with your own wallet. prepare returns ONE unsigned Universal Router transaction that trades exactly the size it states and reverts unless at least input plus gas comes back. Holds no key, signs nothing, sends nothing.
---

# The NET circle

NET trades in four small Uniswap V4 pools on Base, against WETH, native ETH, ECO and VVV. ECO in turn trades against ZORA, MfT, axlREGEN and ETH. When one pool moves and the others have not caught up, a trade around a loop returns more ETH than it took. This program quotes twelve such loops, finds the size that pays most after gas, and prepares that trade as one transaction you sign.

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
node net-circle.mjs pools                        # every pool's id and liquidity; the NET pools' holdings and burned positions
node net-circle.mjs selftest --from 0xYOU        # proves every loop's path executes today (simulation)
node net-circle.mjs prepare --from 0xYOU --json  # the best loop as one unsigned tx, only when it is worth sending
node net-circle.mjs watch --from 0xYOU --every 30 > trades.jsonl   # one JSON line per sendable trade
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
| `0` | ok; for `prepare`, a sendable tx was printed |
| `2` | bad arguments, including an unknown `--loop` |
| `3` | the RPC is not Base |
| `4` | `selftest`: a loop's path fails |
| `10` | `prepare` found nothing worth sending |
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
const { sendable, prepared } = JSON.parse(output);   // output of: node net-circle.mjs prepare --from <account> --json
if (sendable) {
  const { tx } = prepared;
  const wallet = createWalletClient({ account, chain: base, transport: http() });
  await wallet.sendTransaction({ to: tx.to, data: tx.data, value: hexToBigInt(tx.value), gas: hexToBigInt(tx.gas),
    maxFeePerGas: hexToBigInt(tx.maxFeePerGas), maxPriorityFeePerGas: hexToBigInt(tx.maxPriorityFeePerGas) });
}
```

**Any wallet over JSON-RPC:** call `eth_sendTransaction` with `[{ from, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas }]`, the fields as printed.

**A smart wallet (EIP-5792):** call `wallet_sendCalls` with `{ version: "2.0.0", chainId: "0x2105", from, atomicRequired: true, calls: [{ to, data, value }] }`. Run `prepare --from` with the smart wallet's own address. Its bundler sets the fee, so the floor covers your input but not what the bundler charges; add `--min-profit-wei` to cover it.

## What the floor protects, and what it does not

The transaction trades exactly the stated input and sends back any extra ETH you attached. Then it runs the loop and pays you only if at least `input + gas + --min-profit-wei` comes back. Below that, the whole transaction reverts.

The gas share of the floor is the whole gas limit it hands you at its `maxFeePerGas`, plus twice the L1 data-fee bound. An ordinary account that sends with those fields cannot pay more L2 gas than the floor allows for. The L1 fee could only exceed its share if Ethereum's data fee more than doubled before the deadline. The program refuses a floor at or below the input, and a negative `--min-profit-wei`.

It does **not** protect profit, and it does not stop someone else from closing the gap first:
- Base has no public mempool, but your RPC provider sees what you send, and blocks order by priority fee.
- Other bots watch these same pools. When you lose that race, the transaction reverts and you pay its gas. Expect to lose some.
- Gas also grows with size, because larger trades cross more ticks in these thin pools. If prices move between `prepare` and inclusion, a trade can run past its 1.5x limit and revert out of gas, which also costs its gas.

## What it is honestly worth

- **The pools are tiny.** Run `pools` to see them. On 2026-11-08 and 09:
  - NET/WETH held about 0.0158 WETH, about $34.
  - NET/ETH held about 0.0009 ETH.
  - NET/VVV held about 0.098 VVV.
  - NET/ECO held about 12M ECO.

  Profits here are cents at most.
- **Gas for one try** (a revert costs the same as a success), measured with `eth_estimateGas` on 2026-11-08:

  | Loop | Gas at 0.00005 to 0.0001 ETH | Larger sizes |
  |---|---|---|
  | `zora` (Zora's coin hook) | 1.39M to 1.51M | |
  | `mft` | about 445k | |
  | `axlregen` | about 260k | |
  | `eth` | about 222k | 277k at 0.001 ETH, 585k at 0.01 |
  | `net-pools` | 214k to 244k | 542k at 0.001 ETH, 1.35M at 0.01 |

  At 0.006 to 0.007 gwei, a dust-size try costs roughly a third of a US cent to two cents.
- **The largest gaps on 2026-11-09:** `vvv:buy-net` +4.69%, `axlregen:buy-net` +2.94% and `mft:buy-net` +2.44%. None paid after gas, because the pools are too shallow to carry a size where the gap beats the gas. Gaps open when NET, ECO, ZORA, MfT, axlREGEN or VVV move. EcoWealth buys NET regularly in small amounts.
- **NET's price is set by EcoWealth's own buying** until an outside trade confirms it. The NET/WETH pool's ratio implies about $1.8M per NET, against $34 of ETH. What any holder can take out of a pool is its reserve, never the quoted price.

## EcoWealth's interest, disclosed

EcoWealth created ECO and NET and holds both, plus MfT, so it gains when they rise. In the Zora coin pool, about 42% of the 3% fee comes back to EcoWealth as ECO's creator, measured. That is about 1.26% of whatever passes through the `zora` loops' ECO leg, which is larger than any gap seen so far. ECO's other Zora pool (ECO/MfT V3) may also pay its creator a share.

The NET pools' only liquidity is their burned founding positions, so their 0.01% fees go to no one. Loops that buy NET pay ETH into a NET pool. Loops that sell NET take it out. You keep the spread.

## Pools and proofs (Base, chain 8453)

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
