export type TaskStatus = "pending" | "running" | "verifying" | "passed" | "failed" | "blocked";
export type RunPhase = "idle" | "planning" | "executing" | "verifying" | "reviewing" | "blocked" | "complete";
export interface Task {
  id: string; title: string; goal: string; acceptance: string[];
  verificationCommands: string[]; status: TaskStatus; attempts: number; lastError?: string;
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
export interface ShipState {
  schemaVersion: 1; projectName: string; phase: RunPhase; roadmapRevision: number;
  milestones: Milestone[]; current?: { milestoneId: string; sliceId: string; taskId?: string };
  paused: boolean; blockedReason?: string; lastProgressAt: string; createdAt: string; updatedAt: string;
  workspace?: { path: string; branch: string; baseHead: string };
  lastHead?: string; partialTree?: string; activeAttempt?: Attempt; dispatches?: number; planningFailures?: number;
  reviewedSlices?: string[]; reviewAttempts?: Record<string, number>;
  knowledge?: Knowledge[]; processedInbox?: string[];
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
