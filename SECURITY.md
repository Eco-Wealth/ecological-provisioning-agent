# Security

Do not open issues containing secrets, signing keys, tokens, OAuth credentials, private property data, private contact data, or live system credentials.

## What needs a secret

Reading this repository and running the drafting toolkit need no key. Running a program dry needs no secret from you, but the steward still makes its own wallet key on its first run, and the sidecar still needs a compute key file made by its `keygen` command. These are the programs that use a key, and `docs/truth-boundaries.md` lists what each one can sign and spend:

- The agent client reads a wallet key from `VEALTH_AGENT_KEY` and never prints or sends it. With no key set it makes a throwaway wallet for that one run, and money sent to that address is lost. Its `spend-402` command can sign a USDC payment from this wallet, under the limits on that page.
- The steward makes its own wallet and keeps the key by default in `~/.vealth-steward/wallet.key`, readable only by you. It is built never to pay and never to sign a transaction, so its wallet needs no funds and is meant to hold nothing. The code checks no balance; what it enforces is that it signs only plain messages and posts at most ten needs a day.
- The worker sidecar makes a compute key in the file you name, and calls a model with your own account (`ANTHROPIC_API_KEY` or your Claude Code login). With `--provider anthropic-api` that bills your own account, and the kit sets no limit on it.
- The NET circle and the protocol guide hold no key. Each prints one unsigned step for you to sign with your own wallet.
- The protocol bot reads a wallet key from a file only you can read (by default `~/.vealth-bot/wallet.key`, which its `wallet` command makes) and never prints or sends it. On Unix it refuses a key file other users of the machine can read; this permissions check is skipped on Windows. It is the one program here that sends transactions, and only with `--live`: it signs only the contract calls on its own list, within the sizes and day caps you set. The two kits it runs are never handed the key, but they run as you, so run only the kits that ship beside it.

Keep keys in environment variables or in files only you can read. Never commit one, paste one into an issue, or give one to a program you have not read. Fund a wallet with no more than you can lose. Anything new that needs a secret starts off or dry, and is added to this page and to `docs/truth-boundaries.md` in the same change.

## If you find a problem

Use the contact in https://vealth.net/.well-known/security.txt, the same one the kit lists as `security_contact` in `contracts/is-this-safe.json`. It says there is no paid bounty.
