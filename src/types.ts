export type TaskStatus = "pending" | "running" | "verifying" | "passed" | "failed" | "blocked";
export type RunPhase = "idle" | "planning" | "executing" | "verifying" | "blocked" | "complete";

export interface Task {
  id: string;
  title: string;
  goal: string;
  acceptance: string[];
  verificationCommands: string[];
  status: TaskStatus;
  attempts: number;
  lastError?: string;
}

export interface Slice {
  id: string;
  title: string;
  status: "pending" | "active" | "complete";
  tasks: Task[];
}

export interface Milestone {
  id: string;
  title: string;
  outcome: string;
  status: "pending" | "active" | "complete";
  slices: Slice[];
}

export interface ShipState {
  schemaVersion: 1;
  projectName: string;
  phase: RunPhase;
  roadmapRevision: number;
  milestones: Milestone[];
  current?: { milestoneId: string; sliceId: string; taskId?: string };
  paused: boolean;
  blockedReason?: string;
  lastProgressAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShipConfig {
  schemaVersion: 1;
  worker: {
    command: string;
    args: string[];
    startupTimeoutMs: number;
    inactivityTimeoutMs: number;
    hardTimeoutMs: number;
  };
  limits: {
    maxTaskAttempts: number;
    maxDispatches: number;
  };
}

export interface WorkerResult {
  ok: boolean;
  text: string;
  error?: string;
  retryable?: boolean;
}

export interface Worker {
  run(prompt: string, cwd: string): Promise<WorkerResult>;
}
