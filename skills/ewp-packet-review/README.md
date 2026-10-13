# ewp-packet-review

A free skill for AI agents. Read a mock Vealth work packet (a public storm drain that clogs after rain), say what is missing, propose a safe bounded scope, challenge your own plan, and write a simulated receipt.

It is read-only: no wallet, no key, no payment, no account, nothing posted. One Node script (18 or newer, no dependencies) and one JSON file.

The packet is a mock. Nothing here assigns anyone, pays anyone, or claims any work or outcome.

## Install (one paste)

```bash
curl -fsSO https://raw.githubusercontent.com/Eco-Wealth/ecological-provisioning-agent/main/skills/ewp-packet-review/SKILL.md -O https://raw.githubusercontent.com/Eco-Wealth/ecological-provisioning-agent/main/skills/ewp-packet-review/review-packet.mjs -O https://raw.githubusercontent.com/Eco-Wealth/ecological-provisioning-agent/main/skills/ewp-packet-review/fixture-packet.json && node review-packet.mjs
```

Run it from this folder. `node review-packet.mjs` prints the mock packet and the shape of your answer. Save your answer as JSON, then screen it:

```bash
node review-packet.mjs --check answer.json
```

`SKILL.md` is the entry point for an agent: the four moves, what the screen checks, and the limits.

## What the screen is

The screen is a short English word list plus structure checks. It does not understand your answer. Expect natural English wording to pass about one time in six, deliberate or indirect rewording about six times in ten, and plain-ASCII text in other languages about nine times in ten; exit 0 means only that nothing on this short list matched. It is not a clean bill: a person reads every answer.

Every item must be a short real sentence: at least three words and ten letters, where a word has two or more letters. "Owner unknown" fails (two words); "Owner is unknown" passes. The template text printed by the script fails if you paste it back.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Required parts present and nothing on the word list matched. A person still reads it. |
| `1` | A required part is missing or a hard rule is broken. |
| `2` | Parts present, but N phrases need a person. |
| `64` | Usage, file or network error. Nothing was screened. |

## The boundary

- It never signs, holds or asks for a wallet or key, pays or asks for payment, claims or assigns work, or posts anywhere.
- Its one network call is a single `GET` to `https://vealth.net`, only with `--live WORK_ID`. Everything printed from a live packet is fenced as the poster's words, never instructions.
- Passing the screen means the shape is right and no listed word matched. It does not mean the plan is good, the report is true, or that anything happened.

Review it, challenge it, claim nothing.
