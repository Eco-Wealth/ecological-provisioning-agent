# Contributing

Contributions should improve the local provisioning loop while preserving truth boundaries.

## Required posture

- Keep changes brandless.
- Keep the drafting toolkit (`packages/sdk`, `packages/cli`, `packages/mcp`) free of live powers: no network, no key, no money.
- Say every live power plainly. Anything new that signs, spends, posts or calls a live service is listed in `docs/truth-boundaries.md` and on its own page in the same change, starts off or dry, and has a limit.
- Keep every limit that exists. A change that raises or removes one needs its reason written in the change.
- Keep evidence separate from claims.
- Keep public data cited and terms-aware.
- Keep work packets small and reviewable.

## Before opening a PR

```bash
pnpm build
pnpm test
```
