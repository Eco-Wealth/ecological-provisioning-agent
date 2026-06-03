# SDK

The TypeScript SDK exposes the provisioning loop as pure functions.

## Functions

```ts
composeIntent(input)
applyPrincipleLens(intentOrPacket, lenses)
routeStewardship(intent)
buildPacket(intent, route)
writeReceipt(packet, proofs)
validateTruthBoundary(object)
```

## Design goals

- Pure where possible.
- Local-first.
- Dependency-light.
- Truth-boundary-first.
- Easy to wrap with CLI, MCP, web UI, or private adapters.
