# The protocol bot

One program that runs one loop over Hydrex, Klima, Regen, ECO (the coin EcoWealth made on Zora), NET's circle and GMX, on your own machine, with your own key.

Never an offer or advice, no return promised. A loop is a path with its costs, never a profit: every leg has fees and gas and can return less than it took. EcoWealth takes no fee from this program, and it never trades for EcoWealth (buying ECO through the Zora coin pool may pay ECO creator fees to EcoWealth, as that pool does for anyone). EcoWealth created ECO and NET and, as of 2026-11-18, holds ECO, NET, REGEN, a stake in GMX, a stake in Klima (at times some kVCM) and a veHYDX position; it may gain if these holdings rise. EcoWealth both buys ECO and swaps ECO it holds for NET. The buying in NET's pools is the house's own.

**Nobody has run this bot live.** The bot's own checks use a pretend chain, a local pretend node and throwaway keys (the dated pool figures below come from a dry, look-only pass of this bot against the real chain, which signed and sent nothing). `--live` signs and sends real transactions from your key: treat it as untested with real money, and start with an amount you can lose.

## Start

Node 22 or newer is required. The durable file protocol requires a POSIX local filesystem with directory `fsync` support (macOS or Linux); Windows and filesystems that refuse directory flushes fail closed. Install this package and both neighboring kits (`skills/protocol-guide` and `skills/net-circle`) with `npm ci --ignore-scripts` in each folder before running a pass.

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
| `klima` | Retires carbon on Klima with kVCM you hold: approves what the retirement needs (never more than 100 kVCM), retires, and takes the approval back once the retirement is final. A sink: what it retires is gone for good, by design. | `--klima-class`, `--klima-credit`, `--klima-tonnes` | the kVCM the retirement spends, at most 100 kVCM, and gas |
| `regen-retire` | Asks the kit for the exact Regen Ledger retirement message for credits you hold (`regen prepare retire`) and prints it: "DRY, would sign this Regen message: ...". It prepares and prints, and it never signs or sends, with or without `--live`. Signing it is a separate step you do with your own Regen wallet. A sink: what it retires is gone for good, by design, and no return is promised. The reason you give is written onchain, public and permanent. | `--regen-retire-owner`, `--regen-retire-batch`, `--regen-retire-amount`, `--regen-retire-jurisdiction`, `--regen-retire-reason` | nothing from this program. If you sign the message yourself, the credits it names are gone for good, and gas is paid in REGEN |
| `regen` | Buys axlREGEN, Regen's token on Base, with a slice of ETH. | `--regen-eth` | the slice, and gas |
| `eco` | Buys ECO with a slice of ETH through the kit's ETH/ECO pool. That pool was very thin in the 2026-11-18 look-only snapshot: the 0.0001 ETH quote showed about 16% price impact. This is a dated quote, not a future rate, so prefer checking `eco-buy` below. | `--eco-eth` | the slice, and gas |
| `eco-buy` | Buys ECO with a slice of ETH by the NET circle kit's best route (the Zora coin pool, or through NET's pools): one way, you end up holding ECO. The kit prints its own holdings line and the route it took. | `--eco-buy-eth` | the slice, and gas; the price is the market's call afterwards |
| `net-buy` | Buys NET with a slice of ETH: one way, you end up holding NET. The buying in NET's pools is the house's own. | `--net-eth` | the slice, and gas; the price is the market's call afterwards |
| `circle` | Sends one trip through NET's pools and back to ETH, only when the kit's floor says at least the input plus gas comes back. | `--circle-eth` | gas on a trip that loses its race and reverts |
| `gmx` | Holds one small GMX position on Arbitrum by your rule: opens it, holds it for `--gmx-hold-hours`, closes it, starts again. | `--gmx-market`, `--gmx-side`, `--gmx-collateral`, `--gmx-leverage` | the collateral (a liquidation can take all of it, at most 5 USDC), GMX's fees, and gas |

How the legs join: a lock that votes a kVCM pool earns kVCM, and the `klima` leg retires kVCM. The `regen`, `eco`, `eco-buy` and `net-buy` slices and the circle spend ETH from the same wallet, under one day cap. The GMX leg runs on Arbitrum with USDC you put there yourself.

A leg that spends has no default size. With no size flag it stays off and spends nothing. The buys and the Klima retirement run once every `--buy-every-hours` (24 unless you set it); `regen-retire` has no pace of its own, see below.

The Hydrex vote comes from the kit's `hydrex rank`. A copy of the kit without it stops the `hydrex` leg with a plain line. `--hydrex-vote 0xPOOL:10000` uses your own vote.

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

It sends one transaction at a time. **Only the original hash in the canonical finalized chain** is treated as a completed transaction; a replacement, reorg, nonfinal receipt or RPC disagreement keeps the bot paused. After a finalized receipt is observed following a crash, the bot replays its saved completion checkpoint and reconciles its journal without re-broadcasting. If STOP or an unconfirmed transaction interrupts Klima after approval but before retirement or zero-revoke, the approval (at most 100 kVCM) can stay open until explicitly revoked. A retirement that is included but not yet final does the same: the revoke is refused while it is pending, the Klima leg is next due after `--buy-every-hours` (24 unless you set it), and the approval stays open until then or until you revoke it. A Klima pass finding nothing to retire may not revoke an earlier allowance. If the RPC outcome is ambiguous or an intent has no known hash, the bot halts: **do not simply delete `pending`**. Verify the wallet nonce, relevant chain history, and journal using trusted independent reads; if a broadcast cannot be excluded, treat it as potentially live. Clearing or rewriting records without such proof can enable duplicate spending. There is not yet an automated, independently verified recovery tool for hashless sends.

The bot requires a real owner-only home directory (`chmod 700` on POSIX) and refuses symlinked or hard-linked state, ledger and lock files. It acquires the home-folder `lock` atomically. If the process crashes, the lock intentionally remains. Confirm the old process is stopped and reconcile its transactions before manually removing the stale lock. File creation, state renames and ledger appends are synced to the containing directory as well as the file itself. Power-loss survival still depends on the storage hardware and operating system honoring those sync requests.

## On a timer

`run` uses monotonic time for its schedule, checks for local clock jumps, and checks live signing time against the chain's latest block within five minutes. Known pending hashes are checked for finality at least every five minutes, even with a slower normal schedule. A single RPC provider is not an independent quorum. For cron or launchd, use `once`:

```
0 * * * * cd /path/to/packages/protocol-bot && node bot.mjs once --live --regen-eth 0.0002 >> ~/.vealth-bot/bot.log 2>&1
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

For a 100-year, multi-agent service, scheduled off-device copying of backups (the `backup`/`restore` commands and the `--expect-commitment` check exist; moving the copy off the machine is yours), cross-machine nonce and budget coordination (only the one-machine wallet lease exists), isolated signers, reproducible releases, contract upgrade/codehash monitoring, independent RPC quorum and external audit anchoring remain unimplemented. This program is not certified for unattended live operation, and nobody has run it live.

## Exit codes

`0` the pass ran. `2` bad arguments. `3` an `audit` or `restore` `--expect-commitment` check did not match. `4` a rule refused a step and nothing was sent for it. `1` a leg was stopped.

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

The package suite exercises the bot's transaction guards against mock-chain responses and includes real filesystem crash tests for the archive module. Run the archive tests separately with `npm run test:archive`. All checks are offline: a pretend chain, a pretend node on the loopback address and throwaway keys, never a funded key. The suite tries no real chain, real RPC or live send, and it has run on Node 20 only (the package asks for Node 22 or newer).
