import type { ProvisioningIntent, StewardshipRoute } from "./types.js";
import { includesAny, makeId } from "./utils.js";

const categories = [
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
  "monitoring",
  "community coordination",
  "owner decision",
  "labor packet"
];

export function routeStewardship(intent: ProvisioningIntent): StewardshipRoute {
  const text = JSON.stringify(intent).toLowerCase();
  const matched = categories.filter((category) => includesAny(text, [category, ...category.split(" ")]));
  const primary = matched[0] ?? "documentation";
  const secondary = matched.filter((item) => item !== primary).slice(0, 4);

  return {
    id: makeId("route", `${intent.id}-${primary}`),
    intent_id: intent.id,
    primary_category: primary,
    secondary_categories: secondary.length ? secondary : ["proof", "owner decision"],
    rationale: `Route selected because the intent signals ${primary} work and requires bounded proof before broader action.`,
    next_action: "Build a small work packet with safety notes and proof requirements."
  };
}
