---
name: net-circle
description: Find and take the ETH / NET / ECO / ZORA circle on Base with your own wallet. One command quotes the loop both ways; prepare returns ONE unsigned Universal Router transaction that starts and ends in native ETH and reverts unless you get back more than you put in plus gas. Holds no key, signs nothing, sends nothing.
---

# The NET circle

Four pools on Base form one loop:

| Pool | Venue | Fee |
|---|---|---|
| NET / WETH | Uniswap V4, liquidity burned (permanent) | 0.01% |
| NET / ECO | Uniswap V4, liquidity burned (permanent) | 0.01% |
| ECO / ZORA | Uniswap V4, the Zora coin pool for ECOWEALTH (Zora's hook) | 3% |
| ZORA / WETH | Uniswap V3 | 0.3% |

When one pool moves and the others have not caught up, a trade around the loop returns more ETH than it took. Two things move the pools: EcoWealth buys NET with ECO on a regular schedule (that lifts NET in the NET/ECO pool), and ZORA moves against ETH (that shifts ECO's price in the coin pool). Whoever closes the gap keeps the spread.

- **forward:** ETH to NET (NET/WETH), NET to ECO (NET/ECO), ECO to ZORA (coin pool), ZORA to ETH (V3).
- **reverse:** the same loop the other way.

## Run it

```bash
npm install            # viem only
node net-circle.mjs                                   # quote both directions at the best size
node net-circle.mjs prepare --from 0xYourAddress      # best trade as one unsigned tx, simulated
node net-circle.mjs prepare --from 0xYou --direction reverse --size 0.0002 --json
```

`--rpc <url>` or `BASE_RPC_URL` picks the node (default `https://mainnet.base.org`). `--min-profit-wei N` raises the floor. `--deadline-seconds N` (default 120).

`prepare` prints `{ to, data, value, chainId, gas }`. Sign and send it with whatever wallet you already use (viem `sendTransaction`, `cast send`, a smart wallet's `send_calls`). Send only when the line says **SUCCEEDS**, and prepare again right before each send: a quote is good for one block.

## Why you cannot lose more than gas

The transaction is one atomic Universal Router call: wrap your ETH, swap around the loop, unwrap. Its last step pays you only if at least `input + gas + your minimum profit` comes back; otherwise the whole transaction reverts and nothing moves except the gas you paid. A bot that front-runs you, a price that moved, a pool someone emptied: each one ends in a revert, never in a loss of your ETH. Base's sequencer does not expose a public mempool, so classic sandwiches are rare there, and the floor covers the rest. The NET pools' liquidity is burned, so it cannot be pulled out from under the loop.

## What it is honestly worth

- The NET pools hold tens of dollars. Profits here are cents.
- Zora's coin hook makes the loop cost about 1.4M to 1.5M gas, roughly two US cents at 0.006 gwei (measured 2026-11-08). A loop pays only when the gap beats the fees (about 3.3% around the circle) plus that gas.
- On 2026-11-08 neither direction paid: reverse returned 0.55% more ETH than it took before gas, and gas ate it. Run it after NET or ZORA moves.
- NET's dollar price is set by EcoWealth's own buying until an outside trade confirms it. What any holder can take out of a pool is its reserve, never the quoted price.
- Nothing here is advice or a promise of return. It is a public loop and a program that reads it.

## Why EcoWealth publishes this

Each loop you close leaves ETH in the NET/WETH pool (the reserve behind NET), and its coin-pool leg pays the creator share of Zora's fee to EcoWealth. You keep the spread. Both sides gain only from a gap something else opened.

## Addresses (Base, chain 8453)

NET `0xE37A9125B6b14D5e8Ec056C744a99F4deC975022` · ECO `0x170dC0ca26F1247CED627D8aBcaFA90ecf1e1519` · ZORA `0x1111111111166b7FE7bd91427724B487980aFc69` · WETH `0x4200000000000000000000000000000000000006` · Universal Router `0x6fF5693b99212Da76ad316178A184AB56D299b43` · V4 Quoter `0x0d5e0f971ed27fbff6c2837bf31316121532048d` · V3 Quoter `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`. The coin pool's key (fee, tick spacing, hook) is read live from the ECO coin's `getPoolKey()` on every run.
