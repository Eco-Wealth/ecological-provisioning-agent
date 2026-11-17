---
name: protocol-guide
description: Plain guides and one program for using Hydrex, Klima and Uniswap v4 (Base), Regen (Regen Ledger, plus axlREGEN on Base) and GMX (Arbitrum) with your own wallet. `map` reads, live, the five protocols, their tokens and the roads between them. Each act reads the live state it needs, simulates as your address, and prints ONE unsigned step or the exact Regen message for you to sign. Holds no key, signs nothing, sends nothing. Refuses anything it does not know.
---

# Protocol guide: Hydrex, Regen, GMX, Klima, Uniswap

Never an offer or advice, no return promised. These are guides to how five protocols work and a program that prepares steps. They do not say you should do anything. The thesis and its limits: https://vealth.net/tokens.html

EcoWealth holds some of the tokens named here and gains if they rise: ECO (its own token), kVCM and HYDROC. For NET, the buying in NET's pools is the house's own. The full list is at the end of this page, and each guide and each program output repeats the line where it first points at the token.

You bring a wallet. The program never sees a key. It reads the chain or an API, then prints the unsigned transaction (Base or Arbitrum) or the exact message (Regen Ledger) for you to sign yourself. Before it prints a transaction it simulates it as your address, and it prints nothing that fails.

## The map: start here

```bash
node protocol-guide.mjs map          # the five protocols, their tokens, the roads between them, read live
```

One read answers "where can a holding go next, and which command prepares that step". It lists each protocol with its token and chain (Hydrex: HYDX and HYDROC on Base; Regen: REGEN on Regen Ledger and axlREGEN on Base; GMX: USDC collateral on Arbitrum; Klima: kVCM on Base; Uniswap v4: ETH, ECO and NET on Base), then every pool the kit knows, read live, as open, thin, none or unread. A missing pool is "no road", and a road that crosses chains (Base to Arbitrum, Base to Regen Ledger) is named as a bridge that is not in this kit. A pool this kit does not hold the key for is not read, so a pair missing from the map is not proof that no pool exists. NET has five hookless pools on Base, paired with ETH, WETH, ECO, VVV and HYDROC; this kit reads the four with no VVV, and the sibling kit `skills/net-circle` quotes the four with no HYDROC. NET: the buying in NET's pools is the house's own. Each row that names ECO, kVCM or HYDROC says that EcoWealth holds it. The map prints no price. Add `--json` for a machine reading.

## Which guide, which act

| You want to | Guide | Program |
|---|---|---|
| Understand Hydrex, read its pools, epoch, proposals | `guides/hydrex.md` | `hydrex epoch`, `pools`, `proposals` |
| See your veHYDX locks, votes and what you could claim | `guides/hydrex.md` section 4 and 5 | `hydrex locks`, `hydrex claimable` |
| Claim Hydrex fees and bribes | `guides/hydrex.md` section 5 | `hydrex prepare claim` |
| Vote your veHYDX | `guides/hydrex.md` section 4 | `hydrex prepare vote` |
| Swap, add or remove liquidity, lock HYDX on Hydrex | `guides/hydrex.md` sections 2, 3, 4 | guide text only |
| Understand Regen, read credit sell orders and balances | `guides/regen.md` | `regen credits`, `regen balances`, `regen pools` |
| Buy REGEN as axlREGEN on Base | `guides/regen.md` section 2 | `regen prepare buy-regen` |
| Retire credits you hold | `guides/regen.md` section 5 | `regen prepare retire` |
| Bridge REGEN, buy credits on the marketplace | `guides/regen.md` sections 3 and 4 | guide text only |
| Understand GMX, read markets, prices, positions, orders | `guides/gmx.md` | `gmx markets`, `prices`, `positions`, `orders` |
| Open or close a GMX position | `guides/gmx.md` sections 2 and 3 | `gmx prepare open`, `gmx prepare close` |
| Provide liquidity or claim on GMX | `guides/gmx.md` sections 4 and 5 | guide text only |
| Understand Klima, read its carbon classes, credits and a quote | `guides/klima.md` | `klima classes`, `klima credits`, `klima quote`, `klima balances` |
| Retire carbon with kVCM you hold (EcoWealth holds some kVCM) | `guides/klima.md` section on the acts | `klima prepare retire`, then `klima prepare revoke` for the leftover approval |
| Know who controls Klima's contracts before you approve anything | `guides/klima.md` | `verify klima` |
| Stake or lock on Klima, swap credits in for kVCM, delegate to the Hydrex conduit | `guides/klima.md` (left for later) | guide text only |
| Read the Uniswap v4 pools this kit names, quote a swap | `guides/uniswap.md` | `uniswap pools`, `uniswap quote` |
| Swap ETH for axlREGEN or for ECO (EcoWealth created and holds ECO) | `guides/uniswap.md` section 2 | `uniswap prepare swap` |
| Add or remove v4 liquidity, sell a token back, route across pools | `guides/uniswap.md` (left for later) | guide text only |
| Trade in NET's pools (the buying in NET's pools is the house's own) | the sibling kit `skills/net-circle` | `net-circle.mjs`, not this program |
| Ask where a holding can go next across all five | all five guides | `map` |
| Check every address the guides name against the live chain | all five | `verify` |

Run `node protocol-guide.mjs list` for every act, what it needs, and what it can cost you.

## Install and run

Node 20 or newer.

```bash
npm ci                                   # installs viem from the lockfile; this package has no install scripts
npm test                                 # offline tests, no network, no key
node protocol-guide.mjs list             # every act, what it needs, what it can cost you
node protocol-guide.mjs map              # the five protocols, their tokens and the roads between them, read live
node protocol-guide.mjs verify           # live check of every address the guides name, all five protocols
node protocol-guide.mjs --help
```

Pick the node with `--rpc <url>`, or `BASE_RPC_URL` and `ARBITRUM_RPC_URL`. Defaults: `https://mainnet.base.org` and `https://arb1.arbitrum.io/rpc`. For Regen Ledger use `--lcd <url>` or `REGEN_LCD_URL` (https only; default `https://rest.cosmos.directory/regen`). Use nodes you trust: a node can lie about prices and simulations.

Add `--json` for machine output. A prepare act prints `{ "sendable": true|false, "prepared": {...} }`.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | ok; for a prepare act, a sendable step was printed |
| `2` | bad arguments, or an act this program does not know |
| `3` | the RPC or the LCD is on the wrong chain |
| `4` | `verify`: a check failed |
| `10` | the act ran and found nothing to act on now: a prepare act with no sendable step, or a `klima quote` or `uniswap quote` with no quote |
| `1` | a read failed; nothing was decided |

## What each prepared act can cost you

Be exact about this. The guard is different for each act.

| Act | What you can lose |
|---|---|
| `hydrex prepare claim` | Gas only. The transaction calls the Hydrex Voter and sends nothing out of your wallet. |
| `hydrex prepare vote` | Gas only. A new vote replaces your previous one. |
| `regen prepare buy-regen` | Gas if it reverts. If it lands, exactly the ETH you named is swapped for axlREGEN, and the transaction reverts unless at least the printed minimum arrives. What that axlREGEN is worth afterwards is the market's call. Size is capped at 0.05 ETH and a price impact above 300 basis points is refused by default; `--max-impact-bps` can raise that to at most 1000. |
| `regen prepare retire` | The credits you name are retired for good. That is the act. Gas is paid in REGEN. |
| `gmx prepare open` | Up to the collateral you name (at most 5 USDC), plus fees, plus the execution fee you send (the unused part is refunded), plus gas. A liquidation can take all of the collateral. |
| `gmx prepare close` | The execution fee you send (the unused part is refunded) plus gas. What comes back to you is also reduced by GMX's position fee, any price impact on the close, and the borrowing and funding fees that built up while the position was open (`guides/gmx.md`, "What it costs"). It ends your exposure in that position. |
| `klima prepare retire` | The kVCM it spends, up to the printed maximum (at most 100 kVCM), is gone and the carbon is retired for good. That is the act. Gas if it reverts. The first run prints an exact-amount kVCM approval to Klima's asset manager, and the unspent part of it stays there until you revoke it. Tonnes from 0.001 to 0.1. |
| `klima prepare revoke` | Gas only. It sets your kVCM approval to Klima's asset manager back to zero. |
| `uniswap prepare swap` | Gas if it reverts. If it lands, exactly the ETH you named is swapped for axlREGEN or ECO and the transaction reverts unless at least the printed minimum arrives. What the token is worth afterwards is the market's call. Size is capped at 0.05 ETH and a price impact above 300 basis points is refused by default; `--max-impact-bps` can raise that to at most 1000. |

A guard cannot stop a market from moving. It stops a bad fill, a wrong amount and a stale answer.

## Sign and send

Send `tx` exactly as given, with its fee fields, before any stated deadline.

viem, with an account you control:

```js
import { createWalletClient, http, hexToBigInt } from "viem";
import { base, arbitrum } from "viem/chains";
const { sendable, prepared } = JSON.parse(output);   // output of a prepare act with --json
const tx = prepared.tx ?? prepared.steps?.[0]?.tx;   // a claim prints one step per reward contract
if (sendable) {
  const wallet = createWalletClient({ account, chain: tx.chainId === 8453 ? base : arbitrum, transport: http() });
  await wallet.sendTransaction({ to: tx.to, data: tx.data, value: hexToBigInt(tx.value), gas: hexToBigInt(tx.gas),
    maxFeePerGas: hexToBigInt(tx.maxFeePerGas), maxPriorityFeePerGas: hexToBigInt(tx.maxPriorityFeePerGas) });
}
```

**Any wallet over JSON-RPC:** call `eth_sendTransaction` with `[{ from, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas }]`, the fields as printed.

**A smart wallet (EIP-5792):** call `wallet_sendCalls` with `{ version: "2.0.0", chainId, from, atomicRequired: true, calls: [{ to, data, value }] }`. Run the prepare act with `--from` set to the smart wallet's own address.

**A GMX open takes two runs.** The first prints an exact-amount USDC approval and stops. Send it, wait for it to land, run the same command again, and it prints the order.

**A Klima retire takes two runs, and then one more if you want the leftover approval gone.** The first run prints an exact-amount kVCM approval to Klima's asset manager and stops. Send it, wait for it to land, run the same command again, and it prints the retirement. Klima spends the quote, not the maximum, so run `klima prepare revoke` afterwards to set the approval back to zero.

**A Regen retire** prints a message, not a transaction. Sign it with your own Regen Ledger tooling (for example cosmjs with Regen's message types).

## Acts it will not prepare

It exits with code 2 and says why. These are described in the guides, so you can build and simulate them with your own tools: a Hydrex swap, liquidity or lock, or delegation to a conduit; a Regen bridge or marketplace buy; a GMX deposit, withdrawal or claim; Klima staking, locks, or swapping credits in for kVCM; Uniswap v4 liquidity. A request it does not know also exits with code 2.

For the Regen bridge, which this kit does not prepare, our MCP server at https://vealth.net/mcp has `prepare_bridge` and `bridge_status`. GMX publishes its own agent kit at github.com/gmx-io/gmx-ai (MIT).

## What EcoWealth holds, disclosed

- Hydrex: a veHYDX position.
- Regen: REGEN on Regen Ledger, and it anchors its own work records there.
- GMX: this program sets no UI fee and no referral code, so nothing is taken from you.
- Klima: some kVCM, and a share of a Hydrex vault that holds kVCM against USDC.
- Hydrex also: HYDROC, a token launched on Hydrex's launcher by EcoWealth, which holds some.
- Uniswap: ECO is EcoWealth's own token and it holds it. Its wallet also buys in NET's pools: the buying in NET's pools is the house's own.

EcoWealth gains if these tokens rise. Nothing here takes your funds, holds your key or asks you to send anything to us.

## Where the facts come from

Every address and call shape in the guides was read on 2026-11-16 from the chain, from each protocol's own docs and published interfaces, or from its public API. `verify` re-reads the addresses and the live shapes. Prices, depth, fees and yields change, so the guides give none: read them live.

Licensed Apache-2.0, as is the rest of this repository (see its root `LICENSE`).
