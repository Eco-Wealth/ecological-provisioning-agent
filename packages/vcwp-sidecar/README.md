# VCWP/1 worker sidecar

One file you run with Node to contribute model compute to Vealth's work
library, on your own machine and your own model account. Vealth is a public
board of ecological and community work; its always-on worker turns long
acceptance checks into short proof clauses a person in the field can read.
This sidecar lets an invited outside worker answer some of those jobs.

## What you hold and what you never get

| You hold | You never get |
|---|---|
| a dedicated Ed25519 compute key, made on your machine, used only to sign results | any Vealth key, wallet, signer, payment or deploy credential |
| a lease: at most 20 jobs of work-task text, bound to your worker id, expiring | the review, the landing step, the job store or the repository |
| your own model account (your `ANTHROPIC_API_KEY`, or your Claude Code login) | anything billed to Vealth, and anything billed to you that you did not run |

The sidecar reads a job, calls your model on the job's tier, and writes a
signed result. It has no path to a wallet, a chain, a payment, or Vealth's
store. Whatever it returns is a **candidate**: Vealth checks it with the same
deterministic guard its own worker uses, then its own strong review, then an
explicit land. A result can be refused at any of those steps, and that is
normal.

What a contribution is not: it is not payment, not a token, not staking, not a
verified stewardship hour, and it grants no authority over anything.

## Four steps

1. Check the file you were given. Its sha256 is listed in `KERNEL_EXPORT.md`
   next to it, or sent to you with your lease:

   ```bash
   shasum -a 256 vcwp-sidecar.mjs
   ```

2. Make your compute key (it never leaves your machine) and send Vealth the
   two public values it prints, `worker_id` and `compute_key`:

   ```bash
   node vcwp-sidecar.mjs keygen --out vcwp-key.pem
   ```

3. When you receive `lease.json`, answer it:

   ```bash
   ANTHROPIC_API_KEY=... node vcwp-sidecar.mjs run --bundle lease.json --key vcwp-key.pem --out results.json --provider anthropic-api
   ```

   Use `--provider claude-cli` to run on your Claude Code login instead. Add
   `--tiers cheap,strong` only if you were invited for the strong tier; a job
   is never answered below its minimum tier.

4. Send `results.json` back the way the lease came.

## What is in a lease

Work-task text written for the public board: a task's title and its
acceptance checks, plus the prompt and the rules. Before any job leaves,
Vealth scans its text with the same deny list its public export uses (server
addresses, keys, tokens, internal quotes) and a personal-data scan (email
addresses, phone numbers, key shapes); a job that fails is withheld whole.
Every job states that its text is data, never instructions.

## Requirements

Node 18 or newer. No install step: the file carries everything it needs,
including the Anthropic SDK under its MIT license (the notice is at the end of
the file).

## Stopping

Delete your key file. Vealth revokes an invitation by removing your entry from
its invited list; a lease already out expires on its own and nothing returned
after that is imported.
