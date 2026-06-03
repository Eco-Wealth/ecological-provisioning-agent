import type { ProvisioningIntent, StewardshipRoute, WorkPacket } from "./types.js";
import { makeId, unique } from "./utils.js";

export function buildPacket(intent: ProvisioningIntent, route: StewardshipRoute): WorkPacket {
  const title = `First ${route.primary_category} packet for ${intent.place}`;
  return {
    id: makeId("packet", `${intent.id}-${route.id}`),
    intent_id: intent.id,
    route_id: route.id,
    title,
    context: intent.summary,
    task: `Perform a bounded first-pass ${route.primary_category} action that improves the site condition without exceeding human review boundaries.`,
    location_assumptions: [intent.place, "Exact boundaries must be confirmed before field work."],
    materials: materialsFor(route.primary_category),
    tools: toolsFor(route.primary_category),
    skills_needed: skillsFor(route.primary_category),
    difficulty: intent.risk_level === "high" ? "high" : "medium",
    safety_notes: unique([
      "Stop if unknown hazards are found.",
      "Confirm permission before entering or altering any site.",
      "Use appropriate protective equipment.",
      ...intent.unknowns.map((unknown) => `Unknown: ${unknown}`)
    ]),
    proof_required: unique([...intent.proof_needed, "acceptance criteria notes"]),
    acceptance_criteria: [
      "Before state is documented.",
      "Work performed is described plainly.",
      "After state is documented.",
      "Remaining risks and unknowns are listed.",
      "No certification or verified outcome is claimed without evidence."
    ],
    next_action: "Create a proof checklist and assign a human reviewer before any real-world action."
  };
}

function materialsFor(category: string): string[] {
  const map: Record<string, string[]> = {
    cleanup: ["contractor bags", "gloves", "sorting containers"],
    water: ["marking flags", "notebook", "temporary erosion-control materials if approved"],
    planting: ["approved plant list", "mulch", "water source plan"],
    repair: ["replacement parts pending inspection"],
    documentation: ["camera", "notebook", "site map"]
  };
  return map[category] ?? ["to be confirmed after site observation"];
}

function toolsFor(category: string): string[] {
  const map: Record<string, string[]> = {
    cleanup: ["grabber", "broom", "dustpan"],
    water: ["level", "measuring tape", "camera"],
    planting: ["hand tools", "watering can"],
    repair: ["basic hand tools after inspection"],
    documentation: ["camera", "measuring tape"]
  };
  return map[category] ?? ["basic field documentation kit"];
}

function skillsFor(category: string): string[] {
  const map: Record<string, string[]> = {
    cleanup: ["site cleanup", "basic hazard recognition"],
    water: ["drainage observation", "erosion awareness"],
    planting: ["planting", "mulching", "maintenance planning"],
    repair: ["repair assessment", "tool safety"],
    documentation: ["field documentation", "photo evidence"],
    safety: ["hazard recognition", "stop-work judgment"]
  };
  return map[category] ?? ["field observation", "documentation"];
}
