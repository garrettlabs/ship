import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { loadState, queueMessage, queueRoadmapEdit } from "../src/store.ts";
import { initialize } from "../src/project.ts";
import { recoverLock } from "../src/lock.ts";
import { reportNativeOutcome, routeNativeSpawn, startNativeRun, submitNativePlan, type NativeOutcome } from "../src/native-execution.ts";
import type { RoadmapEdit } from "../src/types.ts";

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

const help = "Ship commands: /ship init (initialize from a project brief); /ship run (trigger native OMP planning and task dispatch); /ship add and /ship change (queue safe-boundary roadmap edits); /ship status (inspect persisted progress); /ship pause and /ship resume (safe-boundary stop/recovery); /ship recover (clear a confirmed-dead SHIP lock). OMP owns agents and sessions.";

export function createShipExtension() {
  return (api: ExtensionAPI): void => {
    const z = api.zod;
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
      description: "Submit a complete SHIP plan from the assigned OMP-native planner for validation and task scheduling.",
      parameters: z.object({ planningId: z.string(), plan: z.string() }),
      async execute(_id, params, _signal, _update, ctx) {
        try {
          if (ctx.agent.kind !== "main") throw new Error("Only the main OMP session can submit SHIP plans");
          if (!params || typeof params !== "object" || !("planningId" in params) || typeof params.planningId !== "string" ||
              !("plan" in params) || typeof params.plan !== "string") throw new Error("Invalid SHIP plan fields");
          const root = await projectRoot(ctx.cwd);
          const next = await submitNativePlan(root, ctx.sessionManager.getSessionId(), params.planningId, params.plan);
          if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next, { deliverAs: "followUp" });
          return { content: [{ type: "text", text: next }] };
        } catch (error) {
          return { content: [{ type: "text", text: `SHIP plan rejected: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
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
          const next = await reportNativeOutcome(root, ctx.sessionManager.getSessionId(), params);
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
            if (!await ctx.ui.confirm("Recover SHIP lock?", "Only recover after confirming the former OMP session is dead. Recovery will refuse a live lock owner.")) return;
            await recoverLock(root);
            ctx.ui.notify("Dead SHIP lock cleared. Use /ship run to reconcile persisted assignments.", "info");
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
            const next = await startNativeRun(root, ctx.sessionManager.getSessionId());
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
