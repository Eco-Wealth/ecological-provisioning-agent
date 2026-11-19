# The protocol bot

One program that runs one loop over Hydrex, Klima, Regen, ECO (the coin EcoWealth made on Zora), NET's circle and GMX, on your own machine, with your own key.

Never an offer or advice, no return promised. A loop is a path with its costs, never a profit: every leg has fees and gas and can return less than it took. EcoWealth takes no fee from this program, and it never trades for EcoWealth. EcoWealth created ECO and, as of 2026-11-18, holds ECO, REGEN, a stake in GMX, a stake in Klima (at times some kVCM) and a veHYDX lock; it may gain if these holdings rise. EcoWealth both buys ECO and swaps ECO it holds for NET. The buying in NET's pools is the house's own.

## Start

Node 22 or newer is required. Install this package and both neighboring kits (`skills/protocol-guide` and `skills/net-circle`) with `npm ci --ignore-scripts` in each folder before running a pass.

```
npm ci --ignore-scripts
node bot.mjs once --address 0xYOU
```

That is a dry pass for any address. It needs no key, signs nothing and sends nothing. It prints what every leg would do right now.

To let it send:

```
node bot.mjs wallet
node bot.mjs run --live --regen-eth 0.0002 --eco-eth 0.0002 --circle-eth 0.0001
```

`wallet` makes the bot's own wallet and prints its address. Fund that address with only what you can lose. If the lock or the tokens sit in a wallet you already hold, pass `--key-file` with a file that holds that key and that only you can read.

The two kits it drives sit beside it in this repository: `skills/protocol-guide` and `skills/net-circle`. Run `npm ci --ignore-scripts` once in each.

## The loop

Every wake (once an hour unless you set `--every`), the bot walks these legs in this order. A leg with nothing to do says so in one line and the loop goes on.

| Leg | What it does | Turned on by | The most it can cost you |
|---|---|---|---|
| `hydrex` | Claims your veHYDX lock's fees and bribes, then votes by the kit's plain ranking: last epoch's pay per vote, split equally. This is not a copy of any wallet's vote. Once per epoch. | a veHYDX lock in the wallet | gas; a vote replaces your last vote |
| `klima` | Retires carbon on Klima with kVCM you hold: approves the exact amount, retires, takes the approval back. A sink: what it retires is gone for good, by design. | `--klima-class`, `--klima-credit`, `--klima-tonnes` | the kVCM the retirement spends, at most 100 kVCM, and gas |
| `regen` | Buys axlREGEN, Regen's token on Base, with a slice of ETH. | `--regen-eth` | the slice, and gas |
| `eco` | Buys ECO with a slice of ETH. | `--eco-eth` | the slice, and gas |
| `circle` | Sends one trip through NET's pools and back to ETH, only when the kit's floor says at least the input plus gas comes back. | `--circle-eth` | gas on a trip that loses its race and reverts |
| `gmx` | Holds one small GMX position on Arbitrum by your rule: opens it, holds it for `--gmx-hold-hours`, closes it, starts again. | `--gmx-market`, `--gmx-side`, `--gmx-collateral`, `--gmx-leverage` | the collateral (a liquidation can take all of it, at most 5 USDC), GMX's fees, and gas |

How the legs join: a lock that votes a kVCM pool earns kVCM, and the `klima` leg retires kVCM. The `regen` and `eco` slices and the circle spend ETH from the same wallet, under one day cap. The GMX leg runs on Arbitrum with USDC you put there yourself.

A leg that spends has no default size. With no size flag it stays off and spends nothing. The buys and the retirement run once every `--buy-every-hours` (24 unless you set it).

The Hydrex vote comes from the kit's `hydrex rank`. A copy of the kit without it stops the `hydrex` leg with a plain line. `--hydrex-vote 0xPOOL:10000` uses your own vote.

Retiring Regen credits on Regen Ledger is not a leg yet. The kit prints that message (`regen prepare retire`) for your own Regen wallet to sign.

## What it can sign

```
node bot.mjs list
```

prints every contract call this program can sign: the contract, the function, and the most ETH that may ride along. That list is in `RULES` at the top of `bot.mjs`. A step that is not on it is refused, nothing is sent for it, and the leg stops until you start the bot again.

- No plain token transfer is on the list; GMX collateral can be sent to GMX's own order vault under the aggregate cap.
- An approval names its one spender (Klima's asset manager, or GMX's router) and has a cap.
- A GMX order is read inside: the fee and the collateral go to GMX's order vault only, every wei the step carries is that fee, and what comes back comes to your address.
- A swap may carry at most the size you set for its leg, and never more than 0.05 ETH.
- A swap is read inside too. Only the swap steps the kits build are let through. Nothing may be pulled from your wallet, so a swap spends only the ETH it carries. Every place tokens come out is you. A buy is exactly one swap that takes the token straight to you, and a trip through NET's pools must end by sweeping ETH back to you. So the most a swap leg can lose is the size you set.

## How the key is kept

- The key is read from a file on your machine. On Unix, the file must be readable by you alone or the bot refuses it; the permissions check is skipped on Windows.
- The key is never printed, logged, put on a command line or sent anywhere.
- The two kits run as separate programs and are never handed the key. Each prints one unsigned step. This program checks the step, then signs it.
- The kits still run as you, on your machine, so a kit someone has tampered with could read the key file. The split guards against a mistake, not against that. Run only the kits that ship beside this program, installed with `npm ci --ignore-scripts`.

## Caps

| Flag | Default | Ceiling |
|---|---|---|
| `--max-tx-fee-eth` | 0.0005 | 0.01 |
| `--day-fee-eth` | 0.001 | 0.05 |
| `--day-spend-eth` | 0.02 | 1 |

The day totals come from `ledger.jsonl` in its home folder (`~/.vealth-bot` by default), which holds every transaction it sent and got an answer for. A send that got no answer leaves no row there, so if it did go out the day caps do not count it. Anyone who can edit that file can reset the totals, so the real limit is what the wallet holds. The day caps count ETH only: the 100 kVCM and the 5 USDC are limits on one retirement and one position, and no day cap counts kVCM or USDC.

The fee caps count signed gas fee fields and include the kit's bound for Base data fees when provided. A data fee not reported by the kit cannot be guaranteed by these caps.

## Stop it

```
touch ~/.vealth-bot/STOP
```

The STOP file is checked at the start of each pass and before each send; no further transaction is sent while it is present. Remove the file to go on.

It sends one transaction at a time and waits for each. If one is still unconfirmed, nothing else is sent until it lands. If STOP or an unconfirmed transaction holds the bot after a Klima approval and before the retirement or the take-back, that approval (at most 100 kVCM) stays open until the Klima leg runs again and takes it back, or until you revoke it yourself. A Klima pass that finds nothing to retire does not take it back. If the connection drops just as a transaction is sent, or the node cannot be reached when the send starts, the bot cannot tell whether it went out, so it sends nothing more and says so on every pass: look at your wallet, then delete `pending` from `state.json` in its home folder to let it go on.

## On a timer

`run` loops by itself. For cron or launchd, use `once`:

```
0 * * * * cd /path/to/packages/protocol-bot && node bot.mjs once --live --regen-eth 0.0002 >> ~/.vealth-bot/bot.log 2>&1
```

## Exit codes

`0` the pass ran. `2` bad arguments. `4` a rule refused a step and nothing was sent for it. `1` a leg was stopped.

## Check it yourself

```
node --test bot.test.mjs
```

The tests run with no network and no real key. They hold every pinned contract equal to the kit's own, recompute every function selector, and walk dry and live passes against a pretend chain.
