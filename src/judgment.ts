import { createHash } from "node:crypto";
import type { ExecutionRole, RoutingDecision, SemanticJudgment, Task, TaskExecution, TaskProfile, TaskRisk, TaskType, TaskUncertainty } from "./types.ts";
import { routeTask } from "./role-router.ts";

export const confidenceThreshold = 0.7;
export const judgmentTimeoutMs = 20_000;
export function hashJudgmentRequest(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) :
    input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : input;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export const semanticTaskTypes: TaskType[] = ["reconnaissance", "planning-design", "implementation", "bugfix", "refactor", "test", "documentation", "migration", "integration", "review", "research", "configuration", "security-review"];
const semanticUncertainties: TaskUncertainty[] = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"];
const semanticRisks: TaskRisk[] = ["LOW", "HIGH", "UNKNOWN"];
const semanticKeys = ["taskType", "complexity", "uncertainty", "risk"] as const;
const fixedTypes: readonly TaskType[] = ["planning-design", "migration", "integration", "review", "security-review"];
const noCodeTypes: readonly TaskType[] = ["documentation", "reconnaissance", "planning-design", "research", "review", "security-review"];
export function safeSemanticType(original: TaskType, proposed: TaskType): TaskType {
  if (fixedTypes.includes(original) || (!noCodeTypes.includes(original) && noCodeTypes.includes(proposed))) return original;
  return proposed;
}
export function validateSemanticJudgment(value: unknown): value is SemanticJudgment {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("backend" in value) || value.backend !== "omp-jev") return false;
  for (const key of semanticKeys) {
    const field: unknown = Reflect.get(value, key);
    if (field === undefined) continue;
    if (!field || typeof field !== "object" || !("value" in field) || !("confidence" in field) ||
        typeof field.confidence !== "number" || !Number.isFinite(field.confidence) || field.confidence < 0 || field.confidence > 1) return false;
    const result = field.value;
    if (key === "taskType" && !semanticTaskTypes.includes(result as TaskType)) return false;
    if (key === "complexity" && (!Number.isSafeInteger(result) || (result as number) < 1 || (result as number) > 10)) return false;
    if (key === "uncertainty" && !semanticUncertainties.includes(result as TaskUncertainty)) return false;
    if (key === "risk" && !semanticRisks.includes(result as TaskRisk)) return false;
  }
  if ("fallbacks" in value && value.fallbacks !== undefined) {
    if (!value.fallbacks || typeof value.fallbacks !== "object" || Array.isArray(value.fallbacks)) return false;
    if (Object.entries(value.fallbacks).some(([key, reason]) => !semanticKeys.includes(key as typeof semanticKeys[number]) ||
        !["low-confidence", "malformed", "ineligible"].includes(reason as string))) return false;
  }
  return true;
}

export function parseSemanticAnswers(response: unknown, id: string, threshold: number, originalType: TaskType): SemanticJudgment {
  const answers = response && typeof response === "object" && "answers" in response && response.answers &&
    typeof response.answers === "object" && !Array.isArray(response.answers) ? response.answers : undefined;
  const result: SemanticJudgment = { backend: "omp-jev" };
  for (const key of semanticKeys) {
    const raw: unknown = answers && Object.hasOwn(answers, `${id}.${key}`) ? Reflect.get(answers, `${id}.${key}`) : undefined;
    const options = key === "taskType" ? semanticTaskTypes : key === "complexity" ? Array.from({ length: 10 }, (_, i) => `${i + 1}`) :
      key === "uncertainty" ? semanticUncertainties : semanticRisks;
    const parsed = raw && typeof raw === "object" && "type" in raw && raw.type === "choice" ?
      parseBoundedChoice(raw, options, threshold) : "malformed";
    if (typeof parsed === "string") { (result.fallbacks ??= {})[key] = parsed; continue; }
    if (key === "taskType" && safeSemanticType(originalType, parsed.choice as TaskType) !== parsed.choice) {
      (result.fallbacks ??= {})[key] = "ineligible"; continue;
    }
    const value = parsed.choice;
    const confidence = parsed.confidence;
    if (key === "taskType") result.taskType = { value: value as TaskType, confidence };
    else if (key === "complexity") result.complexity = { value: Number(value), confidence };
    else if (key === "uncertainty") result.uncertainty = { value: value as TaskUncertainty, confidence };
    else result.risk = { value: value as TaskRisk, confidence };
  }
  return result;
}

export function validateProfile(value: unknown): value is TaskProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return [p.complexity, p.uncertainty, p.risk].every(n => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 10) &&
    Array.isArray(p.traits) && p.traits.every(t => typeof t === "string" && !!t.trim() && t.length <= 80) && p.traits.length <= 20 &&
    Array.isArray(p.rationale) && p.rationale.every(t => typeof t === "string" && !!t.trim() && t.length <= 300) && p.rationale.length <= 12 &&
    (p.source === undefined || p.source === "planner" || p.source === "derived");
}

export function derivedProfile(task: Task, rationale: string[], signals: string[]): TaskProfile {
  return { complexity: task.complexity === "COMPLEX" ? 8 : task.complexity === "TRIVIAL" ? 2 : 5,
    uncertainty: task.uncertainty === "HIGH" || task.uncertainty === "UNKNOWN" ? 8 : task.uncertainty === "MEDIUM" ? 5 : 2,
    risk: task.risk === "HIGH" || task.risk === "UNKNOWN" ? 8 : 2, traits: [...signals], rationale: [...rationale, "Derived from SHIP structural classification; planner score unavailable"], source: "derived" };
}

// Minimum role capability is a SHIP policy, not Jev's cost judgment. Never offer
// specialist, main-session, or planning-only roles for implementation work.
export function eligibleRoles(task: Task, available: readonly ExecutionRole[]): ExecutionRole[] {
  const base = routeTask({ ...task, taskType: task.effectiveTaskType ?? task.taskType, uncertainty: task.effectiveUncertainty ?? task.uncertainty });
  if (base.mode === "main" || base.specialist || base.role === "plan") return [];
  const minimum = task.risk !== "LOW" || task.taskType === "migration" || task.taskType === "integration" ||
    task.complexity === "COMPLEX" || task.profile.risk >= 7 || task.profile.complexity >= 7 ? 1 : 0;
  const roles: ExecutionRole[] = ["smol", "task", "slow"];
  return roles.slice(minimum).filter(role => available.includes(role));
}

export function fallback(task: Task, reason: RoutingDecision["reason"]): RoutingDecision {
  return { backend: "deterministic", role: routeTask({ ...task, taskType: task.effectiveTaskType ?? task.taskType, uncertainty: task.effectiveUncertainty ?? task.uncertainty }).role, fallbackUsed: true, reason };
}

export function applyDecision(task: Task, decision: RoutingDecision): TaskExecution {
  const base = routeTask({ ...task, taskType: task.effectiveTaskType ?? task.taskType, uncertainty: task.effectiveUncertainty ?? task.uncertainty });
  if (decision.backend !== "omp-jev") return base;
  if (!eligibleRoles(task, [decision.role]).includes(decision.role)) throw new Error("Judgment role violates SHIP eligibility");
  return { ...base, mode: "delegate", role: decision.role, reason: `OMP Jev selected eligible ${decision.role} role; mandatory SHIP gates remain in force` };
}

export function parseBoundedChoice(response: unknown, eligible: readonly string[], threshold: number):
  | { choice: string; confidence: number; probabilities: Record<string, number> } | "malformed" | "low-confidence" | "ineligible" {
  if (!response || typeof response !== "object" || Array.isArray(response)) return "malformed";
  const r = response as Record<string, unknown>;
  const role = r.choice;
  const confidence = r.confidence;
  if (typeof role !== "string" || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return "malformed";
  if (!eligible.includes(role)) return "ineligible";
  if (!r.probabilities || typeof r.probabilities !== "object" || Array.isArray(r.probabilities)) return "malformed";
  const probabilities = r.probabilities as Record<string, unknown>;
  if (!Object.hasOwn(probabilities, role) || Object.entries(probabilities).some(([key, value]) =>
    !eligible.includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) return "malformed";
  if (confidence < threshold) return "low-confidence";
  return { choice: role, confidence, probabilities: probabilities as Record<string, number> };
}
export function parseChoice(response: unknown, eligible: readonly ExecutionRole[], threshold: number): RoutingDecision | "malformed" | "low-confidence" | "ineligible" {
  const parsed = parseBoundedChoice(response, eligible, threshold);
  return typeof parsed === "string" ? parsed :
    { backend: "omp-jev", role: parsed.choice as ExecutionRole, fallbackUsed: false, confidence: parsed.confidence, probabilities: parsed.probabilities };
}
