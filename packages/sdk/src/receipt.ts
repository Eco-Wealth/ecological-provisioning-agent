import type { ProofRecord, Receipt, WorkPacket } from "./types.js";
import { makeId, unique } from "./utils.js";
import { validateTruthBoundary } from "./truth.js";

export function writeReceipt(packet: WorkPacket, proofs: ProofRecord[] = []): Receipt {
  const evidence = unique(proofs.flatMap((proof) => proof.evidence));
  const unknowns = unique(proofs.flatMap((proof) => proof.remaining_unknowns));
  const done = proofs.length
    ? proofs.map((proof) => proof.after_state).join("; ")
    : "No field work is recorded yet. This receipt remains a draft.";

  const receipt: Receipt = {
    id: makeId("receipt", packet.id),
    packet_id: packet.id,
    intended: packet.task,
    done,
    changed: proofs.length ? "Change is described in proof records and requires human review." : "No change claimed.",
    evidence,
    unknowns: unknowns.length ? unknowns : ["No proof record supplied."],
    next_action: proofs.length ? packet.next_action : "Collect proof before claiming completion.",
    truth_warnings: []
  };

  receipt.truth_warnings = validateTruthBoundary(receipt).warnings;
  return receipt;
}
