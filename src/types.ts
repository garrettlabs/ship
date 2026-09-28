export type TaskStatus = "pending" | "running" | "verifying" | "passed" | "failed" | "blocked";
export type RunPhase = "idle" | "planning" | "executing" | "verifying" | "reviewing" | "blocked" | "complete";
export type TaskType = "reconnaissance" | "planning-design" | "implementation" | "bugfix" | "refactor" | "test" | "documentation" | "migration" | "integration" | "review" | "research" | "configuration" | "security-review";
export type TaskComplexity = "TRIVIAL" | "STANDARD" | "COMPLEX";
export type TaskRisk = "LOW" | "HIGH" | "UNKNOWN";
export type TaskUncertainty = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type ExecutionRole = "main" | "smol" | "task" | "plan" | "slow";
export type SpecialistIntent = "scout" | "reviewer" | "security-reviewer";
export interface TaskExecution {
  mode: "main" | "delegate";
  role: ExecutionRole;
  reason: string;
  specialist?: SpecialistIntent;
  verificationSpecialist?: "security-reviewer";
}
export interface TaskProfile {
  complexity: number; uncertainty: number; risk: number; traits: string[];
  rationale: string[]; source?: "planner" | "derived";
}
export interface RoutingDecision {
  backend: "deterministic" | "omp-jev";
  role: ExecutionRole;
  fallbackUsed: boolean;
  reason?: "disabled" | "unavailable" | "unconfigured" | "timeout" | "error" | "malformed" | "low-confidence" | "ineligible";
  confidence?: number;
  probabilities?: Record<string, number>;
}
export interface SemanticJudgment {
  backend: "omp-jev";
  taskType?: { value: TaskType; confidence: number };
  complexity?: { value: number; confidence: number };
  uncertainty?: { value: TaskUncertainty; confidence: number };
  risk?: { value: TaskRisk; confidence: number };
  fallbacks?: Partial<Record<"taskType" | "complexity" | "uncertainty" | "risk", "low-confidence" | "malformed" | "ineligible">>;
}
export interface PendingJudgment {
  id: string; sessionId: string; revision: number; key: string; requestedAt: number;
  eligible: ExecutionRole[]; requestHash: string;
}
export type VerificationKind = "focused-tests" | "broader-tests" | "typecheck" | "lint" | "build" | "integration" | "independent-review" | "security-review";
export interface RepoCheck { kind: Exclude<VerificationKind, "independent-review" | "security-review">; command: string; source: string; }
export interface VerificationRequirement { kind: VerificationKind; reason: string; command?: string; }
export interface VerificationPlan { requirements: VerificationRequirement[]; }
export interface Task {
  dependencyLevel: number;
  id: string; title: string; objective: string; goal: string; dependencies: string[];
  acceptance: string[]; affectedDomains: string[]; affectedFiles: string[];
  taskType: TaskType; complexity: TaskComplexity; risk: TaskRisk; uncertainty: TaskUncertainty;
  profile: TaskProfile; routingDecision: RoutingDecision; semanticJudgment?: SemanticJudgment; effectiveTaskType?: TaskType; effectiveUncertainty?: TaskUncertainty;
  classificationSignals: string[]; classificationRationale: string[];
  parallelEligible: boolean; executionRoute: "direct" | "investigate" | "decompose";
  execution: TaskExecution;
  verificationRequirements: string[]; verificationCommands: string[]; verificationPlan: VerificationPlan;
  status: TaskStatus; attempts: number; lastError?: string;
}
export interface Slice { id: string; title: string; status: "pending" | "active" | "complete"; tasks: Task[]; }
export interface Milestone {
  id: string; title: string; outcome: string; status: "pending" | "active" | "complete"; slices: Slice[];
}
export interface Knowledge {
  id: string; kind: "capture" | "observation" | "decision" | "assumption" | "lesson";
  text: string; source: "user" | "agent"; evidence: string; at: string;
}
export interface Attempt {
  id: string; key: string; baseHead: string; stage: "executing" | "verifying" | "committing";
  commands: string[]; revision: number; summary?: string; tree?: string;
}
export interface PlanningHints {
  taskType?: TaskType; uncertainty?: TaskUncertainty; dependencies?: string[];
  profile?: TaskProfile;
  affectedFiles?: string[]; affectedDomains?: string[]; verificationRequirements?: string[];
}
export type RoadmapEdit =
  | ({ type: "add"; slice: string; title: string; goal: string; acceptance: string; check: string; revision: number } & PlanningHints)
  | ({ type: "change"; task: string; goal: string; revision: number } & PlanningHints);
export type InboxMessage =
  | { id: string; type: "pause" | "resume"; at: string }
  | { id: string; type: "capture"; note: string; at: string }
  | (RoadmapEdit & { id: string; at: string });
export interface NativeAssignment {
  id: string; key: string; status: "pending" | "passed" | "failed" | "partial"; summary?: string; routed?: boolean; specialistDispatched?: boolean; reviewVerdict?: "correct" | "incorrect" | "unknown"; verifiedCommands?: string[];
}
export interface NativeBatch {
  id: string; sessionId: string; revision: number; stage: "executing" | "reviewing"; assignments: NativeAssignment[]; settling?: boolean; awaitingBudget?: boolean;
}
export interface NativePlanning { id: string; sessionId: string; attempts: number; }
export interface DiscoveryState {
  id: string;
  sessionId: string;
  status: "researching" | "cancelled" | "approved";
  goalSet?: boolean;
}
export interface ShipState {
  schemaVersion: 1; projectName: string; phase: RunPhase; roadmapRevision: number;
  milestones: Milestone[]; current?: { milestoneId: string; sliceId: string; taskId?: string };
  repoChecks?: RepoCheck[];
  /** Git state observed before SHIP first planned work; never treats these paths as SHIP-owned. */
  preexistingWork?: { branch: string | null; paths: string[]; truncated?: boolean; unknown?: boolean };
  /** Content fingerprints of dirty SHIP-owned files at the last settled task boundary. */
  ownedSnapshots?: Record<string, string>;
  paused: boolean; blockedReason?: string; lastProgressAt: string; createdAt: string; updatedAt: string;
  workspace?: { path: string; branch: string; baseHead: string };
  lastHead?: string; partialTree?: string; activeAttempt?: Attempt; dispatches?: number; planningFailures?: number;
  nativeBatch?: NativeBatch;
  nativePlanning?: NativePlanning;
  discovery?: DiscoveryState;
  pendingJudgment?: PendingJudgment;
  knowledge?: Knowledge[]; processedInbox?: string[];
}
export interface ShipConfig {
  schemaVersion: 1;
  limits: { maxTaskAttempts: number; maxDispatches: number };
  verificationTimeoutMs?: number; protectedChecks?: string[];
  judgment?: { enabled: boolean; confidenceThreshold?: number; timeoutMs?: number };
}
