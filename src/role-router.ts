import type { Task, TaskExecution } from "./types.ts";

export type RoutingInput = Pick<Task, "title" | "goal" | "taskType" | "complexity" | "risk" | "uncertainty" | "dependencies" | "affectedFiles">;

// Roles and specialist intents are OMP concepts. Provider, model and thinking
// configuration remain outside the reusable SHIP core.
export function routeTask(task: RoutingInput): TaskExecution {
  const securityVerification = task.risk === "HIGH" && task.taskType !== "security-review"
    ? { verificationSpecialist: "security-reviewer" as const }
    : {};
  if (task.taskType === "reconnaissance" || task.taskType === "research") {
    return { mode: "delegate", role: "smol", specialist: "scout", reason: "Repository investigation is read-only reconnaissance suited to a scout", ...securityVerification };
  }
  if (task.taskType === "review") {
    return { mode: "delegate", role: "slow", specialist: "reviewer", reason: "Independent substantive review warrants a dedicated reviewer", ...securityVerification };
  }
  if (task.taskType === "security-review") {
    return { mode: "delegate", role: "slow", specialist: "security-reviewer", reason: "Independent security review warrants a security specialist" };
  }
  if (task.taskType === "planning-design") {
    return { mode: "delegate", role: "plan", reason: task.uncertainty === "HIGH" || task.uncertainty === "UNKNOWN"
      ? "Architecture and design need planning under unresolved uncertainty"
      : "Architecture and design need a planning role", ...securityVerification };
  }
  if (task.complexity === "COMPLEX" && (task.uncertainty === "HIGH" || task.dependencies.length >= 2)) {
    return { mode: "delegate", role: "slow", reason: task.dependencies.length >= 2
      ? "Complex work across multiple prerequisites needs difficult reasoning"
      : "Complex work under high uncertainty needs difficult reasoning", ...securityVerification };
  }
  if (task.risk === "LOW" && task.uncertainty === "LOW" && task.dependencies.length === 0 && task.affectedFiles.length === 1 &&
      (task.complexity === "TRIVIAL" || (task.taskType === "implementation" && /\b(tiny|one-line|single-line|obvious)\b/i.test(`${task.title} ${task.goal}`)))) {
    return { mode: "main", role: "main", reason: "Small, obvious single-file work has known scope and no prerequisites" };
  }
  if (task.risk === "LOW" && task.dependencies.length === 0 && task.complexity !== "COMPLEX" &&
      ["documentation", "configuration", "test"].includes(task.taskType)) {
    return { mode: "delegate", role: "smol", reason: "Bounded mechanical work is suited to the lightweight role" };
  }
  const context = task.dependencies.length ? " with prerequisite context" : "";
  return { mode: "delegate", role: "task", reason: task.risk === "HIGH"
    ? `Implementation${context} has safety boundaries and needs security-focused verification`
    : task.uncertainty === "UNKNOWN" || task.uncertainty === "HIGH"
      ? `Implementation${context} needs scope investigation before execution`
      : `Bounded implementation${context} has a normal execution route`, ...securityVerification };
}
