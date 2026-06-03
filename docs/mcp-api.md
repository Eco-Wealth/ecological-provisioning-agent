# MCP and API Contract

The MCP package exposes local-first tools mirroring the SDK.

## Tools

- `compose_intent`
- `apply_principle_lens`
- `route_stewardship`
- `build_work_packet`
- `write_receipt`
- `validate_truth_boundary`

## External APIs

External APIs should be added as adapters, not embedded in core logic. Each adapter should declare:

- mode: read-only, draft, or live.
- permission requirements.
- source metadata.
- failure modes.
- truth-boundary implications.
