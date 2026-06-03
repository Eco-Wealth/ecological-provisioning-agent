import type { MessyIntentInput, ProvisioningIntent } from "./types.js";
import { includesAny, makeId, unique } from "./utils.js";

const workTerms = [
  "cleanup",
  "repair",
  "safety",
  "water",
  "soil",
  "planting",
  "habitat",
  "access",
  "beauty",
  "documentation",
  "monitoring"
];

export function composeIntent(input: string | MessyIntentInput): ProvisioningIntent {
  const text = typeof input === "string" ? input : input.text;
  const place = typeof input === "string" ? "unknown place" : input.place ?? "unknown place";
  const stakeholders = typeof input === "string" ? ["owner or steward", "laborer"] : input.stakeholders ?? ["owner or steward", "laborer"];
  const constraints = typeof input === "string" ? [] : input.constraints ?? [];

  const candidate_work = workTerms.filter((term) => includesAny(text, [term]));
  if (candidate_work.length === 0) candidate_work.push("site observation", "safety cleanup", "proof documentation");

  const proof_needed = [
    "before photos or notes",
    "specific location notes",
    "after photos or notes",
    "remaining risks and unknowns"
  ];

  const risk_level = includesAny(text, ["hazard", "sharp", "chemical", "electrical", "traffic", "unsafe", "mold", "asbestos"])
    ? "high"
    : includesAny(text, ["degraded", "erosion", "runoff", "trash", "overgrown", "broken"])
      ? "medium"
      : "unknown";

  return {
    id: makeId("intent", text),
    summary: summarize(text),
    place,
    problem: inferProblem(text),
    desired_outcome: inferOutcome(text),
    stakeholders: unique(stakeholders),
    constraints: unique([...(constraints ?? []), "no live dispatch", "human review required before field action"]),
    unknowns: ["exact site conditions", "permissions", "materials available", "hazards not visible from intent"],
    candidate_work: unique(candidate_work),
    proof_needed,
    risk_level
  };
}

function summarize(text: string): string {
  return text.length <= 180 ? text : `${text.slice(0, 177)}...`;
}

function inferProblem(text: string): string {
  if (includesAny(text, ["degraded", "trash", "unsafe", "broken", "overgrown"])) return "The place appears to need safety, cleanup, repair, or stewardship attention.";
  if (includesAny(text, ["water", "runoff", "erosion", "drainage"])) return "The place appears to need water-aware assessment and intervention.";
  return "The intent needs field observation before the problem can be stated with confidence.";
}

function inferOutcome(text: string): string {
  if (includesAny(text, ["beautiful", "beauty", "welcoming"])) return "Make the place safer, more coherent, easier to care for, and more beautiful.";
  if (includesAny(text, ["water", "runoff", "erosion"])) return "Reduce water-related harm and create a more resilient site condition.";
  return "Create a bounded first packet that improves conditions and produces useful proof.";
}
