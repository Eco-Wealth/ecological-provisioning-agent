# Ecological Provisioning Agent

A brandless, local-first kernel for converting ecological and civic intent into work packets, proof plans, receipts, SDK flows, CLI commands, workflow templates, skill blueprints, and MCP/API contracts.

This repository is not a certification platform, payment rail, labor-dispatch system, government system, or environmental verification authority. It is a coordination kernel for drafting and checking useful ecological work.

## Core loop

```text
intent -> principle lenses -> stewardship route -> work packet -> proof plan -> receipt -> next packet
```

## What this repo includes

```text
schemas/                 JSON schemas for intents, routes, packets, proofs, receipts, adapters
packages/sdk/            TypeScript SDK for the provisioning loop
packages/cli/            Local CLI wrapper around the SDK
packages/mcp/            Local-first MCP server stub exposing provisioning tools
packages/workflows/      Runbooks and packet/receipt workflows
packages/skills/         ChatGPT Skill blueprints for repeatable provisioning tasks
apps/demo-operator/      Static demo operator surface
examples/                Example inputs, outputs, packets, proofs, receipts, public-data records
prompts/                 Build, review, packet, and receipt prompts
docs/                    Architecture, truth boundaries, public data policy, autonomy model
receipts/                Migration and build receipt templates
```

## Install

```bash
pnpm install
pnpm build
```

The repo is intentionally dependency-light. The SDK is pure TypeScript. The CLI and MCP packages wrap the SDK.

## Try the example flow

```bash
pnpm build
node packages/cli/dist/index.js compose examples/inputs/degraded-lot-intent.json
node packages/cli/dist/index.js route examples/outputs/intent.example.json
node packages/cli/dist/index.js packet examples/outputs/packet.bundle.example.json
node packages/cli/dist/index.js receipt examples/outputs/proof.example.json
node packages/cli/dist/index.js validate examples/outputs/receipt.example.json
```

## Demo surface

Open this file locally:

```text
apps/demo-operator/index.html
```

The demo is static and does not call live services.

## Truth boundary

The system may draft, structure, route, cite, validate, and propose.

It must not claim certification, move funds, dispatch labor, sign transactions, deploy infrastructure, post publicly, or represent itself as an authority.

See [`docs/truth-boundaries.md`](docs/truth-boundaries.md).

## Public data policy

Public data can be used as context, citation, signal, and input when license and terms allow it. External references should preserve source, retrieval time, confidence, and license or terms notes.

See [`docs/public-data-policy.md`](docs/public-data-policy.md).

## License

Apache-2.0.
