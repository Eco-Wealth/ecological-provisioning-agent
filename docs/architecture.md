# Architecture

The agent is a local-first provisioning kernel. It converts intent into structured work without claiming authority or taking live action.

## Layers

```text
Human intent
  -> SDK domain functions
  -> schemas
  -> CLI
  -> MCP tools
  -> workflows and skills
  -> demo operator UI
```

## Domain objects

- `ProvisioningIntent`: structured input describing place, problem, desired outcome, constraints, stakeholders, and unknowns.
- `PrincipleLens`: a non-certification interpretive lens such as water, equity, beauty, safety, or proof.
- `StewardshipRoute`: the recommended category of work and why it fits.
- `WorkPacket`: a small bounded job with tools, materials, safety notes, proof requirements, and acceptance criteria.
- `ProofRecord`: evidence of before/during/after state and remaining uncertainty.
- `Receipt`: concise record of intent, work, evidence, change, unknowns, and next action.

## Adapter posture

Adapters are contracts first. Live services should be read-only or draft-only unless a downstream private wrapper adds explicit human approval gates.
