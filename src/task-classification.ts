import type { Task, TaskComplexity, TaskRisk } from "./types.ts";

export type ClassificationInput = Pick<Task, "title" | "objective" | "goal" | "acceptance" | "verificationRequirements" | "verificationCommands" | "dependencies" | "affectedDomains" | "affectedFiles" | "taskType" | "uncertainty">;
export interface Classification { complexity: TaskComplexity; risk: TaskRisk; signals: string[]; rationale: string[]; parallelEligible: boolean; executionRoute: "direct" | "investigate" | "decompose"; }

// Structural signals and explicit wording are the only evidence available at plan time.
// UNKNOWN denotes absent scope information, not an assertion that the change is safe.
export function classifyTask(task: ClassificationInput): Classification {
  const description = [task.title, task.objective, task.goal, ...task.acceptance, ...task.verificationRequirements, ...task.affectedDomains, ...task.affectedFiles].join(" ").toLowerCase();
  const commands = task.verificationCommands.join(" ").toLowerCase();
  const signals: string[] = [];
  const signal = (name: string, pattern: RegExp) => { if (pattern.test(description)) signals.push(name); };
  signal("authn/authz", /\b(auth(?:entication|orization|n|z)?|login|logins|oauth|access control|session tokens?)\b/);
  signal("secrets", /\b(secrets?|credentials?|api keys?|private keys?|passwords?|tokens?)\b/);
  signal("destructive operations", /\b(destructive|drop table|truncate table|wipe|erase|purge|delet(?:e|ion) (?:accounts?|records?|data|repositories?|environments?))\b/);
  if (task.taskType === "migration" || /\b(migrat(?:e|ion|ions)|schema|database table|ddl)\b/.test(description)) signals.push("migration/schema");
  signal("persisted data", /\b(persist(?:ed|ent|ence)? data|stored data|database|data retention)\b/);
  if (/\b(delet(?:e|ion)|remov(?:e|al))\b.{0,40}\b(files?|directories|folders?)\b|\b(files?|directories|folders?)\b.{0,40}\b(delet(?:e|ion)|remov(?:e|al))\b/.test(description) || /\brm\s+-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)\b/.test(commands)) signals.push("filesystem deletion");
  signal("permissions", /\b(permissions?|privileges?|chmod|chown|acl)\b/);
  signal("network/security", /\b(network|http(?:s)?|tls|ssl|socket|firewall|security|vulnerabilit(?:y|ies)|remote api|webhook)\b/);
  const rationale: string[] = [];
  const scope = task.affectedFiles.length + task.affectedDomains.length;
  let complexity: TaskComplexity;
  if (task.dependencies.length >= 2 || task.affectedDomains.length >= 2 || task.affectedFiles.length >= 4 || task.uncertainty === "HIGH" || task.taskType === "migration" || task.taskType === "integration") {
    complexity = "COMPLEX";
    if (task.dependencies.length >= 2) rationale.push("multiple dependencies");
    if (task.affectedDomains.length >= 2) rationale.push("multiple affected domains");
    if (task.affectedFiles.length >= 4) rationale.push("four or more affected files");
    if (task.uncertainty === "HIGH") rationale.push("high uncertainty");
    if (task.taskType === "migration" || task.taskType === "integration") rationale.push(`${task.taskType} task type`);
  } else if (task.uncertainty === "LOW" && !task.dependencies.length && task.affectedDomains.length <= 1 && task.affectedFiles.length === 1 && ["documentation", "test", "configuration"].includes(task.taskType)) {
    complexity = "TRIVIAL"; rationale.push("single known file, no dependencies, low uncertainty, focused task type");
  } else { complexity = "STANDARD"; rationale.push(scope === 0 ? "affected scope unspecified" : "bounded scope without complex structural signals"); }
  const risk: TaskRisk = signals.length ? "HIGH" : task.uncertainty === "UNKNOWN" ? "UNKNOWN" : "LOW";
  rationale.push(signals.length ? `safety signals: ${signals.join(", ")}` : risk === "UNKNOWN" ? "risk unknown because scope is unspecified" : "no explicit safety signals in supplied scope");
  const parallelEligible = !task.dependencies.length && risk === "LOW" && task.uncertainty === "LOW" && complexity !== "COMPLEX";
  const executionRoute = task.uncertainty === "HIGH" || task.uncertainty === "UNKNOWN" ? "investigate" : complexity === "COMPLEX" ? "decompose" : "direct";
  return { complexity, risk, signals, rationale, parallelEligible, executionRoute };
}
