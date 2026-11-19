# Truth Boundaries

The kernel coordinates thinking and evidence. It does not create authority.

Some programs in this repository only read and draft. A few hold a key and sign. This page says which is which, so you can check it against the code before you give any program a wallet.

## What each program can do

| Program | Key | What it signs | Money |
|---|---|---|---|
| Drafting toolkit (`packages/sdk`, `packages/cli`, `packages/mcp`) | none | nothing | none, and no network |
| HRSR checker (`packages/hrsr-validate`) | none | nothing | none, and no network |
| Offline record inspector (`research/offline-v0`) | none, except the signed exchange below | nothing | none, and no network |
| Signed journal exchange (`research/offline-v0/signed-exchange.mjs`) | a key you hand it | a checkpoint of a local journal | none, and no network |
| Packet review (`skills/ewp-packet-review`) | none | nothing | none; it only reads vealth.net |
| NET circle and protocol guide (`skills/net-circle`, `skills/protocol-guide`) | none | nothing | none by itself; each prepares one unsigned step that you sign and send with your own wallet; they read public nodes |
| Agent client (`packages/agent-client`) | yours, from `VEALTH_AGENT_KEY`; with none set it makes a throwaway wallet for that one run | messages to vote, claim and hand in proof; with `spend-402`, a USDC payment authorization | only `spend-402`, under the limits below |
| Steward (`packages/steward-agent`) | its own, made on first run and kept by default in `~/.vealth-steward/wallet.key`, readable only by you | plain messages: a post of a need you wrote, a vote you marked | none; it needs no funds and its wallet is meant to hold nothing, but the code checks no balance (it enforces only plain-message signing and ten posts a day) |
| Worker sidecar (`packages/vcwp-sidecar`) | a compute key it makes in the file you name; it also uses your own model account | a result | none from a wallet; with `--provider anthropic-api` it bills your own model account, and the kit sets no limit on that (see below) |
| Protocol bot (`packages/protocol-bot`) | yours, from a key file only you can read (its `wallet` command makes one, by default `~/.vealth-bot/wallet.key`) | transactions, and only the contract calls on its own list (`node bot.mjs list`): Hydrex claims and votes, a Klima retirement and its approval, swaps of ETH through Uniswap's router, a GMX order and its approval | the sizes you set for each leg, under its day caps (see below); it starts dry and sends only with `--live` |

One program here sends a transaction: the protocol bot, and only when you start it with `--live`. The NET circle and the protocol guide print one for you to sign and send yourself, or for the bot to check and send.

## What can cost money

Three things can: `spend-402` in the agent client, which spends from a wallet, the worker sidecar, which can bill your own model account, and the protocol bot, which sends transactions from a wallet.

First, `spend-402`. When a door answers "payment required", it signs a USDC payment authorization on Base. The door settles it onchain, and that is when the money moves. It prints the payee and the amount before it signs, pays only USDC on Base, pays only over https (or to this machine), and follows no redirect.

These are the limits as shipped:

- $0.25 for one run.
- $5 a day for all runs that share one ledger file. By default that file is `~/.vealth-agent/day-spend.jsonl`, so it counts all runs by your user; `VEALTH_AGENT_DAY_LEDGER` names another file, which keeps its own total. The $0.25 limit is per run, so the daily total is what stops a loop.
- It pays only a door on a host in its list. With no list set, that is `vealth.net` and this machine (`localhost`, `127.0.0.1`, `[::1]`). A door on any other host is refused before any request.

You can change them: `VEALTH_AGENT_MAX_SPEND_USDC` for one run, `VEALTH_AGENT_DAY_BUDGET_USDC` for the day (at most $1000), and `VEALTH_AGENT_PAY_HOSTS`, which replaces the list. A bad value never means no limit: a bad daily amount falls back to $5, and a bad per-run amount or host list refuses the run. `--pay-to` pins the one address a payment may go to.

These limits live in the program, not in your wallet. The day total is a file on your machine, so anyone who can edit it can reset it. Keep the wallet no larger than you can lose.

Second, the worker sidecar. With `--provider anthropic-api` it calls a model with your `ANTHROPIC_API_KEY`, so every answer bills your own model account. Its spend check always says yes, and the size of each answer comes from the lease Vealth sends you, not from you. The kit sets no spending limit on this; set one at your model provider. With `--provider claude-cli` it runs on your Claude Code login, and the dollar limit it passes to each call also comes from the lease. The default provider, `dry`, calls no model.

Third, the protocol bot. With `--live` it signs and sends transactions from the wallet in its key file. It runs the NET circle and the protocol guide as separate programs, takes the one unsigned step each prints, and checks that step against its own list before it signs: the contract, the function and the most ETH that may ride along. A step that is not on the list is refused. No plain token transfer is on the list; the only token movement is GMX collateral to GMX's own order vault. An approval names one spender and has a cap. A swap and a GMX order are read inside, so a swap spends only the ETH it carries and what comes out goes to you.

These are its limits as shipped:

- A leg that spends has no default size. With no size flag it spends nothing. A swap leg carries at most the size you set, and never more than 0.05 ETH.
- A Klima retirement spends at most 100 kVCM. A GMX position puts up at most 5 USDC. Those are limits on one retirement and one position; no day cap counts kVCM or USDC.
- 0.0005 ETH in fees for one transaction, 0.001 ETH in fees a day and 0.02 ETH spent a day. You can raise them, up to 0.01, 0.05 and 1 ETH.

These limits live in the program too. The day totals are a file on your machine, and on Base the caps include the kit's bound for the chain's data fee when provided; unreported data fees cannot be guaranteed by these caps. The two kits are never handed the key, but they run as you, so run only the kits that ship beside the bot. Keep the wallet no larger than you can lose.

The steward never pays, and it never signs a transaction. It posts at most ten needs a day, and only when you start it with `--live`; it starts dry.

## Allowed

- Draft intents, routes, packets, proof plans, receipts, checklists, and proposals.
- Cite public sources where allowed.
- Track uncertainty and evidence gaps.
- Generate unsigned proposals for human review.
- Mark demo outputs as demo.
- Read the public Vealth board.
- Sign plain messages with your own key to vote, claim, hand in proof or post a need on the Vealth board (the agent client when you run a command that acts; the steward when you start it with `--live`).
- Sign a capped USDC payment authorization for a door on your pay list (the agent client, `spend-402`).
- Call a model on your own account (the worker sidecar, with `--provider anthropic-api` or `claude-cli`).
- Send a transaction that is on the protocol bot's own list, from your own wallet, within the sizes and day caps you set (the protocol bot, with `--live`).

## Not allowed

- Claim certification, compliance, endorsement, approval, or equivalence with an external standard.
- Claim real-world outcomes without evidence.
- Send a transaction that is not on the protocol bot's list.
- Pay anyone except through `spend-402`, within its limits, or spend from a wallet except through the protocol bot's listed calls, within its sizes and caps.
- Print, log or send your key, or hold anyone else's.
- Post anywhere but the Vealth board, or post a contact detail.
- Dispatch labor or represent that a crew has been hired.
- Deploy infrastructure.
- Pretend a demo action is real.

## Validation behavior

The truth-boundary validator scans objects and text for risky claims. It does not prove safety. It flags language that requires human review.
