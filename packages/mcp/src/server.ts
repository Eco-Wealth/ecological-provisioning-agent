import { stdin, stdout } from "node:process";
import {
  applyPrincipleLens,
  buildPacket,
  composeIntent,
  routeStewardship,
  validateTruthBoundary,
  writeReceipt
} from "@ecological-provisioning/sdk";
import { tools } from "./tools.js";

// Minimal JSON-line local tool server stub. This is intentionally not a full MCP transport yet.
// It gives downstream builders a deterministic local contract without adding live powers.

type Request = { id?: string | number; tool?: string; arguments?: any };

stdin.setEncoding("utf8");
let buffer = "";
stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(line);
  }
});

function handle(line: string): void {
  try {
    const req = JSON.parse(line) as Request;
    if (req.tool === "list_tools") return respond(req.id, { tools });
    const args = req.arguments ?? {};
    switch (req.tool) {
      case "compose_intent": return respond(req.id, composeIntent(args));
      case "apply_principle_lens": return respond(req.id, applyPrincipleLens(args.object, args.lenses));
      case "route_stewardship": return respond(req.id, routeStewardship(args.intent));
      case "build_work_packet": return respond(req.id, buildPacket(args.intent, args.route));
      case "write_receipt": return respond(req.id, writeReceipt(args.packet, args.proofs ?? []));
      case "validate_truth_boundary": return respond(req.id, validateTruthBoundary(args.object));
      default: return respond(req.id, { error: `Unknown tool: ${req.tool}` });
    }
  } catch (error) {
    respond(undefined, { error: error instanceof Error ? error.message : String(error) });
  }
}

function respond(id: Request["id"], result: unknown): void {
  stdout.write(JSON.stringify({ id, result }) + "\n");
}
