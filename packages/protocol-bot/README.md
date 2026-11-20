# The protocol bot

One program that runs one loop over Hydrex, Klima, Regen, ECO (the coin EcoWealth made on Zora), NET's circle and GMX, on your own machine, with your own key.

Never an offer or advice, no return promised. A loop is a path with its costs, never a profit: every leg has fees and gas and can return less than it took. EcoWealth takes no fee from this program, and it never trades for EcoWealth (buying ECO through the Zora coin pool may pay ECO creator fees to EcoWealth, as that pool does for anyone). EcoWealth created ECO and NET and, as of 2026-11-18, holds ECO, NET, REGEN, a stake in GMX, a stake in Klima (at times some kVCM) and a veHYDX position; it may gain if these holdings rise. EcoWealth both buys ECO and swaps ECO it holds for NET. The buying in NET's pools is the house's own.

**Nobody has run this bot live.** The bot's own checks use a pretend chain, a local pretend node and throwaway keys (the dated pool figures below come from a dry, look-only pass of this bot against the real chain, which signed and sent nothing). `--live` signs and sends real transactions from your key: treat it as untested with real money, and start with an amount you can lose.

## Start

Node 22 or newer is required. The durable file protocol requires a POSIX local filesystem with directory `fsync` support (macOS or Linux); Windows and filesystems that refuse directory flushes fail closed.

**This works only from a full clone of the repository.** `bot.mjs` runs two kits that sit beside it at fixed paths (`../../skills/protocol-guide` and `../../skills/net-circle`), and each of the three folders needs its own `npm ci`. A packaged or global install is not supported: `package.json` names a `protocol-bot` command and ships only three files, and that is not enough to run the bot. Copying this folder alone fails the same way: a leg prints `Cannot find package 'viem'` or cannot find a kit, and `npm test` cannot load.

Copy this block whole, in this order:

```
git clone https://github.com/Eco-Wealth/ecological-provisioning-agent.git
cd ecological-provisioning-agent
npm --prefix skills/protocol-guide ci --ignore-scripts
npm --prefix skills/net-circle ci --ignore-scripts
npm --prefix packages/protocol-bot ci --ignore-scripts
cd packages/protocol-bot
npm test
```

`npm test` runs the package's own checks. They are offline: a pretend chain, a pretend node and throwaway keys. Every command below runs from `packages/protocol-bot`. On Node 20, `npm ci` warns that the package asks for Node 22; the install, the tests and the dry loop below all ran on Node 20, and none has been run on Node 22.

### Your first dry loop

A dry pass needs no key, signs nothing, sends nothing, writes nothing into the home folder and takes no lock, so it also runs beside a live bot that uses the same home. If it reads the home in the instant between a live bot's two writes of one send, it waits 300 milliseconds and reads once more; if the home is still inconsistent it exits `4` and says a live bot may be mid-send or the home is damaged, so run it again. This one turns on three legs with a size each and reads real quotes from public nodes:

```
node bot.mjs once --address 0x000000000000000000000000000000000000bEEF --home /tmp/vealth-bot-scratch \
  --legs regen,eco-buy,net-buy --regen-eth 0.0001 --eco-buy-eth 0.0001 --net-eth 0.0001 --json
```

- The address is a throwaway that holds nothing. Use your own to see what your own wallet would do.
- `--home` names the folder the bot reads its memory from. A dry pass only reads it and writes nothing, so a scratch path is safe, and the folder is not even created.
- A leg with no size flag says `off` and spends nothing. Run the same command without the three size flags and all three legs print `off`.
- With `--json`, stdout is one JSON object and every human line goes to stderr (see "Reading a pass by machine").

A good run takes a few seconds (3.9 seconds in the walk recorded on 2026-11-20), exits `0`, and prints one line per leg like these, from a real dry pass that day (the figures move with the market):

```
regen: DRY, would send buy at least 256.551405 axlREGEN with 0.0001 ETH (fee at most 0.000001684464345212 ETH)
eco-buy: DRY, would send buy at least 34774.305528068061180188 ECO by WETH>NET>ECO with 0.0001 ETH (fee at most 0.000003107894694961 ETH)
net-buy: DRY, would send buy at least 0.000000032607091603 NET by WETH>NET with 0.0001 ETH (fee at most 0.000002492391028238 ETH)
```

The JSON ends with the same three legs, each `"state": "dry"`, with its chain, token symbol, amount and a `"hash": null` because nothing was sent. `off`, `not_due` and `held` legs are normal and are not failures. If the exit code is not `0`, read "Exit codes" below.

### Two-RPC evidence for live use

Live use needs **two separate HTTPS RPC providers for every chain a selected leg signs on**: a primary (`--base-rpc`, `--arbitrum-rpc`) and a witness (`--base-witness-rpc`, `--arbitrum-witness-rpc`, or the `BASE_WITNESS_RPC_URL` and `ARBITRUM_WITNESS_RPC_URL` environment variables). `--live` refuses to load the wallet key without them. The Hydrex, Klima, `regen`, `eco`, `eco-buy`, `net-buy` and `circle` legs sign on Base, and `gmx` signs on Arbitrum. The default leg set includes `gmx`, so the default legs need both witnesses. Pass `--legs` to run fewer legs, and then only the chains those legs sign on need a witness: `--legs regen,eco` needs a Base witness and no Arbitrum one. A same-host URL, a URL that is not HTTPS, or a missing witness is refused. The bot compares hostnames only. It cannot tell whether two hostnames share one operator, so choosing separate providers is on you. Dry runs and the unsigned Regen Ledger preparation need no witness. The same rule holds for code that imports `makeChainIo` and `makeContext` and skips the command line: a signing account with no witness for a chain signs and sends nothing on that chain, and never treats a send there as final.

What the witness checks, and nothing else:

- **Chain id.** Both nodes must report the expected chain id before the bot signs, and again just before it broadcasts.
- **Wallet nonce.** Both nodes must report the same confirmed and pending nonce before the bot signs, and again just before it broadcasts.
- **Block time.** Before each send, the witness's latest block time must be within five minutes of the primary's, in either direction.
- **Finality.** A send stays pending until both nodes independently return the same receipt for the exact transaction hash (same block number, block hash and result), each node's own finalized block is at or past the receipt's block, and each node's canonical block at that height carries the receipt's block hash. The two finalized heights are not compared with each other and do not need to be equal.

If one RPC lags, disappears, reorgs, disagrees, or cannot prove finality, the bot stops subsequent sends until it can reconcile.

What the witness does not check: every kit read still comes from the primary node alone. That covers quotes and the minimum out, GMX positions and the close size, and token allowances. The rules and caps below still apply to every step the bot signs, but the numbers a kit reads, such as a quote, are taken from one node. Two hosts alone do not prove independent infrastructure; this is two-provider corroboration of the four checks above, not Byzantine consensus or a complete independent security audit. A mistaken or unavailable witness will reduce trading availability, intentionally.

To let it send:

```
node bot.mjs wallet
node bot.mjs once --live --legs regen,eco-buy --regen-eth 0.0001 --eco-buy-eth 0.0001 \
  --base-witness-rpc https://<a second Base provider>
```

`wallet` makes the bot's own wallet and prints its address. Fund that address with only what you can lose. If the lock or the tokens sit in a wallet you already hold, pass `--key-file` with a file that holds that key and that only you can read. Both legs here sign on Base, so only a Base witness is needed. `run --live` with the same flags does the loop forever instead of one pass.

Pick legs the dry pass shows as `dry` today, at the size you give. A leg the kit refuses for price impact is the kit protecting you, not a fault in the bot: it says `nothing to do now`, sends nothing, and the pass still exits `0`. On 2026-11-20 the `eco` leg (the thin ETH/ECO pool) was refused at 0.0001 ETH for that reason, with about 1,624 basis points of impact against the kit's cap of 300; the `eco-buy` leg, which picks the best route, was not.

### How long a live loop takes

Finality lags about 18 minutes behind each send. Read-only reads on 2026-11-20 measured 1,094 seconds on Base and 1,142 seconds on Arbitrum; that is a measurement from one day, not a promise. The bot sends one transaction, waits, and sends nothing else until that one is final. So `once --live` sends one transaction per pass and a pass that finds the last send still pending sends nothing and exits `0`. A loop of four buys is four passes or more, each after the one before is final: at least about 72 minutes at today's lag with `run` (which checks a pending send at least every five minutes), and about four hours if you call `once` from an hourly timer.

The two kits it drives sit beside it in this repository (`skills/protocol-guide` and `skills/net-circle`); the install block at the top installs both.

## The loop

Every wake (once an hour unless you set `--every`), the bot walks these legs in this order. A leg with nothing to do says so in one line and the loop goes on.

| Leg | What it does | Turned on by | The most it can cost you |
|---|---|---|---|
| `hydrex` | Claims your veHYDX lock's fees and bribes, then votes by the kit's plain ranking: last epoch's pay per vote, split equally. This is not a copy of any wallet's vote. Once per epoch. | a veHYDX lock in the wallet | gas; a vote replaces your last vote |
| `klima` | Retires carbon on Klima with kVCM you hold: approves what the retirement needs (never more than 100 kVCM), retires, and takes the approval back as soon as the retirement is final, whether it went through or reverted, or at once if it never went out (finality takes minutes, so that is usually a later pass; see "The `klima` leg"). A sink: what it retires is gone for good, by design. | `--klima-class`, `--klima-credit`, `--klima-tonnes` | the kVCM the retirement spends, at most 100 kVCM, and gas |
| `regen-retire` | Asks the kit for the exact Regen Ledger retirement message for credits you hold (`regen prepare retire`) and prints it: "DRY, would sign this Regen message: ...". It prepares and prints, and it never signs or sends, with or without `--live`. Signing it is a separate step you do with your own Regen wallet. A sink: what it retires is gone for good, by design, and no return is promised. The reason you give is written onchain, public and permanent. | `--regen-retire-owner`, `--regen-retire-batch`, `--regen-retire-amount`, `--regen-retire-jurisdiction`, `--regen-retire-reason` | nothing from this program. If you sign the message yourself, the credits it names are gone for good, and gas is paid in REGEN |
| `regen` | Buys axlREGEN, Regen's token on Base, with a slice of ETH. | `--regen-eth` | the slice, and gas |
| `eco` | Buys ECO with a slice of ETH through the kit's ETH/ECO pool. That pool was very thin in the 2026-11-18 look-only snapshot: the 0.0001 ETH quote showed about 16% price impact. This is a dated quote, not a future rate, so prefer checking `eco-buy` below. | `--eco-eth` | the slice, and gas |
| `eco-buy` | Buys ECO with a slice of ETH by the NET circle kit's best route (the Zora coin pool, or through NET's pools): one way, you end up holding ECO. The kit prints its own holdings line and the route it took. | `--eco-buy-eth` | the slice, and gas; the price is the market's call afterwards |
| `net-buy` | Buys NET with a slice of ETH: one way, you end up holding NET. The buying in NET's pools is the house's own. | `--net-eth` | the slice, and gas; the price is the market's call afterwards |
| `circle` | Sends one trip through NET's pools and back to ETH, only when the kit's floor says at least the input plus gas comes back. | `--circle-eth` | gas on a trip that loses its race and reverts |
| `gmx` | Holds one small GMX position on Arbitrum by your rule: opens it, holds it for `--gmx-hold-hours`, closes it, starts again. It needs USDC and also ETH on Arbitrum (see below). | `--gmx-market`, `--gmx-side`, `--gmx-collateral`, `--gmx-leverage` | the collateral (a liquidation can take all of it, at most 5 USDC), GMX's fees, the execution fee and gas |

How the legs join: a lock that votes a kVCM pool earns kVCM, and the `klima` leg retires kVCM. The `regen`, `eco`, `eco-buy` and `net-buy` slices and the circle spend ETH from the same wallet, under one day cap. The GMX leg runs on Arbitrum with USDC you put there yourself, and it needs ETH on Arbitrum as well: every GMX order carries an execution fee in ETH (at most 0.005 ETH, the part GMX does not use is refunded to you) on top of gas. The kit refuses to prepare an order when the address holds less ETH on Arbitrum than that fee ("the address holds ... ETH on Arbitrum, less than the execution fee"), and the `gmx` leg then says `nothing to do now`.

A leg that spends has no default size. With no size flag it stays off and spends nothing. The buys and the Klima retirement run once every `--buy-every-hours` (24 unless you set it); `regen-retire` has no pace of its own, see below.

The Hydrex vote comes from the kit's `hydrex rank`. A copy of the kit without it stops the `hydrex` leg with a plain line. `--hydrex-vote 0xPOOL:10000` uses your own vote.

### The `klima` leg: where the class and credit come from, and the approval on a slow chain

`--klima-class` and `--klima-credit` are addresses the kit lists. From `packages/protocol-bot`:

```
node ../../skills/protocol-guide/protocol-guide.mjs klima classes
node ../../skills/protocol-guide/protocol-guide.mjs klima credits --class 0xCLASS
```

The first prints every carbon class Klima lists, class address first, with the tonnes available. The second prints the credits that class registers, each with its address and token id (pass a token id other than 0 with `--klima-token-id`). `--klima-tonnes` is from 0.001 to 0.1, and the wallet must hold the kVCM the retirement spends.

Finality takes minutes, so the bot never sees its own approval or retirement final in the pass that sent it. **Every approval the bot sends is owed back from the moment it is sent.** The bot writes that down in `state.json` in the same save that records the send as pending, so a crash cannot lose it. It takes the approval back as soon as the retirement it was made for is final, whether that retirement went through or reverted. It also takes it back when the retirement was never sent: STOP, a cap, a rule that refused the retirement, a failed read, or klima dropped from `--legs`. An approve that is final gets one pass in which its retirement goes out next. A pass that ends without sending it leaves the approval stranded, and the next pass takes it back first; so does the first pass after you remove STOP, and a crash between the two just lets the retirement go out next. An owed take-back is settled on every pass, before "not due yet", before the leg's own stop, before any new approval or retirement, and even if you dropped the leg's flags or the leg itself from `--legs`. The take-back signs on Base, so like every Base send it needs a Base witness: on a live pass with no Base witness (only Arbitrum legs, say) the bot refuses the take-back, exits `4` naming the missing flag, and the approval stays owed until a pass that has one. While a take-back is owed the bot sends no new approval or retirement. While a retirement is still pending (not final either way) the take-back waits: it never revokes under a retirement that may still land. A take-back is an approval of exactly zero to Klima's asset manager, through the same gate as every other step, and the bot refuses anything else. A dry pass says it would send the take-back and writes nothing.

A retirement that reverted owes no less than one that worked. Three reverted approves or retirements in a row still stop the leg, but only after the approval has been taken back, so a stopped Klima leg leaves a zero allowance and there is nothing for you to revoke. A take-back that works is not the retirement's success: the retirements have their own count under `sendFailures` (`klima`), and only a retirement that goes final resets it. The take-backs have a count of their own (`klima:take-back`).

What clears an owed take-back: a take-back that went final, or the kit saying, in its own words, that this address has no kVCM approval to Klima's asset manager. Nothing else does. The kit exits 10 for that and also for "the revoke reverts in simulation", and the bot tells them apart by the reason text, so any other exit-10 answer (the revoke reverts, no reason, a different reason) leaves the take-back owed: the leg ends the pass `held` with the kit's own reason, sends nothing, and approves and retires nothing until a pass where the revoke prepares and goes final. If you upgraded from a version that did not write the take-back down, a klima record left by a retirement it completed counts as owed once: the first live pass asks the kit, and only the no-approval answer clears it. If that older version sent an approve and never wrote a klima record at all, the bot cannot know it is open: the next klima pass retires with it and takes it back, and if you have since dropped klima, check once by hand with the kit's `klima prepare revoke --from 0xYOU`.

**The one case the bot cannot close:** its take-backs themselves revert three times in a row. Then it stops the leg and says so plainly (`A kVCM APPROVAL MAY STILL BE OPEN`), in the output and in `once --json` (`approvalMayBeOpen`). To check it and clear it by hand, run the kit's own command, `klima prepare revoke --from 0xYOU`: it prints the exact approval of zero for Klima's asset manager, which you sign yourself with your own wallet, or it says there is nothing to revoke. When it is cleared, stop the bot, delete `klima:take-back` under `sendFailures` in `state.json`, and start it again.

### The `regen-retire` leg: it prepares and prints, and it never signs

This bot signs Base and Arbitrum transactions with one key, and nothing else. It has no Regen signer, no Regen key and no Cosmos code, so the `regen-retire` leg only asks the kit for the message and prints what it would be. It is off until all five flags are set, and it does nothing when STOP is set (the kit is not even asked).

```
node bot.mjs once --address 0xYOU --legs regen-retire \
  --regen-retire-owner regen1YOU --regen-retire-batch C01-001-20150101-20151231-001 \
  --regen-retire-amount 1 --regen-retire-jurisdiction US-CA --regen-retire-reason "retired by my bot"
```

It prints `regen-retire: DRY, would sign this Regen message: {...}` and says plainly that signing is a separate step you do with your own Regen wallet. Optional: `--regen-lcd https://...` points the kit at a Regen Ledger REST address of your choice (https only).

- The kit reads your tradable balance of that batch and refuses when it is below the amount. The leg then says "nothing to do now" and the other legs go on.
- Before it prints anything, the bot checks the kit's message against your flags: the retirement type, your owner address, that one batch and that amount, that jurisdiction and that reason, and no other field. A message that is anything else is refused and not shown.
- It keeps no state and writes nothing to the ledger. It prints on every wake while the kit still reads at least that amount as tradable; once you have signed and the balance falls below it, the leg says nothing to do. Drop its flags to turn it off.
- A retirement is a sink: what it retires is gone for good, by design, and no return is promised. EcoWealth holds REGEN and may gain if it rises.

## What it can sign

```
node bot.mjs list
```

prints every contract call this program can sign: the contract, the function, and the most ETH that may ride along. That list is in `RULES` at the top of `bot.mjs`. A step that is not on it is refused, nothing is sent for it, and the leg stops until you start the bot again.

- The `regen-retire` leg adds nothing to this list: it has no entry in `RULES`, so the gate refuses any step named for it.
- No plain token transfer is on the list; GMX collateral can be sent to GMX's own order vault under the aggregate cap.
- An approval names its one spender (Klima's asset manager, or GMX's router) and has a cap.
- An `eco-buy` or `net-buy` step is read inside: the ETH it carries is spent by the first swap and nothing else is pulled from your wallet, every hop pays out to the router, and the last command sweeps that one token to you with a floor above zero, or the whole step reverts. The bot also decodes every v3/v4 swap currency, fee, tick spacing, output and hook; each must match one of the six named buy routes (NET: ETH>NET, WETH>NET; ECO: ETH>ECO, ETH>NET>ECO, WETH>NET>ECO, WETH>ZORA>ECO). A fabricated final sweep is not proof of a valid route. The ECO/ZORA pool hook is pinned; if the pool migrates, buying pauses until the bot and its route check are reviewed and updated.
- A NET `circle` trip must encode its own onchain ETH-return floor of at least the full input plus the maximum fee implied by the signed transaction gas settings (including the Base data-fee bound if supplied). Native-ending trips must enforce this on the last ETH sweep; WETH-ending trips must enforce it on the last unwrap before the zero-floor refund. The bot checks the initial ETH settlement or wrap, the permitted early refund, and that a real swap exists. A kit message claiming the loop is profitable is not enough. A reverted transaction can still consume gas, and omitted fee fields are not covered by this calculation.
- A GMX order is read inside: the fee and the collateral go to GMX's order vault only, every wei the step carries is that fee, and what comes back comes to your address. The bot also requires the exact market-increase or market-decrease sequence, matches the nested execution fee and collateral, refuses extra order flags/referrals/callback data, and limits an opening order to 1x-10x by its actual encoded USD size. The signed order type must match whether the bot is opening or closing. The bot binds the order to the owner-selected market (ETH, BTC, ZORA or an explicit market-token address) and direction; opening USDC and leverage must match the exact named amounts, and closing USD size must match the live position read. The market-address examples are pinned to a dated GMX snapshot and may go stale. This does not independently validate oracle prices, liquidation risk, or keeper execution. The bot also refuses a kit's mislabeled GMX step, requires explicit owner intent for any GMX market-order send, and restricts a USDC approval to the owner's exact selected collateral amount. Live GMX still requires a separate review.
- A GMX market-order transaction only places a keeper request; it does not prove the keeper executed it. The hold period begins when a matching onchain position is first observed. A close request preserves the recorded exposure and cannot become `closedAt` until a subsequent read confirms the position is gone. If no close order remains queued but the position is still open, the bot halts instead of silently abandoning or blindly duplicating that order. A keeper rejection or liquidation may still require manual reconciliation.
- A swap may carry at most the size you set for its leg, and never more than 0.05 ETH.
- A swap is read inside too. Only the swap steps the kits build are let through. Nothing may be pulled from your wallet, so a swap spends only the ETH it carries. Every place tokens come out is you. A buy is exactly one swap that takes the token straight to you, and a trip through NET's pools must end by sweeping ETH back to you. So the most a swap leg can lose is the size you set.

## How the key is kept

- The key is read from a file on your machine. On Unix, the file must be readable by you alone or the bot refuses it; the permissions check is skipped on Windows.
- The key is never printed, logged, put on a command line or sent anywhere. The `regen-retire` leg does not read it at all.
- The two kits run as separate programs and are never handed the key. Each prints one unsigned step. This program checks the step, then signs it.
- **Live helper pinning:** the protocol guide and NET circle helpers must be the exact bundled paths and their current reviewed Git blob byte hashes. `--live` rejects substituted paths and changed helper files both before it reads the key and before invoking the default helper runner. Deliberate upgrades require review and matching hash changes to `PINNED_KIT_GIT_SHA1`; do not disable the gate to make an upgraded helper run.
- The helpers still execute as the same Unix user, so a malicious same-user process or a compromised imported dependency can read the private key. Git SHA-1 pins are version-integrity checks, not modern cryptographic authentication or an OS sandbox. Use process isolation and a separate signer before serving untrusted autonomous agents.

## Caps

| Flag | Default | Ceiling |
|---|---|---|
| `--max-tx-fee-eth` | 0.0005 | 0.01 |
| `--day-fee-eth` | 0.001 | 0.05 |
| `--day-spend-eth` | 0.02 | 1 |

The home-folder `state.json` and `ledger.jsonl` form a durable write-ahead transaction journal. **Before any live broadcast**, the bot locally signs a fixed EIP-1559 transaction, verifies the recovered signer and every guarded transaction field, and durably writes its signed bytes, hash, nonce and complete spending reservation. It flushes file contents and parent directory metadata before contacting the RPC, so a lost RPC response does not erase the identity of a transaction that may have been broadcast. Anyone with access to saved signed bytes can broadcast that exact approved transaction, so protect the home directory and backups. The bot never automatically rebroadcasts a transaction with an uncertain outcome.

Later events record broadcast and finalized receipt without charging the same reservation twice. Corrupted, missing, conflicting or orphaned journal records stop the bot rather than resetting its caps. Signed pending bytes must match their hash, and the durable journal reservation must match the pending hash and nonce. A confirmed transaction saves its leg completion checkpoint atomically before pending is cleared. The ledger records upper bounds, not realized P&L, and wallet transactions made outside this bot do not count toward these per-home limits.

The 24-hour rolling caps are enforced **per bot home**, not globally across several devices or agents: ETH spent, signed gas ceiling, **100 kVCM maximum retirement input** and **5 USDC maximum new GMX collateral**. These are reservations of possible spend, not refunds or asset-value estimates. A Klima kVCM approval does not itself count as a retirement, and GMX close transactions do not consume new collateral allowance. Rotating wallets within one home is refused; a historic unbound spend ledger requires manual migration. Users running the same wallet from two machines have no shared global budget and must arrange their own coordination. On one machine a live bot also takes a **wallet lease** (a file named for the address in `~/.vealth-bot-leases`, or the folder in `VEALTH_BOT_LEASE_DIR`), so a second home for the same wallet is refused. Like the home lock it is not stolen after a crash: confirm the first bot is stopped, then remove the file the message names.

The fee caps count signed gas fee fields and include the kit's bound for Base data fees when provided. A data fee not reported by the kit cannot be guaranteed by these caps. Before signing, the bot compares confirmed and pending wallet nonces and checks again before broadcasting. It refuses known nonce conflicts rather than intentionally replacing another pending transaction; this is not a global cross-agent lease.

## Stop it

```
touch ~/.vealth-bot/STOP
```

The STOP file is checked at the start of each pass and before each send; no further transaction is sent while it is present. Removing the file resumes the bot only if nothing was in flight. If STOP arrives after a send has been reserved but before it is broadcast, the reservation and its signed bytes stay in the journal and the bot stays paused until you have checked the wallet's nonce and history and reconciled it; removing STOP alone does not release it.

It sends one transaction at a time. **Only the original hash in the canonical finalized chain** is treated as a completed transaction; a replacement, reorg, nonfinal receipt or RPC disagreement keeps the bot paused. After a finalized receipt is observed following a crash, the bot replays its saved completion checkpoint and reconciles its journal without re-broadcasting. If STOP or an unconfirmed transaction interrupts Klima after approval but before retirement, the approval (at most 100 kVCM) is owed back from the moment it was sent: the first pass after STOP is removed takes it back before anything else the leg does (see "The `klima` leg"). A retirement that is included but not yet final keeps the take-back waiting, and the leg retires nothing new meanwhile. If the RPC outcome is ambiguous or an intent has no known hash, the bot halts: **do not simply delete `pending`**. Verify the wallet nonce, relevant chain history, and journal using trusted independent reads; if a broadcast cannot be excluded, treat it as potentially live. Clearing or rewriting records without such proof can enable duplicate spending. There is not yet an automated, independently verified recovery tool for hashless sends.

The bot requires a real owner-only home directory (`chmod 700` on POSIX) and refuses symlinked or hard-linked state, ledger and lock files. A live pass acquires the home-folder `lock` atomically; a dry pass takes no lock and writes nothing into the home, so it can run while a live bot holds it. If the process crashes, the lock intentionally remains. Confirm the old process is stopped and reconcile its transactions before manually removing the stale lock. File creation, state renames and ledger appends are synced to the containing directory as well as the file itself. Power-loss survival still depends on the storage hardware and operating system honoring those sync requests.

## On a timer

`run` uses monotonic time for its schedule, checks for local clock jumps, and checks live signing time against the chain's latest block within five minutes. Known pending hashes are checked for finality at least every five minutes, even with a slower normal schedule. The witness also checks the chain id, the block time and the confirmed/pending nonce before sending, and it takes part in the finality check; it checks nothing else (see "Two-RPC evidence for live use" above). This does not guarantee a cryptographically independent quorum: providers can share upstream data or operators. For cron or launchd, use `once` only after witness endpoints are configured. This example runs only the `regen` leg, which signs on Base, so it needs a Base witness and no Arbitrum one. Without `--legs`, the default legs include `gmx` and would also need `--arbitrum-witness-rpc`:

```
0 * * * * cd /path/to/packages/protocol-bot && node bot.mjs once --live --legs regen --regen-eth 0.0002 --base-witness-rpc https://<a second Base provider> >> ~/.vealth-bot/bot.log 2>&1
```

## Audit the stopped bot without a key

```sh
node bot.mjs audit --home ~/.vealth-bot
```

This command requires the bot to be stopped. It validates the journal and pending records and reports the wallet, pending transaction hash/nonce (never signed bytes), ledger size and rolling 24-hour reservations. It also produces SHA-256 digests of the state and journal and a combined audit commitment that can be recorded independently. These digests do not become immutable or independently verified merely because the bot computed them; independently retain the hashes and backups to detect later alterations. Invalid UTC times, orphaned reservations, conflicting hashes, unknown future schema versions or corrupt state cause an error. State and journal records include `schemaVersion: 1` for forward migration control; legacy versionless records remain readable for deliberate migration.

### Restoring from a backup

With the bot stopped, make a backup. It copies only the bot's memory (`state.json`, `ledger.jsonl` and its archived segments), never the wallet key, the lock or the STOP file, into a NEW private folder, reads the copy back, and prints the audit commitment:

```sh
node bot.mjs backup --home ~/.vealth-bot --to /somewhere/new/bot-backup
```

Move the backup off the machine and save the printed `auditCommitment` somewhere else again. The backup may hold signed transaction bytes, so keep it private. A corrupt home is refused rather than copied, and a backup never overwrites anything.

After an outage, rebuild a NEW home from the backup. Every file is checked against the manifest, nothing unlisted (a wallet key, a lock) may be in the backup, the files must reproduce the commitment, and only then is the folder put in place. It never overwrites an existing home:

```sh
node bot.mjs restore --from /somewhere/new/bot-backup --home ~/.vealth-bot --expect-commitment <the saved 64 hex characters>
```

Without `--expect-commitment` it can only check the backup against its own manifest, which an attacker who edits both would pass; the value you saved elsewhere is what closes that. Put the SAME wallet's key back at `<home>/wallet.key` (the home is bound to one wallet) before running live. A send that was in doubt when the backup was made is still in doubt after the restore and stays blocked. Any copy of a home can be checked on its own:

```sh
node bot.mjs audit --home ~/.vealth-bot --expect-commitment <the saved 64 hex characters>
```

`audit` and `restore` exit `0` only when the home is exactly the one you saved. They exit `3` when it is an older copy, a newer one or an altered one. **The bot cannot tell by itself that a restored home is missing a purchase it made later**, so an older copy would repeat that purchase and forget its share of the day's caps; the saved commitment is the only protection, and a mismatch means: do not start it live until you have compared the wallet's nonce and history with the journal. A snapshot taken while the bot ran carries its `lock`, and the restored home stays locked until you clear it. The restore drills (snapshot, outage, restore, stale copy, missing or torn files, altered or smuggled backup files, wrong signer, loosened permissions, a send in doubt) are the tests `disaster-recovery drill` and `backup and restore` in `bot.test.mjs`; they run offline with a pretend chain and throwaway keys.

### Bounded archival and recovery

The active journal is streamed through 64 KiB read buffers, rather than loaded as one large string. Rows are capped at 64 KiB and the active journal at 64 MiB. Continuous `run` operation attempts rotation after 8 MiB; only a contiguous prefix of complete, finalized transaction events at least 48 hours old can move. Recent spending remains in `ledger.jsonl`. Incomplete, interleaved or legacy entries are never silently discarded.

The bot writes a durable compaction marker before archiving. The archived original bytes are written to `archives/ledger-<SHA256>.jsonl`, synced and verified before the active ledger is atomically replaced with its remaining suffix. On a restart after power loss, recovery completes only when the original journal or remaining suffix and the archive exactly match the checkpoint. Otherwise trading stops. The exclusive bot-home lock is required for archival and recovery.

With the bot stopped, manually run:

```sh
node bot.mjs compact --home ~/.vealth-bot
```

Startup rehashes archived segments once before permitting trading, and `audit` verifies them again. Keep archive files, state backups and externally saved commitments together. The local archive is not remotely immutable; loss or corruption of an archived segment still requires verified backup recovery. If the active file reaches 64 MiB without a safe completed prefix, the bot fails closed.

For a 100-year, multi-agent service, scheduled off-device copying of backups (the `backup`/`restore` commands and the `--expect-commitment` check exist; moving the copy off the machine is yours), cross-machine nonce and budget coordination (only the one-machine wallet lease exists), isolated signers, reproducible releases, contract upgrade/codehash monitoring, *true independently operated RPC quorum beyond the two witness endpoints*, and external audit anchoring remain unimplemented. This program is not certified for unattended live operation, and nobody has run it live.

## Exit codes

`once` ends with one of these, so a script or a cron job can tell a dead pass from a good one. `run` ignores them between passes (it prints the same summary line each pass).

| Code | Meaning |
|---|---|
| `0` | The pass ran clean. Every selected leg was off, not due, held by a rule (a cap, STOP, the kit's own price-impact limit, a send still waiting for finality), dry, sent or pending. None of those is a failure. |
| `1` | A leg was stopped (a kit stop code, three failures in a row, or three sends of that leg that reverted in a row) and stays stopped until you start the bot again, or, for reverted sends, until you clear the count (below). Also: the bot could not start or finish the pass, and printed one plain line on stderr saying why. |
| `2` | Bad arguments, or the home is locked by a live bot (live passes only; a dry pass takes no lock). |
| `3` | An `audit` or `restore` `--expect-commitment` check did not match. |
| `4` | A rule refused a step and nothing was sent for it. |
| `5` | One or more selected legs failed: a read failed, an error stopped the leg, or a send reverted. A send counts as reverted whether the bot saw it revert in its own pass or found it reverted once it went final, on a later pass (finality lags about 18 minutes, so that is the usual case). One line names the legs (`this pass failed for regen, eco-buy: ...`). Try again later. |

When more than one applies the pass exits with 4 first, then 1, then 5.

**Three reverted sends of one leg in a row stop that leg.** The count is kept in `state.json` under `sendFailures`, one number per leg, so it holds across passes and restarts, and it goes back to zero when a send of that leg succeeds. The pass that sees the third revert exits `1`, and every later pass says the leg is stopped and sends nothing for it. A revert costs gas, so the bot does not retry a third time on its own. To start the leg again, find out why it reverted, stop the bot, delete that leg's line under `sendFailures` in `state.json`, and start it again. That entry is a counter, not a spending record; do not touch `pending` or the ledger.

The Klima leg keeps two counts, `klima` (its approves and retirements; only a retirement that goes final resets it) and `klima:take-back`, and it stops for the first only after the kVCM approval has been taken back, so there is no approval left for you to revoke by hand. The pass that finds the third reverted retirement sends the take-back and exits `5`; the pass after it, with the take-back final, stops the leg and exits `1`. The one exception is a take-back that itself reverts three times: see "The one case the bot cannot close" under the `klima` leg.

## Reading a pass by machine

`once --json` (dry or live) prints one JSON object on stdout when the pass ends. Every human line goes to stderr instead, so stdout is only the JSON. A pass report holds no key and no node address (a web address inside a kit's error text is cut out and shown as `[url]`). It holds `bot`, `version`, `mode` (`dry` or `live`), `address`, `exitCode` (the same number the command exits with), `failedLegs`, `approvalMayBeOpen` (`null`, or, only when the Klima take-backs themselves stopped, `{ token, spender, check, how }`: the kVCM approval that may still be open, and the kit command that checks it), and `legs`: one entry for every selected leg, in loop order (the Klima leg is also there when it was not selected but settled a take-back it owed), each with:

- `name` and `state`, one of `off` (nothing turns it on), `not_due` (its own schedule says not yet, or it is already done), `dry` (it would send), `sent`, `pending` (sent, not final yet), `held` (a cap, STOP, a pending send, or the kit says nothing to do now), `refused` (a rule refused it, or it is stopped) or `failed` (a failed read, an error, or a send that reverted);
- `reason`, the plain line the human output shows;
- `sends`, one entry per transaction the leg tried: `step`, `outcome` (`dry`, `sent`, `pending`, `reverted`, or `budget` when a cap, STOP or a pending send held it), `chain`, `token` (a symbol), `amount` (a decimal string in token units), `amountRaw` (the integer string in the token's smallest unit), `amountIs` (what that amount is: the least you receive, the most it may spend, the approval it sets, the collateral it posts, or the ETH it spends), `valueEth` and `valueWei` (the ETH the transaction carries) and `hash` (null until there is one).

If the pass cannot run (the arguments are refused, the home is locked, the bot cannot start), the object is `{ bot, version, exitCode, error }` with the same exit code the command ends with; `error` is the plain message and can name a folder. `--json` belongs to `once` only.

## Long-lived deployment boundaries

- The rule set, protocol addresses, pool keys, chain IDs and market symbols are **date-pinned**, not eternal truths. A migration should make a transaction fail closed until its replacement is reviewed and tested. No upgrade silently inherits signing permission.
- This program cannot guarantee profit, nonnegative P&L, successful execution, or zero loss. Reverted calls can consume gas, approved tokens can be exposed between steps, price impact can be severe, and upgrades or liquidations can destroy capital.
- External kits run with the same operating-system identity as the bot. Even though they are not passed the private key, a malicious kit could read a same-user key file. Production sovereign-agent deployment requires independently reviewed kit hashes and OS-level isolation, not just command-line environment filtering.
- Test the complete package and both kits in an isolated Node 22 environment, run the repository gates and an independent security audit, and verify real RPC behavior. Passing isolated guard tests and JavaScript syntax checks is not production certification.
- Reading or running this code dry is not permission to sign. The bot stays dry unless you pass `--live` yourself.
## Check it yourself

```
npm test
```

The package suite exercises the bot's transaction guards against mock-chain responses, including witness disagreement and missing-proof cases, and includes real filesystem crash tests for the archive module. Run the archive tests separately with `npm run test:archive`. All checks are offline: a pretend chain, a pretend node on the loopback address and throwaway keys, never a funded key. The suite tries no real chain, real RPC or live send, and it has run on Node 20 only (the package asks for Node 22 or newer).
