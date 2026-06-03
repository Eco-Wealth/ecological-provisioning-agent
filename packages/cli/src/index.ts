#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  applyPrincipleLens,
  buildPacket,
  composeIntent,
  routeStewardship,
  validateTruthBoundary,
  writeReceipt,
  type ProofRecord,
  type ProvisioningIntent,
  type StewardshipRoute,
  type WorkPacket
} from "@ecological-provisioning/sdk";

const [command, file] = process.argv.slice(2);

function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

try {
  switch (command) {
    case "compose": {
      const input = readJson<{ text: string; place?: string; stakeholders?: string[]; constraints?: string[] }>(required(file));
      print(composeIntent(input));
      break;
    }
    case "lens": {
      const input = readJson<ProvisioningIntent | WorkPacket>(required(file));
      print(applyPrincipleLens(input));
      break;
    }
    case "route": {
      const intent = readJson<ProvisioningIntent>(required(file));
      print(routeStewardship(intent));
      break;
    }
    case "packet": {
      const bundle = readJson<{ intent: ProvisioningIntent; route: StewardshipRoute } | StewardshipRoute>(required(file));
      if ("intent" in bundle && "route" in bundle) {
        print(buildPacket(bundle.intent, bundle.route));
      } else {
        throw new Error("packet command expects a JSON object with intent and route");
      }
      break;
    }
    case "receipt": {
      const bundle = readJson<{ packet: WorkPacket; proofs?: ProofRecord[] }>(required(file));
      print(writeReceipt(bundle.packet, bundle.proofs ?? []));
      break;
    }
    case "validate": {
      const input = readJson(required(file));
      print(validateTruthBoundary(input));
      break;
    }
    case "demo": {
      const intent = composeIntent({
        text: "Owner has a degraded lot and wants it safer, more beautiful, more water-aware, and easier to maintain.",
        place: "example degraded lot",
        stakeholders: ["owner", "neighbor", "laborer"]
      });
      const lenses = applyPrincipleLens(intent);
      const route = routeStewardship(intent);
      const packet = buildPacket(intent, route);
      const receipt = writeReceipt(packet, []);
      print({ intent, lenses, route, packet, receipt });
      break;
    }
    default:
      console.error(`Usage:
  provision compose <input.json>
  provision lens <intent-or-packet.json>
  provision route <intent.json>
  provision packet <bundle.json>
  provision receipt <bundle.json>
  provision validate <object.json>
  provision demo`);
      process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function required(value: string | undefined): string {
  if (!value) throw new Error("Missing file path");
  return value;
}
