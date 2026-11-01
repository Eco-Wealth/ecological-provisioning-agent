# Human-Reviewed AI Safety Report (HRSR), version 0

Status: draft v0, open for comment. License: Apache-2.0. Not legal advice. Not endorsed by any agency.

## 1. The idea in five lines

1. A named person who was on site observes and takes the photos.
2. Software, including AI tools, may help draft the report from that person's own notes.
3. A human reads every line, changes what is wrong, and signs.
4. The record says who did what, with which tools, and when.
5. Evidence is fingerprinted, not published. A report says what was seen, never what to conclude.

This standard describes a record format and a way to check that record. It does not describe how to do safety work well, and it does not replace a competent person, a safety program, an inspection by an agency, or a lawyer.

## 2. What this is not

- **Not an inspection.** A report under this standard is a record of conditions as seen on one day by one person.
- **Not a compliance determination.** It does not say a site, a person or a company meets or fails any rule.
- **No verdicts.** A report does not say a condition is safe, unsafe, compliant, in violation, approved or certified. The checker flags those words in the summary, the findings and the notices; it does not assess every text field.
- **No directing of corrections.** The reporter tells the client's named authority what was seen. The client decides what to do and does it.
- **Not a certification.** Conforming to this format earns no mark and no approval.

A record shows what was claimed. It cannot prove that the observer was there, that the photos are honest, or that the review was careful. Section 9 lists what a verifier can and cannot show.

## 3. Roles

- **Observer.** A named person who was on site. A credential is optional. If one is claimed, the record gives its issuer, its identifier and a link where the issuer's own page can be checked by anyone.
- **Drafting tools.** Any software that touched the text or the images: name, version, purpose, and whether it is AI. Tools are listed even when they only transcribed.
- **Reviewer.** A human who reads the whole draft. The reviewer can be the observer. A tool is never the reviewer.
- **Client safety lead.** The named authority who receives anything urgent. The record says who was told, when and how.

## 4. The record

The record is one JSON document that matches `schemas/human-reviewed-ai-safety-report-v0.schema.json`. Required fields:

| Field | What it holds |
|---|---|
| `spec_version` | `"hrsr-0"` |
| `report_id`, `created_at` | an identifier and a time |
| `observation` | start and end time, a client-chosen site label, an optional coarse area note. An address is never required. |
| `observer` | name, optional role, optional credential with a verification link |
| `tools` | every tool, its kind (AI drafting, AI transcription, AI image assist, other software, manual) and its purpose |
| `inputs` | the observer's notes and photos, each with a SHA-256 fingerprint and a capture time; for each photo, whether location was shared and what the human did with it (used, excluded, or blurred then used) |
| `final` | the SHA-256 of the released text and its format |
| `limits_statement` | plain words saying what the report is not and what was not done |
| `ai_disclosure` | whether AI tools drafted any part, and a plain statement |
| `review_log` | time-ordered entries: who, whether human or tool, what action, an optional note |
| `signoff` | the signer, the time, and a short statement that the signer read and stands behind the text |

Optional fields: `draft` (a fingerprint of the draft before review), `findings` (what was seen, each tied to photos), `notices` (who was told about anything urgent, when and how), `anchoring` (section 6), `conformance_claimed` (L0 to L3).

Files may be named by a relative `file` path on notes, photos and the final text, so a verifier can recompute the fingerprints.

## 5. The review log

The log is the heart of the standard. Rules:

1. Entries are in time order.
2. At least one entry is a human reading all of the draft (`read_all`).
3. Every excluded or blurred photo has an entry.
4. The last entry is a human approving the text for release (`approved_text_for_release`), and the signoff is by that same person, at or after that time.
5. A tool may appear in the log as a tool, never as the approver.
6. The final fingerprint describes the text as it was after the last human entry.

Keeping earlier drafts is a choice for the user and their counsel. The log records that review happened; it does not require every draft to be kept.

## 6. Evidence and anchoring

- Fingerprint each original photo and note with SHA-256 at capture. Keep the originals private.
- A shared copy of a photo should have location removed or rounded unless the people involved agreed otherwise.
- A public record, if one is wanted, carries only fingerprints and dates, never the files and never the text of a report.
- Anchoring a fingerprint on a public list or ledger is optional and only with the client's written agreement for that report, recorded in `anchoring.client_consent_ref`. The standard does not choose a ledger.
- A fingerprint proves that a file existed in that form by that date. It does not prove the file is true.

## 7. Privacy

- No personal data in a public record.
- Workers who appear in photos are told before the visit and can ask to be left out of a frame. The record notes exclusions.
- Retention and deletion follow the law and the user's counsel. This standard sets no period.

## 8. Conformance levels

| Level | Meaning | What the checker tests |
|---|---|---|
| L0 Documented | the required fields exist | structure (each note, photo, the final text, each review entry and the signoff carry the schema's required fields), limits statement, AI disclosure |
| L1 Fingerprinted | every file is fingerprinted | L0, plus fingerprints on every note, every photo and the final text; with `--files`, they match the files |
| L2 Reviewed | a human reviewed and signed | L1, plus a human read-all entry, a human approval as the last entry, a signoff by that same person and not earlier than it, every AI tool disclosed, a disposition for every photo, no verdict words in the summary, findings or notices |
| L3 Anchored | a fingerprint is on a public record | L2, plus anchoring with a client consent reference |

A report claims the level it reaches, no higher. A report that fails a check says so in the record or does not claim the level.

## 9. What a verifier can and cannot show

Can show: the record is complete; the files match their fingerprints; a human approved the text after the last edit; every AI tool was disclosed; no verdict language appears in the findings.

Cannot show: that the observer was present, that the photos are unaltered before capture, that the review was careful, that nothing was left out, or that the observations are correct.

## 10. Insurance, contracts and law

Some insurance policies may treat AI-assisted work differently, so whether AI-assisted reports are covered is a question for the carrier, in writing. This standard does not settle coverage. A review log is a record a user may want to show a carrier or a client. Contract language, scope limits and liability terms are for the user's counsel; this document supplies none.

## 11. Checking a record

```
node packages/hrsr-validate/hrsr-validate.mjs report.json --level L2
node packages/hrsr-validate/hrsr-validate.mjs report.json --level L2 --files ./folder
```

The checker has no dependencies. Exit code 0 means the level was reached, 1 means it was not, 2 means a usage error. A synthetic example lives in `examples/human-reviewed-ai-safety-report/`.

## 12. Open questions for v1

- A common format for the photo disposition and blur record.
- Whether the review log should carry a signature scheme, not only names and times.
- How a client's acknowledgement of receipt should be recorded.
- A shared list of verdict words in more than one language.

Comments and corrections are welcome as issues or pull requests on the repository that carries this file.
