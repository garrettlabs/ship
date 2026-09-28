import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { Task } from "./types.ts";

export type OutputRequirement = "executable-code" | "research-artifact" | "human-evaluation";

export interface ResearchEvidence {
  path: string;
  fingerprint: string;
  acceptanceFingerprint: string;
  /** The actual answer/conclusion, not merely a pointer to a file. */
  answer: string;
  findings: { criterion: string; finding: string; support: string }[];
}

/** Agent-produced evidence. Human acceptance is deliberately not a member of this type. */
export interface TaskEvidence {
  /** Binds command and review outcomes to the acceptance revision they verified. */
  acceptanceFingerprint?: string;
  commands?: { command: string; ok: boolean }[];
  reviews?: { kind: "security-review" | "independent-review"; ok: boolean }[];
  research?: ResearchEvidence;
}

/** Supply only from an approval action in the main session UI, never from an agent result. */
export interface MainSessionHumanApproval {
  source: "main-session-ui";
  sessionId: string;
  taskId: string;
  revision: number;
  acceptanceFingerprint: string;
  approved: boolean;
}

/** `revision` is the task's acceptance epoch, not the global roadmap revision. */
export function acceptanceFingerprint(task: Pick<Task, "id" | "objective" | "goal" | "acceptance" | "taskType" | "verificationRequirements" | "verificationCommands" | "verificationPlan" | "affectedFiles" | "affectedDomains">, revision: number): string {
  const scope = [revision, task.id, task.objective, task.goal, task.acceptance, task.taskType,
    task.verificationRequirements, task.verificationCommands, task.verificationPlan.requirements,
    task.affectedFiles, task.affectedDomains];
  return `sha256:${createHash("sha256").update(JSON.stringify(scope)).digest("hex")}`;
}

export function outputRequirements(task: Pick<Task, "taskType" | "acceptance" | "verificationRequirements">): OutputRequirement[] {
  const requirements: OutputRequirement[] = [];
  if (["research", "planning-design", "reconnaissance", "documentation"].includes(task.taskType)) requirements.push("research-artifact");
  else if (!["review", "security-review"].includes(task.taskType)) requirements.push("executable-code");
  if ([...task.acceptance, ...task.verificationRequirements].some(value => /\b(?:human evaluation|human acceptance|manual acceptance|user approval)\b/i.test(value))) requirements.push("human-evaluation");
  return requirements;
}

async function artifact(root: string, relativePath: string): Promise<{ fingerprint: string; content: string }> {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) throw new Error("Artifact must be within the workspace");
  const base = await realpath(root);
  const actual = await realpath(path.join(base, relativePath));
  if (actual === base || path.relative(base, actual).startsWith(`..${path.sep}`) || path.relative(base, actual) === ".." || path.isAbsolute(path.relative(base, actual))) {
    throw new Error("Artifact must be within the workspace");
  }
  const bytes = await readFile(actual);
  return { content: bytes.toString("utf8"), fingerprint: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

/** Fingerprint the actual file content; rejects paths outside the workspace (including escaping symlinks). */
export async function artifactFingerprint(root: string, relativePath: string): Promise<string> {
  return (await artifact(root, relativePath)).fingerprint;
}

export interface EvidenceInput {
  root: string;
  task: Task;
  revision: number;
  mainSessionId: string;
  evidence?: TaskEvidence;
  /** Must be populated independently by the main-session UI approval action. */
  humanApproval?: MainSessionHumanApproval;
}

export async function evaluateTaskEvidence({ root, task, revision, mainSessionId, evidence, humanApproval }: EvidenceInput): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];
  const outputs = outputRequirements(task);
  const acceptance = acceptanceFingerprint(task, revision);
  const checksCurrent = evidence?.acceptanceFingerprint === acceptance;
  const commands = checksCurrent ? evidence?.commands ?? [] : [];
  const reviews = checksCurrent ? evidence?.reviews ?? [] : [];
  const requiredCommands = task.verificationPlan.requirements.filter(requirement => requirement.command);
  if (outputs.includes("executable-code") && !requiredCommands.length) missing.push("Executable code requires a mandatory verification command");
  for (const requirement of task.verificationPlan.requirements) {
    if (requirement.command) {
      if (!commands.some(result => result.command === requirement.command && result.ok === true)) missing.push(`${requirement.kind}: ${requirement.reason}`);
    } else if (requirement.kind === "security-review" || requirement.kind === "independent-review") {
      if (!reviews.some(review => review.kind === requirement.kind && review.ok === true)) missing.push(`${requirement.kind}: ${requirement.reason}`);
    } else {
      missing.push(`${requirement.kind}: ${requirement.reason}`);
    }
  }
  if ((task.risk === "HIGH" || task.taskType === "security-review") && !reviews.some(review => review.kind === "security-review" && review.ok === true) &&
    !task.verificationPlan.requirements.some(requirement => requirement.kind === "security-review" && !requirement.command)) {
    missing.push("security-review: Security-sensitive work requires security review");
  }
  if (outputs.includes("research-artifact")) {
    const research = evidence?.research;
    if (!research || research.acceptanceFingerprint !== acceptance || !research.answer?.trim() ||
      !Array.isArray(research.findings) || !task.acceptance.every(criterion => research.findings.some(finding =>
        finding.criterion === criterion && finding.finding?.trim() && finding.support?.trim()))) {
      missing.push("Research/design answer must address each current acceptance criterion with a supported finding");
    } else {
      try {
        const current = await artifact(root, research.path);
        if (current.fingerprint !== research.fingerprint || !current.content.trim() || !current.content.includes(research.answer.trim()) ||
          !research.findings.every(finding => current.content.includes(finding.finding.trim()))) {
          missing.push("Research/design artifact content or fingerprint does not match the submitted answer");
        }
      } catch {
        missing.push("Research/design artifact is missing or outside the workspace");
      }
    }
  }
  if (outputs.includes("human-evaluation") && !(humanApproval?.source === "main-session-ui" && humanApproval.approved === true &&
    humanApproval.sessionId === mainSessionId && humanApproval.taskId === task.id && humanApproval.revision === revision &&
    humanApproval.acceptanceFingerprint === acceptance)) {
    missing.push("Current acceptance requires main-session UI-approved human evaluation");
  }
  return { ok: missing.length === 0, missing };
}
