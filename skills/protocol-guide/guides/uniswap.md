# Uniswap v4 on Base: a guide for an agent with its own wallet

Never an offer or advice, no return promised. This guide says how the Uniswap v4 pools this kit names work and how to use them. It does not say you should. The thesis and its limits: https://vealth.net/tokens.html

Read on 2026-11-16 from the chain (the v4 StateView, quoter and PoolManager) and from the pool records of the sibling kit `skills/net-circle`. Run `node protocol-guide.mjs verify uniswap` to re-check every address below and every pool id against the live chain.

## What v4 is for

Uniswap v4 keeps every pool inside one contract, the PoolManager. A pool is named by its pool key: the two currencies, the fee, the tick spacing and a hook address. Native ETH is a currency (the zero address), so a v4 pool can hold ETH directly with no wrapping. A pool with the zero address as its hook has no extra rules. A hook runs its own code on every swap, and it is part of the pool's identity: a pool made without a hook never gets one. Every pool this kit names has no hook.

## Which chain

Base, chain id 8453. Nothing here uses Ethereum mainnet.

## Before you start

- A wallet you control with ETH on Base. This program never sees your key.
- Node 20 or newer, and `npm ci` in this folder for viem.

## Contracts (Base, chain 8453)

| Name | Address | Used for |
|---|---|---|
| PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` | holds every v4 pool |
| PositionManager | `0x7C5f5A4bBd8fD63184577525326123B519429bDc` | liquidity positions. Not used by this program |
| Universal Router | `0x6fF5693b99212Da76ad316178A184AB56D299b43` | where the swap transaction goes |
| V4 quoter | `0x0d5e0f971ed27fbff6c2837bf31316121532048d` | read only |
| V4 state view | `0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71` | read only |
| WETH | `0x4200000000000000000000000000000000000006` | wrapped ETH |
| ECO | `0x170dC0ca26F1247CED627D8aBcaFA90ecf1e1519` | EcoWealth's own token, which it holds and gains from if it rises |
| HYDROC | `0xBc594f11770798d7bEF748f5A00ABc44F86F5cEf` | a token launched on Hydrex's launcher by EcoWealth, which holds some and gains if it rises |

The Universal Router at this address takes a four field v4 swap encoding that is specific to this deployment. Do not point this program at another router. Every address had code on 2026-11-16 (`verify uniswap`). The NET token is described in its own section below (the buying in NET's pools is the house's own).

## The pools this kit names

`node protocol-guide.mjs uniswap pools` reads each one live and prints its pool id, its fee and whether it holds liquidity. All have no hook. The pool keys are in the program and each pool id is checked in `verify uniswap` against the pool records. Pools: ETH and axlREGEN (1 percent fee), ETH and ECO (1 percent), ECO and axlREGEN (1 percent), ECO and USDC (1 percent), and four pools of the NET token with ETH, WETH, ECO and HYDROC (0.01 percent; the buying in NET's pools is the house's own). NET has five pools on Base in all: the fifth is NET with VVV, which this kit does not read, and the sibling kit `skills/net-circle` quotes the four with ETH, WETH, ECO and VVV, not HYDROC (the buying in NET's pools is the house's own). A pair that is not in this list may still have a pool. This kit only reads the keys it knows.

"Open" means a pool holds liquidity. It does not mean a trade of your size fits. These pools can be shallow, and a size that looks small can move the price a lot. Always read a quote at your size first.

## The acts

### 1. Read (free)

```
node protocol-guide.mjs uniswap pools
node protocol-guide.mjs uniswap quote --pool eth-eco --size 0.001
```

`quote` asks the v4 quoter what an ETH in swap through `eth-axlregen` or `eth-eco` returns, and how far that is from the pool's own spot price after its fee, in basis points. It is a quote, not a promise.

### 2. Swap ETH in

```
node protocol-guide.mjs uniswap prepare swap --from 0xYOU --pool eth-eco --size 0.001
```

ECO is EcoWealth's own token. It holds ECO and gains if it rises, and the program prints that line with the quote and with the prepared swap.

It prepares one Universal Router transaction that sends exactly your `--size` in ETH, swaps it through that one pool, and takes the output straight to you. The floor is inside the swap: the minimum is the quote less `--slippage-bps` (100 by default, at most 500), and the whole transaction reverts if less arrives. The size is capped at 0.05 ETH. The program refuses a size that would move the pool price by more than `--max-impact-bps` (300 by default, at most 1000), and it refuses a pool that holds no liquidity. The deadline is 60 seconds past the latest block (`--deadline-seconds`, at most 600), so send it soon. It simulates the transaction as your address and prints it only if that passes. This is the same step as `regen prepare buy-regen` when the pool is `eth-axlregen`.

We tested the guard on a fork of live Base. A minimum above the quote reverts with `V4TooLittleReceived`. A minimum below the quote passes. When the real transaction ran on the fork, the sender received exactly the quote and the router kept nothing.

What this guard does and does not do: if the swap reverts you lose only gas. If it lands, you hold the token, and what it is worth afterwards is the market's call, not the guard's.

Only ETH in, through those two pools, is prepared. Selling a token back for ETH, a swap across several pools, and any pool with a hook are not.

### 3. NET (the buying in NET's pools is the house's own)

NET is a token whose pools this kit reads (the buying in NET's pools is the house's own, not outside demand). To trade there use the sibling kit `skills/net-circle`, which prepares ETH loops through those pools and reads each pool's burned founding position; this program prepares no NET swap (the buying in NET's pools is the house's own).

## What it costs

- Gas on Base.
- The pool's fee, inside the swap.
- The price impact, which shows in the quote and is separate from the fee.

## The risks, in plain words

- These pools are shallow. A buy can move the price, and getting out is harder than getting in.
- A token can fall. The guard stops a bad fill, a wrong amount and a stale answer. It does not stop a market from moving.
- A pool with a hook runs someone else's code on every swap. This program prepares no swap through one.
- A quote and a simulation are not promises. The pool can move between your read and your send.

## Left for later (guide text only, the program exits with code 2)

- Adding or removing liquidity: it goes through the PositionManager with its own action encoding.
- Selling a token back for ETH, multi-pool routes, and v2 or v3 pools.
- Pools behind hooks.

## Verify each act on a public explorer

- A swap: `https://basescan.org/tx/<hash>`. Look for the token transfer to you.
- A pool: `node protocol-guide.mjs uniswap pools`, and the pool id in the v4 PoolManager's logs.

## What EcoWealth holds, disclosed

EcoWealth holds ECO and gains if it rises. EcoWealth's wallet also buys in NET's pools (the buying in NET's pools is the house's own). This program prepares your own swap from your own wallet. It never touches ours, and nothing here asks you to send anything to us.

## What this program does and does not do

It reads the named pools, quotes an ETH in swap, and prepares that swap as one unsigned Base transaction after simulating it as your address. It holds no key, signs nothing and sends nothing. For NET (the buying in NET's pools is the house's own) use `skills/net-circle`. An unknown request exits with code 2.
