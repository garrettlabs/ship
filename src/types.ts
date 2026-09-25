export type TaskStatus = "pending" | "running" | "verifying" | "passed" | "failed" | "blocked";
export type RunPhase = "idle" | "planning" | "executing" | "verifying" | "reviewing" | "waiting" | "blocked" | "complete";
export interface Task {
  id: string; title: string; goal: string; acceptance: string[];
  verificationCommands: string[]; dependsOn?: string[]; requestedBy?: WorkOrigin; status: TaskStatus; attempts: number; lastError?: string;
}
export interface Slice { id: string; title: string; status: "pending" | "active" | "complete"; tasks: Task[]; requestedBy?: WorkOrigin; }
export interface Milestone {
  id: string; title: string; outcome: string; status: "pending" | "active" | "complete"; slices: Slice[]; requestedBy?: WorkOrigin;
}
export interface Knowledge {
  id: string; kind: "capture" | "observation" | "decision" | "assumption" | "lesson";
  text: string; source: "user" | "agent"; evidence: string; at: string;
}
export interface Attempt {
  id: string; key: string; baseHead: string; stage: "executing" | "verifying" | "committing";
  commands: string[]; revision: number; summary?: string; tree?: string;
}
export interface ShipState {
  schemaVersion: 1; projectName: string; phase: RunPhase; roadmapRevision: number;
  milestones: Milestone[]; current?: { milestoneId: string; sliceId: string; taskId?: string };
  paused: boolean; blockedReason?: string; lastProgressAt: string; createdAt: string; updatedAt: string;
  workspace?: { path: string; branch: string; baseHead: string };
  lastHead?: string; partialTree?: string; activeAttempt?: Attempt; dispatches?: number; planningFailures?: number;
  reviewedSlices?: string[]; reviewAttempts?: Record<string, number>;
  knowledge?: Knowledge[]; processedInbox?: string[]; workRequests?: WorkRequest[];
}
export interface ShipConfig {
  schemaVersion: 1;
  worker: { command: string; args: string[]; startupTimeoutMs: number; inactivityTimeoutMs: number; hardTimeoutMs: number };
  limits: { maxTaskAttempts: number; maxDispatches: number };
  verificationTimeoutMs?: number; protectedChecks?: string[]; review?: boolean;
}
export interface WorkerResult { ok: boolean; text: string; error?: string; retryable?: boolean; }
export interface WorkerOptions { controlRoot?: string; signal?: AbortSignal; logFile?: string; }
export interface Worker { run(prompt: string, cwd: string, options?: WorkerOptions): Promise<WorkerResult>; }
export interface Review {
  revision: number; rationale: string;
  lessons: { kind: "observation" | "decision" | "assumption" | "lesson"; text: string; evidence: string }[];
  changes: { task: string; goal: string; reason: string }[];
}

// New work remains a request until an exact planner proposal is approved.
export interface WorkOrigin { source: "user"; requestId: string; proposalId: string; }
export interface NewTask {
  id: string; title: string; goal: string; acceptance: string[];
  verificationCommands: string[]; dependsOn?: string[];
}
export interface NewSlice { id: string; title: string; tasks: NewTask[]; }
export interface NewMilestone { id: string; title: string; outcome: string; slices: NewSlice[]; }
export type Addition =
  | { type: "ADD_TASK"; parent: string; after: string | null; task: NewTask }
  | { type: "ADD_SLICE"; parent: string; after: string | null; slice: NewSlice }
  | { type: "ADD_MILESTONE"; after: string | null; milestone: NewMilestone };
export interface AdditionProposal {
  revision: number; requestId: string; rationale: string; patch: Addition;
}
export interface WorkProposal extends AdditionProposal { id: string; }
export interface WorkRequest {
  id: string; text: string; source: "user"; inboxId: string; createdAt: string;
  status: "queued" | "planning" | "proposed" | "applied" | "rejected" | "conflict" | "failed" | "stale";
  attempts: number; proposal?: WorkProposal; error?: string; resolvedAt?: string;
  appliedRevision?: number;
}
export type InboxMessage = {
  id: string; type: "pause" | "resume" | "capture" | "add" | "approve" | "reject";
  note?: string; requestId?: string; proposalId?: string; at: string;
};
