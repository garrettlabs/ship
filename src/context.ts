import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { readProjectProfile } from "./project-profile.ts";
import type { ShipState, Task } from "./types.ts";

const TOTAL = 12_000;
const SECTION = { instructions: 3_200, request: 1_600, discovery: 1_200, decisions: 1_400, task: 2_300, prerequisites: 1_400, unknowns: 1_000 } as const;
const cut = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 19)}… [truncated]`;
const line = (text: string, limit = 400) => cut(text.trim().replace(/\s+/g, " "), limit);

/** Read only regular bounded files; never follow a symlink out of the checkout. */
async function boundedFile(file: string, limit: number): Promise<string | undefined> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) return undefined;
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, limit + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return cut(buffer.toString("utf8", 0, bytesRead), limit);
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

type Entry = { key: string; task: Task };
function entries(state: ShipState): Entry[] {
  return state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(task => ({
    key: `${m.id}/${s.id}/${task.id}`, task,
  }))));
}
function selectedTask(state: ShipState, key: string): Entry {
  const matches = entries(state).filter(entry => entry.key === key || entry.task.id === key);
  if (matches.length !== 1) throw new Error(`Task key ${key} does not uniquely identify a roadmap task`);
  return matches[0];
}
function section(name: string, items: string[], limit: number): string {
  const body: string[] = [];
  let used = 0;
  for (const item of items) {
    if (!item.trim()) continue;
    if (used + item.length + 1 > limit) {
      const marker = "[Further entries omitted]";
      const remaining = limit - used;
      if (remaining > marker.length + 60) {
        const excerpt = cut(item, remaining - marker.length - 2);
        body.push(excerpt);
        used += excerpt.length + 1;
      }
      if (used + marker.length + 1 <= limit) body.push(marker);
      break;
    }
    body.push(item);
    used += item.length + 1;
  }
  return `## ${name}\n${body.length ? body.join("\n") : "Unknown; no verified evidence available."}`;
}

async function shared(root: string, state: ShipState, task?: Entry): Promise<{ sections: string[]; unknowns: string[] }> {
  // The profile refreshes fingerprints before use. Its cache is SHIP metadata, not repository source.
  const profile = await readProjectProfile(root);
  const unknowns = [...profile.unknowns];
  const names = profile.facts.instructions.filter(name => {
    if (!/^(?:AGENTS\.md|CLAUDE\.md|CONTRIBUTING\.md|README(?:\.md)?|(?:apps|packages|services)\/[^/]+\/(?:AGENTS|CLAUDE)\.md)$/.test(name)) return false;
    if (!name.includes("/")) return true;
    return !!task?.task.affectedFiles.some(file => file.startsWith(name.slice(0, name.lastIndexOf("/") + 1)));
  });
  const instructions: string[] = [];
  for (const name of names.slice(0, 8)) {
    const content = await boundedFile(path.join(root, name), 900);
    if (content) instructions.push(`[repository instruction: ${name}; current profile] ${content.trim()}`);
    else unknowns.push(`Instruction ${name} no longer readable; inspect before relying on it`);
  }
  if (names.length > 8) unknowns.push(`${names.length - 8} relevant instruction files omitted; inspect before editing their scopes`);
  const currentRequest = state.nativePlanning?.request;
  const pending = state.pendingProposal?.request;
  const project = await boundedFile(path.join(root, ".ship", "PROJECT.md"), 1_500);
  const request = currentRequest?.trim() ? `[current user change request; not yet approved] ${line(currentRequest, 1_500)}`
    : pending?.trim() ? `[proposed user request; not yet accepted as a roadmap] ${line(pending, 1_500)}`
    : project?.trim() ? `[original user project request: .ship/PROJECT.md] ${project.trim()}` : "";
  if (!request) unknowns.push("No explicit user request available; do not infer a goal from discovery");
  const approved = state.discovery?.status === "approved";
  const discovery = approved ? await boundedFile(path.join(root, ".ship", "DISCOVERY.md"), 1_100) : undefined;
  if (approved && !discovery) unknowns.push("Discovery marked approved but DISCOVERY.md unavailable");
  const decisions = (state.knowledge ?? []).filter(k => k.source === "user" && k.kind === "decision")
    .slice(-8).reverse().map(k => `[accepted user decision ${k.id}; ${line(k.evidence, 90)}] ${line(k.text, 260)}`);
  const ideas = (state.knowledge ?? []).filter(k => k.kind === "capture").slice(-4).reverse()
    .map(k => `[unplanned idea ${k.id}; not approved scope] ${line(k.text, 200)}`);
  return { sections: [
    section("Current repository instructions (follow applicable source instructions over discovery)", instructions, SECTION.instructions),
    section("User request", request ? [request] : [], SECTION.request),
    section("Approved reconnaissance (historical observations; may be stale, not user authorization)", discovery ? [`[approved .ship/DISCOVERY.md; recheck against current repository] ${discovery.trim()}`] : [], SECTION.discovery),
    section("Accepted user decisions and unplanned ideas", [...decisions, ...ideas], SECTION.decisions),
  ], unknowns };
}


/** Selective planner input; no roadmap, generated log, or source file dump. */
export async function buildPlannerContext(root: string, state: ShipState): Promise<string> {
  const { sections, unknowns } = await shared(root, state);
  const failure = state.blockedReason ? [`[current blocked reason] ${line(state.blockedReason)}`] : [];
  const prior = entries(state).filter(e => e.task.status === "failed" && e.task.lastError).slice(-3)
    .map(e => `[prior failure ${e.key}] ${line(e.task.lastError!, 240)}`);
  return cut([...sections, section("Unresolved questions and prior failures", [...failure, ...prior, ...unknowns.map(u => `[unknown] ${line(u, 220)}`)], SECTION.unknowns)].join("\n\n"), TOTAL);
}

/** Selective worker input for one task, with only relevant completed prerequisite refs. */
export async function buildWorkerContext(root: string, state: ShipState, taskKey: string): Promise<string> {
  const target = selectedTask(state, taskKey);
  const { sections, unknowns } = await shared(root, state, target);
  const { task } = target;
  const taskLines = [
    `[current task ${target.key}; roadmap revision ${state.roadmapRevision}; ${task.status}] ${line(task.title)}`,
    `Goal: ${line(task.goal, 700)}`, `Objective: ${line(task.objective, 700)}`,
    ...task.acceptance.slice(0, 8).map(a => `Acceptance: ${line(a, 260)}`),
    ...task.verificationPlan.requirements.slice(0, 6).map(v => `Verification (${v.kind}): ${line(v.reason, 200)}${v.command ? `; command ${line(v.command, 160)}` : ""}`),
    ...task.verificationCommands.slice(0, 4).map(c => `Verification command: ${line(c, 180)}`),
  ];
  const all = entries(state);
  const prerequisiteLines = task.dependencies.slice(0, 10).map(dep => {
    const entry = all.find(e => e.key === dep) ?? all.find(e => e.task.id === dep && all.filter(x => x.task.id === dep).length === 1);
    if (!entry) return `[unresolved prerequisite ${line(dep, 120)}] Evidence unknown; do not assume completion`;
    const t = entry.task;
    const refs = t.status === "passed" && t.evidenceRefs?.length ? t.evidenceRefs.slice(0, 3).map(ref => line(ref, 140)).join("; ") : undefined;
    return `[prerequisite ${entry.key}; ${t.status}] ${line(t.goal, 220)}${t.status === "passed" ? `; recorded acceptance: ${t.acceptance.slice(0, 2).map(a => line(a, 120)).join("; ")}; ${refs ? `persisted verification evidence refs: ${refs}` : "evidence ref unknown"}` : "; outcome not verified; evidence ref unknown"}`;
  });
  const failures = [
    ...(task.lastError ? [`[current task prior failure] ${line(task.lastError, 350)}`] : []),
    ...task.dependencies.flatMap(dep => {
      const entry = all.find(e => e.key === dep);
      return entry?.task.status === "failed" && entry.task.lastError ? [`[prerequisite failure ${dep}] ${line(entry.task.lastError, 250)}`] : [];
    }),
  ];
  if (task.dependencies.length > 10) unknowns.push(`${task.dependencies.length - 10} prerequisite references omitted`);
  if (task.acceptance.length > 8 || task.verificationPlan.requirements.length > 6 || task.verificationCommands.length > 4) unknowns.push("Some task criteria or checks omitted from bounded context; consult selected task before verification");
  const assumptions = (state.knowledge ?? []).filter(k => k.kind === "assumption" && k.source === "agent").slice(-3).map(k => `[unverified agent assumption ${k.id}] ${line(k.text, 180)}`);
  return cut([...sections,
    section("Current task", taskLines, SECTION.task),
    section("Prerequisite outcomes and evidence references (no artifact bodies)", prerequisiteLines, SECTION.prerequisites),
    section("Unresolved questions, stale inputs and prior failures", [...failures, ...assumptions, ...unknowns.map(u => `[unknown] ${line(u, 180)}`)], SECTION.unknowns),
  ].join("\n\n"), TOTAL);
}
