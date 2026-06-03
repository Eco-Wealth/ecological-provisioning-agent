# Public Data Policy

Public data can support provisioning when used carefully.

## Data can be used as

- Context.
- Signal.
- Citation.
- Evidence pointer.
- Input to a human-reviewed packet.

## Data must preserve

- Source.
- Retrieval time.
- License or terms note.
- Confidence.
- Citation URL when applicable.
- Known limitations.

## Data must not be treated as

- Permission to act on private property.
- Proof that work was completed.
- Authority to certify.
- A replacement for field observation.
- Permission to scrape or republish restricted material.

## Adapter output shape

```json
{
  "source": "string",
  "retrieved_at": "ISO-8601 datetime",
  "license_or_terms_note": "string",
  "confidence": "low|medium|high",
  "citation_url": "string",
  "limitations": ["string"]
}
```
