import type { Milestone, RepoCheck, RoadmapEdit, ShipState, Task, TaskType, TaskUncertainty } from "./types.ts";
import { classifyTask } from "./task-classification.ts";
import { routeTask } from "./role-router.ts";
import { DependencyGraph } from "./dependency-graph.ts";
import { applyDecision, derivedProfile, fallback, safeSemanticType, validateProfile, validateSemanticJudgment } from "./judgment.ts";
import { routeVerification } from "./verification.ts";

function object(x: unknown): asserts x is Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("Expected an object");
}
function text(x: unknown, name: string): asserts x is string {
  if (typeof x !== "string" || !x.trim() || x.length > 24_000) throw new Error(`Invalid ${name}`);
}
export function strings(x: unknown, name: string, nonempty = false): asserts x is string[] {
  if (!Array.isArray(x) || (nonempty && !x.length) || x.some(v => typeof v !== "string" || !v.trim())) throw new Error(`Invalid ${name}`);
}
function id(x: unknown, prefix: string) { if (typeof x !== "string" || !new RegExp(`^${prefix}[0-9]{2,}$`).test(x)) throw new Error(`Invalid ${prefix} ID`); }
function unique(items: { id: string }[]) { if (new Set(items.map(x => x.id)).size !== items.length) throw new Error("Duplicate ID"); }
const taskTypes: TaskType[] = ["reconnaissance", "planning-design", "implementation", "bugfix", "refactor", "test", "documentation", "migration", "integration", "review", "research", "configuration", "security-review"];
const uncertainties: TaskUncertainty[] = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"];
const statuses = ["pending", "running", "verifying", "passed", "failed", "blocked"];
function optionalStrings(x: unknown, name: string): asserts x is string[] | undefined { if (x !== undefined) strings(x, name); }
function taskMetadata(task: Record<string, unknown>, fromPlan: boolean, repoChecks: readonly RepoCheck[] = []): Task {
  object(task); id(task.id, "T"); text(task.title, "task title"); text(task.goal, "goal");
  strings(task.acceptance, "acceptance", true); strings(task.verificationCommands, "verificationCommands", true);
  if (fromPlan && ["status", "attempts", "lastError", "complexity", "risk", "classificationSignals", "classificationRationale", "parallelEligible", "executionRoute", "execution", "routingDecision", "semanticJudgment", "effectiveTaskType", "effectiveUncertainty", "verificationPlan", "dependencyLevel"].some(key => key in task)) throw new Error("Planner cannot override task lifecycle or classification");
  if (task.objective !== undefined) text(task.objective, "objective");
  optionalStrings(task.dependencies, "dependencies"); optionalStrings(task.affectedDomains, "affectedDomains");
  optionalStrings(task.affectedFiles, "affectedFiles"); optionalStrings(task.verificationRequirements, "verificationRequirements");
  if (task.taskType !== undefined && !taskTypes.includes(task.taskType as TaskType)) throw new Error("Invalid taskType");
  if (task.uncertainty !== undefined && !uncertainties.includes(task.uncertainty as TaskUncertainty)) throw new Error("Invalid uncertainty");
  if (task.profile !== undefined && !validateProfile(task.profile)) throw new Error("Invalid task profile");
  if (fromPlan && task.profile && (task.profile as Task["profile"]).source === "derived") throw new Error("Planner cannot claim a derived profile");
  const normalized = {
    ...task,
    objective: task.objective ?? task.goal,
    dependencies: task.dependencies ?? [],
    affectedDomains: task.affectedDomains ?? [],
    affectedFiles: task.affectedFiles ?? [],
    taskType: task.taskType ?? "implementation",
    uncertainty: task.uncertainty ?? "UNKNOWN",
    verificationRequirements: task.verificationRequirements ?? task.acceptance,
  } as unknown as Task;
  strings(normalized.verificationRequirements, "verificationRequirements", true);
  if (task.semanticJudgment !== undefined && !validateSemanticJudgment(task.semanticJudgment)) throw new Error("Invalid persisted semantic judgment");
  const semantic = task.semanticJudgment as Task["semanticJudgment"];
  const effectiveTaskType = semantic?.taskType ? safeSemanticType(normalized.taskType, semantic.taskType.value) : normalized.taskType;
  const effectiveUncertainty = semantic?.uncertainty?.value === "HIGH" && normalized.uncertainty !== "UNKNOWN" ? "HIGH" : normalized.uncertainty;
  const baseline = classifyTask({ ...normalized, taskType: effectiveTaskType, uncertainty: effectiveUncertainty });
  const plannerProfile = task.profile && (task.profile as Task["profile"]).source !== "derived" ? task.profile as Task["profile"] : undefined;
  const protectedTraits = plannerProfile?.traits.filter(trait => /^(?:security-sensitive|authentication|authorization|authn|authz|credentials?|secrets?|destructive|migration|persistence)$/i.test(trait)) ?? [];
  const highComplexity = (plannerProfile?.complexity ?? 0) >= 7 || (semantic?.complexity?.value ?? 0) >= 7;
  const highRisk = (plannerProfile?.risk ?? 0) >= 7 || semantic?.risk?.value === "HIGH" || protectedTraits.length > 0;
  const classification = { ...baseline, complexity: highComplexity ? "COMPLEX" as const : baseline.complexity,
    risk: highRisk ? "HIGH" as const : baseline.risk,
    signals: [...baseline.signals, ...protectedTraits.map(trait => `profile trait: ${trait}`)],
    rationale: [...baseline.rationale, ...(plannerProfile && plannerProfile.complexity >= 7 ? ["Planner assessed complexity at 7/10 or higher"] : []),
      ...(semantic?.complexity?.value && semantic.complexity.value >= 7 ? ["Jev assessed complexity at 7/10 or higher"] : []),
      ...(plannerProfile && plannerProfile.risk >= 7 ? ["Planner assessed risk at 7/10 or higher"] : []),
      ...(semantic?.risk?.value === "HIGH" ? ["Jev assessed high risk"] : []),
      ...(protectedTraits.length ? ["Security-sensitive planner traits require independent security review"] : [])] };
  if (classification.complexity === "COMPLEX") classification.parallelEligible = false;
  if (classification.risk === "HIGH") classification.parallelEligible = false;
  if (classification.complexity === "COMPLEX" && classification.executionRoute === "direct") classification.executionRoute = "decompose";
  const profile = task.profile ? { ...(task.profile as Task["profile"]), source: (task.profile as Task["profile"]).source ?? "planner" as const }
    : derivedProfile({ ...normalized, complexity: classification.complexity, risk: classification.risk }, classification.rationale, classification.signals);
  const routingDecision = task.routingDecision === undefined ? fallback({ ...normalized, complexity: classification.complexity, risk: classification.risk, effectiveTaskType, effectiveUncertainty }, "disabled")
    : task.routingDecision as Task["routingDecision"];
  if (!routingDecision || typeof routingDecision !== "object" || !["deterministic", "omp-jev"].includes(routingDecision.backend) ||
      typeof routingDecision.fallbackUsed !== "boolean" || (routingDecision.backend === "omp-jev" && routingDecision.fallbackUsed) ||
      (routingDecision.backend === "deterministic" && (!routingDecision.fallbackUsed || routingDecision.role !== routeTask({ ...normalized, taskType: effectiveTaskType, uncertainty: effectiveUncertainty, complexity: classification.complexity, risk: classification.risk }).role)) ||
      (routingDecision.confidence !== undefined && (typeof routingDecision.confidence !== "number" || !Number.isFinite(routingDecision.confidence) || routingDecision.confidence < 0 || routingDecision.confidence > 1))) throw new Error("Invalid persisted routing decision");
  const classified = { ...normalized, taskType: effectiveTaskType, uncertainty: effectiveUncertainty, complexity: classification.complexity, risk: classification.risk, profile, effectiveTaskType };
  const computed = {
    complexity: classification.complexity, risk: classification.risk,
    effectiveTaskType, effectiveUncertainty,
    classificationSignals: classification.signals, classificationRationale: classification.rationale,
    parallelEligible: classification.parallelEligible, executionRoute: classification.executionRoute,
    execution: applyDecision(classified, routingDecision),
    verificationPlan: routeVerification(classified, repoChecks),
  };
  for (const key of Object.keys(computed) as (keyof typeof computed)[]) {
    if (!fromPlan && task[key] !== undefined && JSON.stringify(task[key]) !== JSON.stringify(computed[key])) throw new Error(`Invalid persisted ${key}`);
  }
  return { ...normalized, profile, routingDecision, ...computed };
}

export function recomputeJudgedTask(task: Task, repoChecks: readonly RepoCheck[] = []): void {
  const { complexity, risk, classificationSignals, classificationRationale, parallelEligible, executionRoute, execution,
    routingDecision, effectiveTaskType, effectiveUncertainty, verificationPlan, ...base } = task;
  Object.assign(task, taskMetadata(base, false, repoChecks));
}

export function normalizePlan(value: unknown, fromPlan = false, repoChecks: readonly RepoCheck[] = []): Milestone[] {
  if (!Array.isArray(value)) throw new Error("Expected milestones");
  const normalized = value.map(m => {
    object(m);
    if (fromPlan && "status" in m) throw new Error("Planner cannot override milestone status");
    if (!Array.isArray(m.slices)) throw new Error("Milestone needs slices");
    return { ...m, status: fromPlan ? "pending" : m.status, slices: m.slices.map(s => {
      object(s);
      if (fromPlan && "status" in s) throw new Error("Planner cannot override slice status");
      if (!Array.isArray(s.tasks)) throw new Error("Slice needs tasks");
      return { ...s, status: fromPlan ? "pending" : s.status, tasks: s.tasks.map(t => {
        object(t);
        return taskMetadata(t, fromPlan, repoChecks);
      }) };
    }) };
  }) as Milestone[];
  if (fromPlan) for (const m of normalized) for (const s of m.slices) for (const t of s.tasks) { t.status = "pending"; t.attempts = 0; }
  validatePlan(normalized);
  const graph = new DependencyGraph(normalized);
  graph.levels.forEach((level, index) => level.forEach(({ key, task }) => {
    if (!fromPlan && task.dependencyLevel !== undefined && task.dependencyLevel !== index) throw new Error(`Invalid persisted dependencyLevel for ${key}`);
    task.dependencyLevel = index;
  }));
  if (!fromPlan) for (const m of normalized) {
    if (!["pending", "active", "complete"].includes(m.status)) throw new Error("Invalid milestone status");
    for (const s of m.slices) {
      if (!["pending", "active", "complete"].includes(s.status)) throw new Error("Invalid slice status");
      for (const t of s.tasks) if (!statuses.includes(t.status) || !Number.isSafeInteger(t.attempts) || t.attempts < 0) throw new Error("Invalid task state");
    }
  }
  return normalized;
}

export function validatePlan(value: unknown): asserts value is Milestone[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new Error("Expected 1–20 milestones");
  let tasks = 0;
  for (const m of value) {
    object(m); id(m.id, "M"); text(m.title, "milestone title"); text(m.outcome, "outcome");
    if (!Array.isArray(m.slices) || !m.slices.length) throw new Error("Milestone needs slices");
    for (const s of m.slices) {
      object(s); id(s.id, "S"); text(s.title, "slice title");
      if (!Array.isArray(s.tasks) || !s.tasks.length) throw new Error("Slice needs tasks");
      for (const t of s.tasks) {
        object(t); id(t.id, "T"); text(t.title, "task title"); text(t.goal, "goal"); text(t.objective, "objective");
        strings(t.acceptance, "acceptance", true); strings(t.verificationCommands, "verificationCommands", true);
        strings(t.dependencies, "dependencies"); strings(t.affectedDomains, "affectedDomains"); strings(t.affectedFiles, "affectedFiles"); strings(t.verificationRequirements, "verificationRequirements", true);
        if (!taskTypes.includes(t.taskType as TaskType) || !uncertainties.includes(t.uncertainty as TaskUncertainty)) throw new Error("Invalid task metadata");
        if (++tasks > 200) throw new Error("Plan exceeds 200 tasks; reduce scope");
      }
      unique(s.tasks as Task[]);
    }
    unique(m.slices as Milestone["slices"]);
  }
  unique(value);
  new DependencyGraph(value);
}
export function parsePlan(output: string, repoChecks: readonly RepoCheck[] = [], requirePlannerProfile = false): Milestone[] {
  const raw: unknown = JSON.parse(output.trim()); object(raw);
  if (requirePlannerProfile) {
    if (!Array.isArray(raw.milestones)) throw new Error("Plan needs milestones");
    for (const milestone of raw.milestones) {
      object(milestone);
      if (!Array.isArray(milestone.slices)) throw new Error("Milestone needs slices");
      for (const slice of milestone.slices) {
        object(slice);
        if (!Array.isArray(slice.tasks)) throw new Error("Slice needs tasks");
        for (const task of slice.tasks) {
          object(task);
          if (!validateProfile(task.profile) || task.profile.source === "derived") throw new Error("New planner task requires a 1–10 complexity, uncertainty and risk profile");
          if (!taskTypes.includes(task.taskType as TaskType) || !uncertainties.includes(task.uncertainty as TaskUncertainty)) throw new Error("New planner task requires semantic taskType and uncertainty");
        }
      }
    }
  }
  return normalizePlan(raw.milestones, true, repoChecks);
}
export function tasks(state: ShipState) {
  return state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => ({ m, s, t, key: `${m.id}/${s.id}/${t.id}`, slice: `${m.id}/${s.id}` }))));
}
export function applyRoadmapEdit(state: ShipState, edit: RoadmapEdit): void {
  if (!state.milestones.length) throw new Error("Roadmap has not been loaded");
  if (!Number.isSafeInteger(edit.revision) || edit.revision < 0 || edit.revision !== state.roadmapRevision) throw new Error(`Stale roadmap revision: requested ${edit.revision}, current ${state.roadmapRevision}`);
  if (state.activeAttempt || state.nativeBatch || state.nativePlanning || state.pendingJudgment) throw new Error("Cannot edit roadmap during an active attempt, native batch, planning assignment or judgment");
  // A rejected graph or malformed hint must leave the authoritative plan untouched.
  const plan = structuredClone(state.milestones);
  const hints = { taskType: edit.taskType, uncertainty: edit.uncertainty, profile: edit.profile, dependencies: edit.dependencies, affectedFiles: edit.affectedFiles, affectedDomains: edit.affectedDomains, verificationRequirements: edit.verificationRequirements };
  const supplied = Object.fromEntries(Object.entries(hints).filter(([, value]) => value !== undefined));
  if (edit.type === "add") {
    const match = /^([^/]+)\/([^/]+)$/.exec(edit.slice);
    const slice = match && plan.find(m => m.id === match[1])?.slices.find(s => s.id === match[2]);
    if (!slice) throw new Error(`Unknown slice: ${edit.slice}`);
    const next = Math.max(0, ...slice.tasks.map(t => Number(t.id.slice(1)))) + 1;
    if (!Number.isSafeInteger(next)) throw new Error("Task ID limit exceeded");
    const added = taskMetadata({ id: `T${String(next).padStart(2, "0")}`, title: edit.title, goal: edit.goal, acceptance: [edit.acceptance], verificationCommands: [edit.check], ...supplied, verificationRequirements: [edit.acceptance, ...(edit.verificationRequirements ?? [])] }, true, state.repoChecks);
    added.status = "pending"; added.attempts = 0; slice.tasks.push(added);
  } else {
    const entry = plan.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => ({ key: `${m.id}/${s.id}/${t.id}`, t })))).find(x => x.key === edit.task);
    if (!entry) throw new Error(`Unknown task: ${edit.task}`);
    if (entry.t.status !== "pending" || entry.t.attempts !== 0) throw new Error(`Task ${edit.task} has already started`);
    const { complexity, risk, classificationSignals, classificationRationale, parallelEligible, executionRoute, execution, routingDecision, semanticJudgment, effectiveTaskType, effectiveUncertainty, verificationPlan, dependencyLevel, profile, ...base } = entry.t;
    const updated = taskMetadata({ ...base, goal: edit.goal, objective: edit.goal, ...supplied, verificationRequirements: [...new Set([...base.verificationRequirements, ...(edit.verificationRequirements ?? [])])] }, false, state.repoChecks);
    Object.assign(entry.t, updated);
  }
  validatePlan(plan);
  const graph = new DependencyGraph(plan);
  graph.levels.forEach((level, index) => level.forEach(({ task }) => { task.dependencyLevel = index; }));
  state.milestones = plan;
  state.roadmapRevision++;
  if (edit.type === "add") {
    if (state.phase === "complete") state.phase = "idle";
  }
}
export function refresh(state: ShipState): void {
  for (const m of state.milestones) {
    for (const s of m.slices) s.status = s.tasks.every(t => t.status === "passed") ? "complete" : s.tasks.some(t => t.attempts > 0) ? "active" : "pending";
    m.status = m.slices.every(s => s.status === "complete") ? "complete" : m.slices.some(s => s.status !== "pending") ? "active" : "pending";
  }
}
