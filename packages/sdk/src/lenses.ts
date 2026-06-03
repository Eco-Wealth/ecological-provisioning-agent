import type { PrincipleLensResult, ProvisioningIntent, WorkPacket } from "./types.js";

export const DEFAULT_LENSES = [
  "place",
  "water",
  "energy",
  "materials",
  "health",
  "equity",
  "beauty",
  "maintenance",
  "proof",
  "public benefit"
];

export function applyPrincipleLens(
  intentOrPacket: ProvisioningIntent | WorkPacket,
  lenses: string[] = DEFAULT_LENSES
): PrincipleLensResult[] {
  const text = JSON.stringify(intentOrPacket).toLowerCase();
  return lenses.map((lens) => evaluateLens(lens, text));
}

function evaluateLens(lens: string, text: string): PrincipleLensResult {
  const l = lens.toLowerCase();
  const hit = text.includes(l) || relatedTerms(l).some((term) => text.includes(term));
  return {
    lens,
    alignment: hit ? "partial" : "unknown",
    reason: hit
      ? `Appears aligned with the principle of ${lens} because the intent or packet includes related work signals.`
      : `Alignment with the principle of ${lens} is unknown from the current information.`,
    evidence_needed: evidenceFor(l)
  };
}

function relatedTerms(lens: string): string[] {
  const map: Record<string, string[]> = {
    place: ["site", "location", "context"],
    water: ["runoff", "drainage", "erosion"],
    energy: ["shade", "passive", "heat"],
    materials: ["tools", "materials", "reuse"],
    health: ["safety", "hazard", "risk"],
    equity: ["access", "dignity", "stakeholder"],
    beauty: ["beautiful", "welcoming", "care"],
    maintenance: ["maintain", "repair", "durable"],
    proof: ["evidence", "photo", "receipt"],
    "public benefit": ["community", "neighbor", "shared"]
  };
  return map[lens] ?? [];
}

function evidenceFor(lens: string): string[] {
  const base = ["before state", "after state", "observer notes"];
  const map: Record<string, string[]> = {
    water: ["runoff path notes", "drainage observations", "erosion photos"],
    health: ["hazard notes", "safety controls used"],
    equity: ["access notes", "stakeholder impact notes"],
    beauty: ["visual coherence notes", "before/after photos"],
    materials: ["materials list", "reuse or disposal notes"],
    proof: ["timestamped evidence", "acceptance criteria result"]
  };
  return [...base, ...(map[lens] ?? [])];
}
