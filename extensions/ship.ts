import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const MAX_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 15_000;

type CliResult = { stdout: string; stderr: string };
export type ShipCliRunner = (root: string, args: string[]) => Promise<CliResult>;

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

export const runShipCli: ShipCliRunner = (root, args) => {
  const { promise, resolve, reject } = Promise.withResolvers<CliResult>();
  const child = spawn("node", ["--no-warnings", "--experimental-strip-types", cli, ...args], {
    cwd: root, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", bytes = 0;
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
  };
  const append = (chunk: Buffer, stream: "stdout" | "stderr") => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT) { child.kill(); finish(new Error("Ship CLI output exceeded 256 KiB")); return; }
    if (stream === "stdout") stdout += chunk.toString("utf8");
    else stderr += chunk.toString("utf8");
  };
  child.stdout.on("data", chunk => append(chunk, "stdout"));
  child.stderr.on("data", chunk => append(chunk, "stderr"));
  child.once("error", error => finish(error));
  child.once("close", code => finish(code === 0 ? undefined : new Error(stderr.trim() || stdout.trim() || `Ship CLI exited with code ${code}`)));
  const timer = setTimeout(() => { child.kill(); finish(new Error(`Ship CLI timed out after ${TIMEOUT_MS / 1000}s`)); }, TIMEOUT_MS);
  return promise;
};

type RoadmapTask = { id: string; title: string; status: string; attempts: number };
type RoadmapSlice = { id: string; title: string; tasks: RoadmapTask[] };
type RoadmapMilestone = { id: string; slices: RoadmapSlice[] };
type Status = {
  projectName: string; phase: string; paused: boolean; roadmapRevision: number;
  milestones: RoadmapMilestone[]; dispatches?: number; blockedReason?: string;
  current?: { milestoneId: string; sliceId: string; taskId?: string };
};

function parseStatus(json: string): Status {
  const state: unknown = JSON.parse(json);
  if (!state || typeof state !== "object") throw new Error("Ship status is not an object");
  const s = state as Status;
  if (typeof s.projectName !== "string" || typeof s.phase !== "string" || typeof s.paused !== "boolean" ||
      !Number.isSafeInteger(s.roadmapRevision) || s.roadmapRevision < 0 || !Array.isArray(s.milestones)) {
    throw new Error("Ship status has an invalid state or roadmap revision");
  }
  return s;
}

const help = "Ship commands: /ship status (project and roadmap); /ship run (confirm and launch detached controller); /ship pause and /ship resume (queue controls); /ship add (queue a fully planned task in a slice); /ship change (queue an unstarted task goal and planning-hint change). Queued requests take effect only at a controller safe boundary.";

export function createShipExtension(execute: ShipCliRunner = runShipCli) {
  return (api: ExtensionAPI): void => {
    api.registerCommand("ship", {
      description: "Inspect and control the Ship project (/ship for help)",
      async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
        const action = args.trim() || "help";
        if (action === "help") { ctx.ui.notify(help, "info"); return; }
        if (!["status", "run", "pause", "resume", "add", "change"].includes(action)) {
          ctx.ui.notify(`Unknown Ship command: ${action}. ${help}`, "error"); return;
        }
        if (["run", "add", "change"].includes(action) && !ctx.hasUI) {
          ctx.ui.notify(`/ship ${action} requires an interactive UI.`, "error"); return;
        }
        try {
          const root = await projectRoot(ctx.cwd);
          const call = (argv: string[]) => execute(root, argv);
          const status = async () => parseStatus((await call(["status", "--json", "--compact"])).stdout);
          if (action === "status") {
            const s = await status();
            const taskCount = s.milestones.reduce((count, milestone) => count + milestone.slices.reduce((n, slice) => n + slice.tasks.length, 0), 0);
            ctx.ui.notify(`${s.projectName}: ${s.phase}${s.paused ? " (paused)" : ""}; roadmap r${s.roadmapRevision}, ${taskCount} tasks, ${s.dispatches ?? 0} dispatches${s.current ? `; current ${s.current.milestoneId}/${s.current.sliceId}${s.current.taskId ? `/${s.current.taskId}` : ""}` : ""}${s.blockedReason ? `; blocked: ${s.blockedReason}` : ""}`, s.phase === "blocked" ? "warning" : "info");
            return;
          }
          if (action === "run") {
            if (!await ctx.ui.confirm("Start Ship controller?", "Launch Ship in the background? Its workers may use paid model calls.")) return;
            const result = await call(["run", "--detach"]);
            ctx.ui.notify(result.stdout || "Ship controller launch requested; check .ship/logs/controller.log for startup errors.", "info");
            return;
          }
          if (action === "pause" || action === "resume") {
            await call([action]);
            ctx.ui.notify(`Ship ${action} queued; it will take effect at a controller safe boundary.`, "info");
            return;
          }
          const s = await status();
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
          const hints: string[] = [];
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
            if (input.trim()) hints.push(flag, input.trim());
          }
          if (!await ctx.ui.confirm(`${action === "add" ? "Queue new task" : "Queue goal change"} for ${id}?`, `Roadmap r${s.roadmapRevision}. This request will be applied at a controller safe boundary only if the revision is still current.`)) return;
          const argv = action === "add"
            ? ["add", "--slice", id, "--title", values[0], "--goal", values[1], "--acceptance", values[2], "--check", values[3], "--revision", String(s.roadmapRevision), ...hints]
            : ["change", "--task", id, "--goal", values[0], "--revision", String(s.roadmapRevision), ...hints];
          await call(argv);
          ctx.ui.notify(`Ship ${action} request queued for ${id} at roadmap r${s.roadmapRevision}; not applied yet. The controller will validate it at a safe boundary.`, "info");
        } catch (error) {
          ctx.ui.notify(`Ship ${action} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      },
    });
  };
}

export default createShipExtension();
