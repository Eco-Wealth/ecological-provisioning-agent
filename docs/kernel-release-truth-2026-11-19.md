# Public kernel trust-guard revision (2026-11-19)

## Checked before edit
- Public main at `5918b557505cc23591860409709c8c00cfeb7f75` already has the full canonical Apache-2.0 license. The earlier review's incomplete-license concern is already resolved; no license rewrite was necessary.
- `docs/truth-boundaries.md`, `SECURITY.md`, and `CONTRIBUTING.md` already disclose the agent client's wallet-signing x402 ability and the steward's locally stored signing key. These were not weakened.
- The agent-client quick start still installed `viem` without a package pin or a lockfile, unlike the steward and protocol-bot packages.

## Shipped only to this draft branch
- Added `packages/agent-client/package.json` and `package-lock.json`, using the existing steward's integrity-pinned transitive `viem@2.57.10` graph; these files change no runtime code.
- Changed the README's agent-client signing example to `npm ci --ignore-scripts --prefix packages/agent-client`, explicitly using the pinned lock.
- Added `tests/kernel-release-truth.test.mjs` (offline Node test) pinning the exact canonical Apache-2.0 license, the manifest-lock parity and integrity, documented payment limits, steward key creation, and contribution restrictions. It performs no network request, signing, payment, posting or credential lookup.

## Proof
- Source-level read verified the lock has 14 entries and all 13 dependency entries have public-registry URLs and SHA-512 integrity fields.
- Read-only regex checks verified the agent's default `$0.25` per-run and `$5` per-day limits and exact host allowlist still match the source, and README uses the pinned install.
- Entire package test suite (`npm test`), `npm ci`, independent second reviewer and build checks: **NOT RUN** here because the public repo is unavailable as an executable checkout.

## Boundary
Draft PR only. No public release, no live key, no wallet money, no automatic agent execution. The existing reviewed signing capabilities remain present; these tests describe their limits rather than asserting security.
