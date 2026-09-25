import type { ShipState, Task } from "./types.ts";

export function plannerPrompt(project: string): string {
  return `You are Ship's planning agent. Return ONLY valid JSON, no markdown fences.\n\nCreate a minimal roadmap from this project brief. Use 1-3 milestones, each with 1-3 slices, each with 1-5 concrete implementation tasks. Do not invent product scope. Each task must include id, title, goal, acceptance (string[]), verificationCommands (string[]). IDs must be stable like M001, S01, T01.\n\nPROJECT BRIEF:\n${project}\n\nReturn {"milestones":[...]}.`;
}

export function executorPrompt(project: string, state: ShipState, task: Task): string {
  return `You are Ship's executor. Work directly in the repository. Complete exactly one task. Do not edit .ship/state.json or redefine acceptance criteria. Make real source changes and run useful local checks when possible.\n\nPROJECT:\n${project}\n\nTASK ${task.id}: ${task.title}\nGoal: ${task.goal}\nAcceptance:\n${task.acceptance.map(x => `- ${x}`).join("\n")}\n\nRoadmap revision: ${state.roadmapRevision}\n\nWhen done, respond briefly with what changed and any discoveries. The controller, not you, decides whether the task passes.`;
}
