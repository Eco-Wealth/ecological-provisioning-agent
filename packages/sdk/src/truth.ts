import type { TruthBoundaryResult } from "./types.js";

const blockedPatterns = [
  "certified",
  "certification",
  "compliant",
  "compliance",
  "approved by",
  "endorsed by",
  "verified ecological outcome",
  "guaranteed",
  "dispatch confirmed",
  "payment sent",
  "transaction signed",
  "deployed to production",
  "posted publicly"
];

const cautionPatterns = [
  "safe",
  "verified",
  "complete",
  "meets standard",
  "official",
  "inspection passed",
  "hire",
  "pay",
  "dispatch",
  "deploy",
  "post"
];

export function validateTruthBoundary(object: unknown): TruthBoundaryResult {
  const text = JSON.stringify(object, null, 2).toLowerCase();
  const blocked_terms = blockedPatterns.filter((term) => text.includes(term));
  const cautions = cautionPatterns.filter((term) => text.includes(term));
  const warnings = [
    ...blocked_terms.map((term) => `Blocked claim or action language detected: ${term}`),
    ...cautions.map((term) => `Review language for overclaim or live-action implication: ${term}`)
  ];

  return {
    ok: blocked_terms.length === 0,
    warnings,
    blocked_terms
  };
}
