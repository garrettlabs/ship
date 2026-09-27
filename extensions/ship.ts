import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { exists, loadState, queueMessage, queueRoadmapEdit, shipDir } from "../src/store.ts";
import { initialize } from "../src/project.ts";
import { recoverLock } from "../src/lock.ts";
import { completeNativeJudgment, confirmNativeSpecialist, recoverNativeRun, reportNativeOutcome, routeNativeSpawn, startNativeRun, submitNativePlan, type NativeOutcome, type RoutingContext } from "../src/native-execution.ts";
import type { ExecutionRole, RoadmapEdit } from "../src/types.ts";
import { hashJudgmentRequest } from "../src/judgment.ts";

async function projectRoot(cwd: string): Promise<string> {
  let current = await realpath(cwd);
  while (true) {
    try {
      await access(path.join(current, ".ship", "state.json"));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`No Ship project (.ship/state.json) found above ${cwd}`);
      current = parent;
    }
  }
}


function isNativeOutcome(value: unknown): value is NativeOutcome {
  if (value === null || typeof value !== "object") return false;
  if (!("batchId" in value && "assignmentId" in value && "status" in value && "summary" in value)) return false;
  return typeof value.batchId === "string" && typeof value.assignmentId === "string" &&
    (value.status === "passed" || value.status === "failed" || value.status === "partial") &&
    typeof value.summary === "string";
}

const help = "Ship commands: /ship init (initialize from a project brief); /ship run (trigger native OMP planning and task dispatch); /ship add and /ship change (queue safe-boundary roadmap edits); /ship status (inspect persisted progress); /ship pause and /ship resume (safe-boundary stop/recovery); /ship recover (only after confirming all former OMP workers are dead; reconcile lost native work and clear a dead SHIP lock). OMP owns agents and sessions.";
const assignmentName = /^Ship([0-9a-f]{26})$/;
function taskItems(input: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(input.tasks) ? input.tasks.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    : [input];
}


export function createShipExtension() {
  return (api: ExtensionAPI): void => {
    const z = api.zod;
    const routing = (ctx: { models: { resolve: (alias: string) => { id: string; cost?: { input?: number; output?: number } } | undefined } }): RoutingContext => {
      const roles: ExecutionRole[] = ["smol", "task", "slow"];
      return { jevAvailable: api.getAllTools().some(tool => tool.name === "jev_ask") && api.getActiveTools().includes("jev_ask"),
        candidates: roles.flatMap(role => {
          const model = ctx.models.resolve(`@${role}`);
          return model ? [{ role, model: model.id, ...(model.cost && Number.isFinite(model.cost.input) && Number.isFinite(model.cost.output)
            ? { pricing: { input: model.cost.input!, output: model.cost.output! } } : {}) }] : [];
        }) };
    };
    const pendingJobs = new Map<string, { root: string; sessionId: string; assignmentId: string; agent: string }>();
    api.on("tool_result", async (event, ctx) => {
      if (ctx.agent.kind !== "main" || event.toolName !== "jev_ask") return;
      const root = await projectRoot(ctx.cwd).catch(() => undefined);
      if (!root) return;
      const pending = (await loadState(root)).pendingJudgment;
      if (!pending || pending.sessionId !== ctx.sessionManager.getSessionId()) return;
      const input = event.input;
      if (!input || typeof input !== "object" || !("state" in input) || !input.state ||
          typeof input.state !== "object" || !("correlation" in input.state) ||
          input.state.correlation !== pending.id) return;
      try {
        const status = hashJudgmentRequest(input) !== pending.requestHash ? "malformed" : event.isError ? "error" : "result";
        const next = await completeNativeJudgment(root, pending.sessionId, pending.id, status, event.details, routing(ctx));
        if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next, { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`SHIP judgment could not advance: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    });
    api.on("tool_result", async (event, ctx) => {
      if (ctx.agent.kind !== "main" || event.isError || (event.toolName !== "task" && event.toolName !== "wait")) return;
      const sessionId = ctx.sessionManager.getSessionId();
      if (event.toolName === "wait") {
        const details = event.details as { jobs?: { id?: string; type?: string; status?: string }[] } | undefined;
        for (const job of details?.jobs ?? []) {
          const pending = job.id ? pendingJobs.get(job.id) : undefined;
          if (!pending || pending.sessionId !== sessionId) continue;
          if (job.status === "running") continue;
          pendingJobs.delete(job.id!);
          if (job.type === "task" && job.status === "completed") {
            await confirmNativeSpecialist(pending.root, sessionId, pending.assignmentId, pending.agent);
          }
        }
        return;
      }
      const root = await projectRoot(ctx.cwd).catch(() => undefined);
      if (!root) return;
      const batch = (await loadState(root)).nativeBatch;
      if (!batch || batch.sessionId !== sessionId || batch.awaitingBudget) return;
      const items = taskItems(event.input);
      const details = event.details as { results?: { index?: number; id?: string; agent?: string; exitCode?: number; error?: string; aborted?: boolean }[];
        progress?: { index?: number; id?: string; agent?: string; status?: string }[]; async?: { state?: string } } | undefined;
      const matched = (index: number | undefined, id: string | undefined, agent: string | undefined) => {
        const item = items[index ?? -1], name = item?.name;
        if (typeof name !== "string" || typeof id !== "string" || typeof agent !== "string" ||
            item.agent !== agent || typeof item.task !== "string" ||
            !assignmentName.test(name) || !(id === name || id.startsWith(`${name}-`))) return;
        const assignment = batch.assignments.find(entry => name === `Ship${entry.id.replaceAll("-", "").slice(0, 26)}` && entry.status === "pending");
        return assignment && item.task.includes(assignment.id) ? assignment.id : undefined;
      };
      for (const result of details?.results ?? []) {
        const assignmentId = matched(result.index, result.id, result.agent);
        if (assignmentId && result.exitCode === 0 && !result.error && !result.aborted) {
          await confirmNativeSpecialist(root, sessionId, assignmentId, result.agent!);
        }
      }
      if (details?.async?.state === "running") for (const progress of details.progress ?? []) {
        const assignmentId = matched(progress.index, progress.id, progress.agent);
        if (assignmentId && progress.status !== "failed") pendingJobs.set(progress.id!, { root, sessionId, assignmentId, agent: progress.agent! });
      }
    });
    api.on("before_subagent_spawn", async (event, ctx) => {
      if (ctx.agent.kind !== "main" || !event.spawnKey?.includes("Ship")) return;
      const root = await projectRoot(ctx.cwd).catch(() => undefined);
      if (!root) return;
      try {
        const alias = await routeNativeSpawn(root, ctx.sessionManager.getSessionId(), event.spawnKey, event.agent, role => Boolean(ctx.models.resolve(role)));
        if (alias) return { model: alias, note: `SHIP assignment routed by configured OMP ${alias} role` };
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    });
    api.registerTool({
      name: "ship_plan",
      label: "Ship execution plan",
      description: "Submit the assigned OMP planner's complete raw JSON answer (not Markdown or fenced text) as plan, with the active planningId. Expected top-level JSON: {\"milestones\":[{\"id\":\"M001\",\"title\":\"...\",\"outcome\":\"...\",\"slices\":[{\"id\":\"S01\",\"title\":\"...\",\"tasks\":[{\"id\":\"T01\",\"title\":\"...\",\"objective\":\"...\",\"goal\":\"...\",\"dependencies\":[],\"acceptance\":[\"...\"],\"affectedDomains\":[],\"affectedFiles\":[],\"taskType\":\"implementation\",\"uncertainty\":\"UNKNOWN\",\"verificationRequirements\":[\"...\"],\"verificationCommands\":[\"...\"]}]}]}]}. Include complete milestones, slices and tasks; no prose, code fences, or status fields.",
      parameters: z.object({ planningId: z.string(), plan: z.string() }),
      async execute(_id, params, _signal, _update, ctx) {
        try {
          if (ctx.agent.kind !== "main") throw new Error("Only the main OMP session can submit SHIP plans");
          if (!params || typeof params !== "object" || !("planningId" in params) || typeof params.planningId !== "string" ||
              !("plan" in params) || typeof params.plan !== "string") throw new Error("Invalid SHIP plan fields");
          const root = await projectRoot(ctx.cwd);
          const next = await submitNativePlan(root, ctx.sessionManager.getSessionId(), params.planningId, params.plan, routing(ctx));
          if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next, { deliverAs: "followUp" });
          return { content: [{ type: "text", text: next }] };
        } catch (error) {
          return { content: [{ type: "text", text: `SHIP plan rejected: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    });
    api.registerTool({
      name: "ship_judgment",
      label: "Report unavailable Jev judgment",
      description: "Report that the public jev_ask tool cannot be called for an outstanding SHIP routing request; SHIP falls back deterministically. Never use this to supply a fabricated judgment.",
      parameters: z.object({ id: z.string(), status: z.literal("unavailable") }),
      async execute(_id, params, _signal, _update, ctx) {
        try {
          if (ctx.agent.kind !== "main" || !params || typeof params !== "object" || !("status" in params) || params.status !== "unavailable" ||
              !("id" in params) || typeof params.id !== "string") throw new Error("Only the main session may report unavailable judgment");
          const root = await projectRoot(ctx.cwd);
          const next = await completeNativeJudgment(root, ctx.sessionManager.getSessionId(), params.id, "unavailable", undefined, routing(ctx));
          if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next, { deliverAs: "followUp" });
          return { content: [{ type: "text", text: next }] };
        } catch (error) {
          return { content: [{ type: "text", text: `SHIP judgment rejected: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    });
    api.registerTool({
      name: "ship_outcome",
      label: "Ship task outcome",
      description: "Record the concrete result of a SHIP OMP-native assignment. The SHIP state machine verifies successful work before marking it passed.",
      parameters: z.object({
        batchId: z.string(), assignmentId: z.string(),
        status: z.enum(["passed", "failed", "partial"]),
        summary: z.string(),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        try {
          if (!isNativeOutcome(params)) throw new Error("Invalid SHIP outcome fields");
          if (ctx.agent.kind !== "main") throw new Error("Only the main OMP session can report SHIP assignments");
          const root = await projectRoot(ctx.cwd);
          const next = await reportNativeOutcome(root, ctx.sessionManager.getSessionId(), params, routing(ctx));
          if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next, { deliverAs: "followUp" });
          return { content: [{ type: "text", text: next }] };
        } catch (error) {
          return { content: [{ type: "text", text: `SHIP outcome rejected: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    });
    api.registerCommand("ship", {
      description: "Initialize and manage native Ship project planning (/ship for help)",
      async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
        const action = args.trim() || "help";
        if (action === "help") { ctx.ui.notify(help, "info"); return; }
        if (!["init", "status", "run", "pause", "resume", "recover", "add", "change"].includes(action)) {
          ctx.ui.notify(`Unknown Ship command: ${action}. ${help}`, "error"); return;
        }
        if (["init", "run", "recover", "add", "change"].includes(action) && !ctx.hasUI) {
          ctx.ui.notify(`/ship ${action} requires an interactive UI.`, "error"); return;
        }
        try {
          if (action === "init") {
            if (ctx.agent.kind !== "main") throw new Error("Initialize SHIP from the main OMP session");
            const brief = await ctx.ui.input("Project brief", "Path to a nonempty brief file in this checkout");
            if (brief === undefined) return;
            if (!brief.trim()) throw new Error("Project brief path cannot be empty");
            const root = await realpath(ctx.cwd);
            if (!await ctx.ui.confirm("Initialize SHIP?", `Use ${brief.trim()} as the project brief in ${root}? Existing .ship state will not be overwritten.`)) return;
            await initialize(root, brief.trim());
            ctx.ui.notify("SHIP initialized. Use /ship run to plan and dispatch tasks in this OMP session.", "info");
            return;
          }
          const root = await projectRoot(ctx.cwd);
          if (action === "recover") {
            if (ctx.agent.kind !== "main") throw new Error("Recover SHIP from the main OMP session");
            if (!await ctx.ui.confirm("Destructively recover dead OMP work?", "Only continue after confirming the former OMP session AND every outstanding worker are dead; SHIP cannot inspect OMP worker liveness. Pending assignments will be marked failed, their paid attempts consumed, and the batch transferred to this session; recovery may immediately dispatch another paid assignment. A budget-blocked review remains pending. Recovery refuses a live SHIP lock owner.")) return;
            if (await exists(path.join(shipDir(root), "lock"))) await recoverLock(root);
            const next = await recoverNativeRun(root, ctx.sessionManager.getSessionId(), routing(ctx));
            if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next, { deliverAs: "followUp" });
            ctx.ui.notify(next.startsWith("SHIP OMP-native") ? "SHIP recovered dead work and sent the next assignment to this OMP session." : next, next.startsWith("SHIP blocked") ? "warning" : "info");
            return;
          }
          if (action === "status") {
            const s = await loadState(root);
            const taskCount = s.milestones.reduce((count, milestone) => count + milestone.slices.reduce((n, slice) => n + slice.tasks.length, 0), 0);
            ctx.ui.notify(`${s.projectName}: ${s.phase}${s.paused ? " (paused)" : ""}; roadmap r${s.roadmapRevision}, ${taskCount} tasks, ${s.dispatches ?? 0} dispatches${s.nativeBatch ? `; native batch ${s.nativeBatch.id} (${s.nativeBatch.stage})` : ""}${s.blockedReason ? `; blocked: ${s.blockedReason}` : ""}`, s.phase === "blocked" ? "warning" : "info");
            return;
          }
          if (action === "run") {
            if (ctx.agent.kind !== "main") throw new Error("Run SHIP from the main OMP session");
            if (!await ctx.ui.confirm("Start Ship in this OMP session?", "Dispatch ready tasks using OMP task agents? Model calls may be paid.")) return;
            const next = await startNativeRun(root, ctx.sessionManager.getSessionId(), routing(ctx));
            if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next, { deliverAs: "followUp" });
            ctx.ui.notify(next.startsWith("SHIP OMP-native") ? "SHIP native planning/task assignment sent to this OMP session." : next, next.startsWith("SHIP blocked") ? "warning" : "info");
            return;
          }
          if (action === "pause" || action === "resume") {
            await queueMessage(root, action);
            ctx.ui.notify(`Ship ${action} queued; it will take effect at a safe boundary.`, "info");
            return;
          }
          const s = await loadState(root);
          const slices = s.milestones.flatMap(m => m.slices.map(slice => ({ label: `${m.id}/${slice.id}`, slice })));
          const tasks = slices.flatMap(({ label, slice }) => slice.tasks.filter(task => task.status === "pending" && task.attempts === 0).map(task => `${label}/${task.id}`));
          const options = action === "add" ? slices.map(x => x.label) : tasks;
          if (options.length === 0) {
            ctx.ui.notify(action === "add" ? "No roadmap slices available; plan the project first." : "No unstarted, unattempted roadmap tasks available to change.", "warning");
            return;
          }
          const id = await ctx.ui.select(action === "add" ? "Add task to slice" : "Change task goal", options);
          if (!id) return;
          const fields = action === "add" ? ["title", "goal", "acceptance", "check"] as const : ["goal"] as const;
          const values: string[] = [];
          for (const field of fields) {
            const input = await ctx.ui.input(`Task ${field}`, field === "check" ? "Verification shell command" : `Enter ${field}`);
            if (input === undefined) return;
            if (!input.trim()) { ctx.ui.notify(`Task ${field} cannot be empty.`, "error"); return; }
            values.push(input.trim());
          }
          const hints: Partial<RoadmapEdit> = {};
          for (const [label, flag, placeholder] of [
            ["semantic type", "--type", "Optional: implementation, documentation, migration, ..."],
            ["uncertainty", "--uncertainty", "Optional: LOW, MEDIUM, HIGH, UNKNOWN"],
            ["prerequisites", "--depends", "Optional: comma-separated task IDs; - clears existing prerequisites"],
            ["owned files", "--files", "Optional: comma-separated paths; - clears existing files"],
            ["owned domains", "--domains", "Optional: comma-separated domains; - clears existing domains"],
            ["verification requirement", "--verify", "Optional: additional requirement; existing checks remain"],
          ]) {
            const input = await ctx.ui.input(`Task ${label}`, placeholder);
            if (input === undefined) return;
            if (input.trim()) {
              const value = input.trim();
              if (flag === "--type") Object.assign(hints, { taskType: value });
              else if (flag === "--uncertainty") Object.assign(hints, { uncertainty: value });
              else if (flag === "--verify") Object.assign(hints, { verificationRequirements: [value] });
              else Object.assign(hints, { [flag === "--depends" ? "dependencies" : flag === "--files" ? "affectedFiles" : "affectedDomains"]: value === "-" ? [] : value.split(",").map(part => part.trim()) });
            }
          }
          if (!await ctx.ui.confirm(`${action === "add" ? "Queue new task" : "Queue goal change"} for ${id}?`, `Roadmap r${s.roadmapRevision}. This request will be applied at a SHIP safe boundary only if the revision is still current.`)) return;
          const edit = action === "add"
            ? { type: "add", slice: id, title: values[0], goal: values[1], acceptance: values[2], check: values[3], revision: s.roadmapRevision, ...hints }
            : { type: "change", task: id, goal: values[0], revision: s.roadmapRevision, ...hints };
          await queueRoadmapEdit(root, edit as RoadmapEdit);
          ctx.ui.notify(`Ship ${action} request queued for ${id} at roadmap r${s.roadmapRevision}; not applied yet. SHIP will validate it at a safe boundary.`, "info");
        } catch (error) {
          ctx.ui.notify(`Ship ${action} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      },
    });
  };
}

export default createShipExtension();
