# Bots: recipes for an agent that runs these acts on a timer

Never an offer or advice, no return promised. This page gives instructions and reads. It does not say you should run any of them. The thesis and its limits: https://vealth.net/tokens.html

Written on 2026-11-17 from the acts and guides in this folder. Every command below is checked against the real program by this folder's tests: they parse each one, with no network and no key (the three `net-circle` commands are checked when the sibling kit is installed beside this one). `node protocol-guide.mjs recipes` prints the same recipes, so a bot can read them from the program itself.

## What a recipe is

A recipe is a short, complete list of commands, in order, with what to do on each exit code, who signs, the caps, what it can cost you and when to stop. It is not a scheduler and not a signer. This program adds no signing, no key handling and no timer: you bring all three. You run each command from your own agent on your own timer, and you send every printed transaction (or sign every printed message) with your own signer. No recipe trades for EcoWealth, and EcoWealth takes no fee from any of them.

## Loops and sinks

The aim of these recipes is capital loops: capital that goes out through a protocol and comes back. For example, ETH to axlREGEN on one pool and back through another, USDC collateral into a GMX position and back, a trip through NET's pools and back to ETH (the buying in NET's pools is the house's own), or a Hydrex lock's vote and then its claimed fees and bribes. Each recipe says which kind it is.

A loop is a path with its costs, never a profit. Every leg has fees and gas, a pool can move before the second leg, and a loop can return less than it took. No recipe promises a return. A sink is a path that ends the capital by design: a retirement on Klima or on Regen is gone for good and does not come back. `node protocol-guide.mjs map` lists the loops and sinks this kit knows, with the live state of each pool leg. This kit builds no loop pricing tool: it prices nothing.

In the commands, `0xYOU` is your own address, `regen1YOU` is your own Regen Ledger address, `0xCLASS` and `0xCREDIT` are a Klima class and credit you read in an earlier step, and `0xPOOL` is a Hydrex pool you chose. The amounts are examples and are not advice.

## Rules for every recipe

- **Exit codes.** `0` ok, and for a prepare act a sendable step was printed. `10` the act ran and found nothing to act on now. `2` bad arguments, or an act this program does not know: stop and fix the command, never run it again unchanged. `3` your node is on the wrong chain: stop and fix the setting. `1` a read failed and nothing was decided: wait, run the same command again, and stop after three failures in a row. `4` is `verify` only: a check failed, so do not act.
- **Branch on the step, not only the exit code.** A GMX open and a Klima retire each take two runs. With `--json`, exit `0` and `prepared.step` of `approve` means send that approval, wait for it to land, and run the same command again. `prepared.step` of `order` or `retire` means send that one.
- **One thing at a time.** Never start a second run of an act while the first one's transaction is still unconfirmed.
- **Read the chain after you send.** Check the receipt, the order list or the balances before you decide the next step.
- **Keep a budget of your own.** The caps in this program are starter caps so that a mistake costs little. Your agent should also hold a budget and stop when it is spent.
- **Sending what a step prints.** See "Sign and send" in `SKILL.md`. The program holds no key.

## 1. A GMX trader starter

One small Classic position: read first, open, wait for the keeper, hold, close by your own rule. These acts spend USDC in your own Arbitrum wallet, not a GMX Account balance. If your funds are on Base, `guides/gmx.md` ("Trading GMX from Base") gives the two roads. Moving the funds is not part of this recipe.

Shape: a loop. USDC in your own Arbitrum wallet goes into a GMX Classic position and comes back to USDC when you close, less fees. It is a path with its costs, not a return: it can come back as less, and a liquidation can take all of it.

Who signs: your own signer on Arbitrum, with ETH (gas and the execution fee) and native USDC in the wallet.

```
node protocol-guide.mjs verify gmx
node protocol-guide.mjs gmx markets
node protocol-guide.mjs gmx prices --market ETH
node protocol-guide.mjs gmx positions --address 0xYOU --json
node protocol-guide.mjs gmx prepare open --from 0xYOU --market ETH --side long --collateral 5 --leverage 2 --json
node protocol-guide.mjs gmx orders --address 0xYOU
node protocol-guide.mjs gmx positions --address 0xYOU
node protocol-guide.mjs gmx prepare close --from 0xYOU --market ETH --side long --json
```

- `verify gmx` exit `4`: a check failed, so GMX may have moved an address. Stop and do not trade.
- `gmx markets` and `gmx prices`: choose a market by your own rule. This recipe names none and gives no view of where a price goes.
- `gmx positions`: if the list already holds a position on that market and side, skip to the close step. Never open a second one.
- `gmx prepare open`: exit `0` with `prepared.step` of `approve`, send the exact-amount approval, wait, run it again. With `order`, send the order. Exit `10`: read `prepared.reason` (a balance too low, a price out of reach), do nothing this cycle and look again next cycle.
- `gmx orders`: an order stays in this list until a keeper fills it a moment later. Wait until the list is empty. If it is still there after several minutes, stop and look at it on Arbiscan.
- `gmx prepare close`: exit `0`, send it. It closes the whole position, and what comes back lands when a keeper fills it. Exit `10`: no open position on that market and side, or not sendable.

Caps: collateral at most 5 USDC and leverage 1 to 10, enforced by the program. Slippage 100 basis points by default, at most 500. One position per market and side. The program has no loss budget, so set your own.

What it can cost you: up to the collateral you name (a liquidation can take all of it), GMX's position fee when you open and close, borrowing and funding fees while the position is open, the execution fee you send (the unused part is refunded), and gas on Arbitrum.

Stop when any step exits `2` or `4`, when your own loss budget is spent, or when an order has not filled after several minutes. To get out, run the close step first.

## 2. A circle runner (the sibling kit net-circle)

The sibling kit `skills/net-circle` quotes every loop through NET's pools in both directions, and prepares one trade that reverts unless its floor holds (the buying in NET's pools is the house's own). Run `npm ci` once in `skills/net-circle`. From this folder the commands are:

Shape: a loop. ETH goes through NET's pools and comes back to ETH in one transaction, which reverts unless at least the input plus gas comes back (the buying in NET's pools is the house's own). It is a path with its costs, not a return: the pools are tiny and other bots race you.

Who signs: your own signer on Base.

```
node ../net-circle/net-circle.mjs pools
node ../net-circle/net-circle.mjs
node ../net-circle/net-circle.mjs prepare --from 0xYOU --size 0.0001 --json
```

- `pools`: every pool's liquidity and its burned founding positions (the buying in NET's pools is the house's own).
- With no word: every loop, in both directions (`buy-net` and `sell-net`). A loop says `PAYS x at y in` only when a size pays after gas. Otherwise it says `no size pays after gas`.
- `prepare`: exit `0` means `sendable` is true. Send `prepared.tx` exactly as printed, with its fee fields, before `prepared.deadline`. Exit `10` means nothing is worth sending now: wait for the next cycle.

Caps: size at most 1 ETH, enforced by net-circle. The example uses 0.0001 ETH. `--min-profit-wei` raises the floor above input plus gas, so raise it if your wallet's bundler charges a fee. Do not run it faster than once every 10 seconds.

What it can cost you: gas on every try, including a revert. A lost race or a price that moved reverts the whole transaction and costs its gas. The pools are tiny, so what comes back is cents at most, and other bots watch the same pools. The `zora` loops send part of the Zora coin pool's fee back to EcoWealth as ECO's creator. EcoWealth created ECO, holds it and gains if it rises. For NET: the buying in NET's pools is the house's own.

Stop after three reverts in a row, when the gas you have spent passes your own budget, or on exit `2` or `3`. Nothing promises that any size pays.

## 3. A Regen retire step

Retire credits you already hold. This kit does not buy credits. Buying axlREGEN on Base (`regen prepare buy-regen`) gives you a token on Base, not credits. Turning it into credits takes a bridge (`prepare_bridge` at https://vealth.net/mcp) and a marketplace buy on Regen Ledger, both outside this kit.

Shape: a sink, not a loop. A retirement ends the capital by design: the credits you retire do not come back.

Who signs: your own wallet on Regen Ledger. The program prints the exact message. You sign it with your own Regen tooling and pay gas in REGEN.

```
node protocol-guide.mjs regen balances --regen regen1YOU --json
node protocol-guide.mjs regen prepare retire --owner regen1YOU --batch C01-001-20150101-20151231-001 --amount 1 --jurisdiction US-CA --reason "retired by my agent" --json
node protocol-guide.mjs regen balances --regen regen1YOU --json
```

- First read: find a batch whose tradable amount is above zero.
- `regen prepare retire`: exit `0`, sign `prepared.message` and broadcast it. Exit `10`: not sendable, usually because the tradable balance is below the amount. Do nothing.
- Last read: the batch's retired amount went up by what you retired. That is your proof. If it did not, wait and read again before you retry. Never retire twice for one purpose.

Caps: the program checks every field's format and your tradable balance. The amount is yours to set, so put a per-run amount in your agent. The reason is cleaned and cut to 200 characters.

What it can cost you: the credits you name are retired for good, by design. Gas in REGEN. The reason and your address are public and permanent.

Run one retirement per cycle, and only after the last read confirms the previous one. Stop when the batch's tradable amount reaches zero, or on exit `2`.

## 4. A Klima retire step

Quote, approve the exact amount, retire, then take the leftover approval back. EcoWealth holds some kVCM and gains if it rises.

Shape: a sink, not a loop. A retirement ends the capital by design: the kVCM it spends does not come back. The loop of USDC to kVCM on one venue and back on another is on the map (two pools hold kVCM against USDC, one on Hydrex and one on Aerodrome), and this kit prepares no swap on either venue.

Who signs: your own signer on Base, with kVCM and ETH in your wallet.

```
node protocol-guide.mjs klima classes
node protocol-guide.mjs klima credits --class 0xCLASS
node protocol-guide.mjs klima quote --class 0xCLASS --credit 0xCREDIT --tonnes 0.01 --json
node protocol-guide.mjs klima balances --address 0xYOU
node protocol-guide.mjs klima prepare retire --from 0xYOU --class 0xCLASS --credit 0xCREDIT --tonnes 0.01 --beneficiary-name "my agent" --json
node protocol-guide.mjs klima prepare revoke --from 0xYOU --json
```

- `klima classes`: choose a class by your own rule. Klima changes the list, and some classes do not retire through this kit (`guides/klima.md`).
- `klima quote`: Klima's own quote in kVCM for this moment. It moves. Exit `10` means no quote for that class or credit: choose another, or stop.
- `klima balances`: you must hold at least the printed maximum, which is the quote plus slippage.
- `klima prepare retire`: exit `0` with `prepared.step` of `approve`, send the exact-amount kVCM approval, wait for it to land, then run the same command again. With `retire`, send the retirement. Exit `10`: read `prepared.reason`.
- `klima prepare revoke`: exit `0`, send it. It sets your approval to Klima's asset manager back to zero. Exit `10` means there is nothing to revoke.

Caps: 0.001 to 0.1 tonnes per retirement and at most 100 kVCM spent per retirement, enforced by the program. In your agent, retire at most once per cycle, only after the last one's receipt is confirmed, and set a total kVCM budget.

What it can cost you: the kVCM the retirement spends (Klima's quote at the moment it lands) is gone, and the carbon is retired for good. Gas on Base. The unspent part of the approval stays on Klima's asset manager, which Klima's admin Safe can upgrade, until you revoke it. Your beneficiary name is public and permanent.

Stop when your kVCM budget is spent, when a quote is far above the last one, or on exit `2`. Always run the revoke step after a retirement.

## 5. A Hydrex lock keeper for your own lock

Claim, then vote, once per epoch. This recipe needs a veHYDX lock you already hold. This kit creates no lock (guide text only) and delegates nothing. EcoWealth holds a veHYDX position.

Shape: a loop of the lock's reward. Your lock votes, and the fees and bribes of the pools you voted in come back to you to claim. The locked HYDX stays locked, so what loops is the lock's reward, and it can be zero. It is a path with its costs, not a return.

Who signs: your own signer on Base.

```
node protocol-guide.mjs hydrex epoch --json
node protocol-guide.mjs hydrex locks --address 0xYOU --json
node protocol-guide.mjs hydrex claimable --address 0xYOU
node protocol-guide.mjs hydrex prepare claim --from 0xYOU --json
node protocol-guide.mjs hydrex pools --limit 15
node protocol-guide.mjs hydrex prepare vote --from 0xYOU --vote 0xPOOL:10000 --json
```

- `hydrex epoch`: `secondsToFlip` says when the epoch flips (Thursday 00:00 UTC). Run the rest once per epoch, after the flip.
- `hydrex locks`: no lock in the list means stop. Otherwise read your votes. They do not carry over to the new epoch.
- `hydrex claimable`: what you could claim in the pools you vote in now.
- `hydrex prepare claim`: exit `0` prints one step per reward contract, and you send each exactly as printed. Exit `10`: nothing earned yet, or a claim that reverts. Read `prepared.reason` and the problem lines.
- `hydrex pools`: the pools and their gauges. The kit names none to vote for and gives no view. Pick by your own rule, and judge a pool by last epoch's weight, never the live figure (`guides/hydrex.md`).
- `hydrex prepare vote`: exit `0`, send it. A new vote replaces your previous one, and the basis points must sum to exactly 10000. Exit `10`: no lock, no live gauge for a pool, or the vote reverts. Read `prepared.reason`.

Caps: at most 10 pools in one vote. A claim covers only the pools you vote in now, so pass an older pool to your own tool.

What it can cost you: gas only. A careless vote can drop votes you meant to keep.

Run it once per epoch. Stop when no lock is found, or on exit `2`.

## 6. A where-next loop

Read the map's capital loops and sinks, then pick your next recipe. Shape: reads only. This recipe moves nothing. It moves nothing, and each next step is another recipe or act, with your own signer.

```
node protocol-guide.mjs map --json
node protocol-guide.mjs list
node protocol-guide.mjs verify
```

- `map`: `holdings` lists, for each token, the roads that are open or thin and the command that prepares the step, if this kit has one. `prepared` is null when it does not, and then the step is guide text or your own tool. The map also lists which tool at https://vealth.net/mcp answers which need among the NET programs (the buying in NET's pools is the house's own).
- `list`: what each prepared act needs and can cost you. Read it before you pick one.
- `verify`: exit `0` means all five protocols check out. Exit `4`: a check failed, so do not act on a road through that protocol.

Caps and cost: none. These are free reads.

Run it once per cycle. Never act on the map alone. Open means a pool holds liquidity, not that your size fits, and the map prints no price, so quote with the act's own read first. For NET roads: the buying in NET's pools is the house's own.

## Where the agent programs at vealth.net/mcp fit

The programs at https://vealth.net/mcp are another kind of bot door: `net_programs` finds the program that fits a need, and each program has its own prepare and submit pair that you sign with your own wallet. They are built, and as read on 2026-11-17 none is switched on, so read `net_programs` before you build a bot on one (the buying in NET's pools is the house's own). `SKILL.md` has the table of which tool answers which need.
