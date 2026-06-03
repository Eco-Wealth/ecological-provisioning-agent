export type RiskLevel = "low" | "medium" | "high" | "unknown";
export type Alignment = "strong" | "partial" | "weak" | "unknown";
export type Difficulty = "low" | "medium" | "high" | "unknown";

export interface MessyIntentInput {
  text: string;
  place?: string;
  stakeholders?: string[];
  constraints?: string[];
}

export interface ProvisioningIntent {
  id: string;
  summary: string;
  place: string;
  problem: string;
  desired_outcome: string;
  stakeholders: string[];
  constraints: string[];
  unknowns: string[];
  candidate_work: string[];
  proof_needed: string[];
  risk_level: RiskLevel;
}

export interface PrincipleLensResult {
  lens: string;
  alignment: Alignment;
  reason: string;
  evidence_needed: string[];
}

export interface StewardshipRoute {
  id: string;
  intent_id: string;
  primary_category: string;
  secondary_categories: string[];
  rationale: string;
  next_action: string;
}

export interface WorkPacket {
  id: string;
  intent_id: string;
  route_id: string;
  title: string;
  context: string;
  task: string;
  location_assumptions: string[];
  materials: string[];
  tools: string[];
  skills_needed: string[];
  difficulty: Difficulty;
  safety_notes: string[];
  proof_required: string[];
  acceptance_criteria: string[];
  next_action: string;
}

export interface ProofRecord {
  id: string;
  packet_id: string;
  before_state: string;
  during_work?: string;
  after_state: string;
  measurements: string[];
  evidence: string[];
  observer_notes: string[];
  risks: string[];
  remaining_unknowns: string[];
}

export interface Receipt {
  id: string;
  packet_id: string;
  intended: string;
  done: string;
  changed: string;
  evidence: string[];
  unknowns: string[];
  next_action: string;
  truth_warnings: string[];
}

export interface TruthBoundaryResult {
  ok: boolean;
  warnings: string[];
  blocked_terms: string[];
}
