import { realpath, readdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { appendEvent, exists, loadState, queueMessage, readJson, saveState, shipDir } from "../src/store.ts";
import { bootstrap, hasExistingProject, initialize, initializeDiscovery } from "../src/project.ts";
import { git } from "../src/git.ts";
import { acquireLock, recoverLock } from "../src/lock.ts";
import { approveNativeHumanEvidence, approveNativeProposal, completeNativeJudgment, confirmNativeSpecialist, recoverNativeRun, rejectNativeProposal, reportNativeOutcome, requestNativePlan, restartNativeDiscovery, routeNativeSpawn, setNativeDiscoveryGoal, startNativeRun, submitNativeDiscovery, submitNativePlan, type NativeOutcome, type RoutingContext } from "../src/native-execution.ts";
import type { ExecutionRole, ShipState } from "../src/types.ts";
import type { RunTargetRequest } from "../src/run-target.ts";
import { formatStatus } from "../src/status.ts";
import { outputRequirements } from "../src/evidence.ts";
import { hashJudgmentRequest } from "../src/judgment.ts";
import { applyNativeReconciliation, previewNativeReconciliation } from "../src/native-reconciliation.ts";
import { pauseNativeHandoff, resumeNativeHandoff } from "../src/native-handoff.ts";

async function projectRoot(cwd: string): Promise<string> {
  let current = await realpath(cwd);
  while (true) {
    if (await exists(path.join(current, ".ship", "state.json"))) return current;
    if (await exists(path.join(current, ".ship"))) throw new Error(`Existing .ship directory in ${current} has no valid state; inspect it before proceeding`);
    if (await exists(path.join(current, ".git"))) throw new Error(`No Ship project (.ship/state.json) found above ${cwd}`);
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No Ship project (.ship/state.json) found above ${cwd}`);
    current = parent;
  }
}


function isNativeOutcome(value: unknown): value is NativeOutcome {
  if (value === null || typeof value !== "object") return false;
  if (!("batchId" in value && "assignmentId" in value && "status" in value && "summary" in value)) return false;
  return typeof value.batchId === "string" && typeof value.assignmentId === "string" &&
    (value.status === "passed" || value.status === "failed" || value.status === "partial") &&
    typeof value.summary === "string";
}

const runSyntax = "/ship run [task [M001/S01/T01] | slice [M001/S01] | milestone [M001] | all]";
const help = `Ship commands: /ship init; /ship add "request"; /ship change "request"; /ship promote; ${runSyntax} (default: first incomplete milestone; resumes saved target); /ship status [M001/S01/T01]; /ship reconcile (review Git ownership and declared checks); /ship verify M001/S01/T01 (human acceptance); /ship yolo [off]; /ship pause; /ship resume; /ship recover (confirmed-dead session).`;
const commands = [
  { name: "add", description: "Propose a new goal or roadmap work" },
  { name: "change", description: "Propose a change to the roadmap" },
  { name: "promote", description: "Promote a captured idea to a roadmap proposal" },
  { name: "run", description: "Run next task/slice/milestone or explicit stable ID, or all; default milestone" },
  { name: "status", description: "Inspect project or stable task ID" },
  { name: "verify", description: "Inspect evidence and approve human evaluation for a task" },
  { name: "reconcile", description: "Review changed repository checks or clean previously dirty files" },
  { name: "yolo", description: "Enable same-session bounded autonomy; yolo off disables" },
  { name: "pause", description: "Queue a pause at a safe boundary" },
  { name: "resume", description: "Resume blocked or paused work" },
  { name: "init", description: "Scout existing project at Git root or initialize from a brief" },
  { name: "recover", description: "Recover a confirmed-dead session (destructive)" },
  { name: "help", description: "Show all SHIP commands" },
] as const;

function runRequest(args: string[]): RunTargetRequest | undefined {
  if (!args.length) return undefined;
  if (args.length === 1 && args[0] === "all") return { scope: "all" };
  const [scope, id] = args;
  const patterns: Record<string, RegExp> = {
    task: /^M[0-9]{2,}\/S[0-9]{2,}\/T[0-9]{2,}$/,
    slice: /^M[0-9]{2,}\/S[0-9]{2,}$/,
    milestone: /^M[0-9]{2,}$/,
  };
  if (!scope || !patterns[scope] || args.length > 2 || (id !== undefined && !patterns[scope].test(id)))
    throw new Error(`Use ${runSyntax} with a fully qualified stable ID when specified`);
  return id ? { scope: scope as "task" | "slice" | "milestone", id } : { scope: scope as "task" | "slice" | "milestone" };
}
function runDescription(state: ShipState, request?: RunTargetRequest): string {
  if (request) return `${request.scope}${request.id ? ` ${request.id}` : request.scope === "all" ? " (whole roadmap)" : " (next incomplete)"}`;
  const saved = state.runTarget;
  return saved?.keys.length ? `saved ${saved.scope}${saved.id ? ` ${saved.id}` : ""}` : "default first incomplete milestone";
}

const tentative = /\b(?:maybe|perhaps|someday|later on|at some point|might|could|idea for later|not (?:yet|now)|eventually)\b/i;
async function capturedIdeas(root: string, state: ShipState): Promise<{ label: string; text: string }[]> {
  const ideas = (state.knowledge ?? []).filter(k => k.kind === "capture").map(k => ({ label: `${k.id}: ${k.text.slice(0, 100)}`, text: k.text }));
  const processed = new Set(state.processedInbox ?? []);
  const directory = path.join(shipDir(root), "inbox");
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const file of files.filter(f => f.endsWith(".json") && !processed.has(f)).sort()) {
    const message = await readJson<{ type?: string; note?: string }>(path.join(directory, file));
    if (message.type === "capture" && message.note?.trim()) ideas.push({ label: `${file.slice(0, 16)}: ${message.note.slice(0, 100)}`, text: message.note });
  }
  return ideas;
}
function previewProposal(state: ShipState): string {
  const proposal = state.pendingProposal!;
  const before = new Map<string, (typeof state.milestones)[number]["slices"][number]["tasks"][number]>(state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => [`${m.id}/${s.id}/${t.id}`, t] as const))));
  const changes = proposal.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.flatMap(task => {
    const key = `${m.id}/${s.id}/${task.id}`;
    const old = before.get(key);
    if (old && JSON.stringify([old.title, old.goal, old.acceptance, old.status, old.dependencies]) ===
        JSON.stringify([task.title, task.goal, task.acceptance, task.status, task.dependencies])) return [];
    return [`${old ? "Revised" : "New"} ${key} [${task.status}]: ${task.title}\n  Goal: ${task.goal}\n  Acceptance: ${task.acceptance.join("; ")}`];
  })));
  const after = new Set(proposal.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => `${m.id}/${s.id}/${t.id}`))));
  for (const key of before.keys()) if (!after.has(key)) changes.push(`Removed: ${key}`);
  const commands = proposal.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.flatMap(task => {
    const key = `${m.id}/${s.id}/${task.id}`;
    const approved = before.get(key)?.verificationCommands ?? [];
    return task.verificationCommands.map((command, index) =>
      `  ${key} #${index + 1} (${approved.includes(command) ? "unchanged from approved roadmap" : "planner-authored; requires explicit main-session approval"}): ${JSON.stringify(command)}`);
  })));
  return `Proposal ${proposal.id} for roadmap r${proposal.targetRevision}\nOriginal request: ${proposal.request}\nImpact: ${proposal.impactedSummary.join("; ") || "No impact summary provided"}\nChanged work (${changes.length}):\n${changes.join("\n") || "No task changes; review the milestone and future-scope impact above."}\nProposed verification shell commands (exact JSON-quoted text, including unchanged approved commands):\n${commands.join("\n") || "None; repository verification policy is reviewed separately."}\nApproval boundary: ${proposal.approvalBoundary}${proposal.futureMilestones?.length ? `\nDeferred future milestones: ${proposal.futureMilestones.map(m => m.title).join("; ")}` : ""}\nApproval alone does not dispatch; approve-and-run may incur model costs.`;
}
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
        const details = event.details as { jobs?: { id?: string; type?: string; status?: string; resultText?: string; structured?: { status?: string; data?: unknown } }[] } | undefined;
        for (const job of details?.jobs ?? []) {
          const pending = job.id ? pendingJobs.get(job.id) : undefined;
          if (!pending || pending.sessionId !== sessionId) continue;
          if (job.status === "running") continue;
          pendingJobs.delete(job.id!);
          if (job.type === "task" && job.status === "completed") {
            await confirmNativeSpecialist(pending.root, sessionId, pending.assignmentId, pending.agent,
              job.structured ? job.structured.status === "valid" ? job.structured.data : undefined : job.resultText);
          }
        }
        return;
      }
      const root = await projectRoot(ctx.cwd).catch(() => undefined);
      if (!root) return;
      const batch = (await loadState(root)).nativeBatch;
      if (!batch || batch.sessionId !== sessionId || batch.awaitingBudget) return;
      const items = taskItems(event.input);
      const details = event.details as { results?: { index?: number; id?: string; agent?: string; exitCode?: number; error?: string; aborted?: boolean; output?: string; structuredOutput?: { status?: string; data?: unknown }; extractedToolData?: Record<string, unknown[]> }[];
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
          await confirmNativeSpecialist(root, sessionId, assignmentId, result.agent!,
            result.structuredOutput ? result.structuredOutput.status === "valid" ? result.structuredOutput.data : undefined
              : result.extractedToolData?.submit_review?.at(-1) ?? result.output);
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
      name: "ship_discovery",
      label: "Review SHIP discovery",
      description: "Submit a correlated read-only project reconnaissance summary from the assigned OMP task. The user must explicitly confirm the summary before it is persisted; this tool cannot plan or execute.",
      parameters: z.object({ discoveryId: z.string(), summary: z.string() }),
      async execute(_id, params, _signal, _update, ctx) {
        try {
          if (ctx.agent.kind !== "main" || !ctx.hasUI) throw new Error("Only the interactive main OMP session can submit discovery");
          if (!params || typeof params !== "object" || !("discoveryId" in params) || typeof params.discoveryId !== "string" ||
              !("summary" in params) || typeof params.summary !== "string") throw new Error("Invalid SHIP discovery fields");
          const root = await projectRoot(ctx.cwd);
          const next = await submitNativeDiscovery(root, ctx.sessionManager.getSessionId(), params.discoveryId, params.summary,
            summary => ctx.ui.confirm("Approve read-only SHIP discovery?", `${summary}\n\nSave this summary to .ship/DISCOVERY.md? No goal or plan will be created.`));
          return { content: [{ type: "text", text: next }] };
        } catch (error) {
          return { content: [{ type: "text", text: `SHIP discovery rejected: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      },
    });
    api.registerTool({
      name: "ship_plan",
      label: "Ship execution plan",
      description: "Submit the assigned OMP planner's complete raw JSON (not Markdown/fences) for the active planningId. For initial planning use {\"milestones\":[{\"id\":\"M001\",\"title\":\"...\",\"outcome\":\"...\",\"slices\":[{\"id\":\"S01\",\"title\":\"...\",\"tasks\":[{\"id\":\"T01\",\"title\":\"...\",\"objective\":\"...\",\"goal\":\"...\",\"dependencies\":[],\"acceptance\":[\"...\"],\"affectedDomains\":[],\"affectedFiles\":[],\"taskType\":\"implementation\",\"uncertainty\":\"UNKNOWN\",\"profile\":{\"complexity\":5,\"uncertainty\":5,\"risk\":5,\"traits\":[],\"rationale\":[\"Bounded scope\"]},\"verificationRequirements\":[\"...\"],\"verificationCommands\":[\"...\"]}]}]}]}. Revisions must preserve existing work and use the revision contract in the planning instructions; do not infer a replacement roadmap from a change request. Every new task requires explicit taskType, uncertainty, numeric 1–10 profile, traits and rationale. Never submit derived route/status/attempt fields. A submitted plan is a pending proposal, NOT approval or dispatch; user reviews it with /ship run unless safe bounded YOLO policy approves it.",
      parameters: z.object({ planningId: z.string(), plan: z.string() }),
      async execute(_id, params, _signal, _update, ctx) {
        try {
          if (ctx.agent.kind !== "main") throw new Error("Only the main OMP session can submit SHIP plans");
          if (!params || typeof params !== "object" || !("planningId" in params) || typeof params.planningId !== "string" ||
              !("plan" in params) || typeof params.plan !== "string") throw new Error("Invalid SHIP plan fields");
          const root = await projectRoot(ctx.cwd);
          const next = await submitNativePlan(root, ctx.sessionManager.getSessionId(), params.planningId, params.plan, routing(ctx));
          if (ctx.hasUI && (await loadState(root)).pendingProposal?.status === "pending") ctx.ui.notify("SHIP roadmap proposal is ready. Use /ship run to review, approve, or reject it; nothing has been dispatched.", "info");
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
      description: "Record actual assignment results with concrete evidence, not intentions. For passed work include evidence for the actual behavior: commands with observed ok outcomes; independent/security reviews when required; for research/planning/documentation include artifact path, content fingerprint, acceptance fingerprint, answer and supported criterion findings. Do not fabricate evidence or claim human approval here: /ship verify is a separate user-only UI action. SHIP independently verifies required checks and reviews before marking work passed.",
      parameters: z.object({
        batchId: z.string(), assignmentId: z.string(),
        status: z.enum(["passed", "failed", "partial"]),
        summary: z.string(),
        evidence: z.object({
          acceptanceFingerprint: z.string().optional(),
          commands: z.array(z.object({ command: z.string(), ok: z.boolean() })).optional(),
          reviews: z.array(z.object({ kind: z.enum(["security-review", "independent-review"]), ok: z.boolean() })).optional(),
          research: z.object({
            path: z.string(), fingerprint: z.string(), acceptanceFingerprint: z.string(), answer: z.string(),
            findings: z.array(z.object({ criterion: z.string(), finding: z.string(), support: z.string() })),
          }).optional(),
        }).optional(),
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
      getArgumentCompletions(prefix) {
        if (/^yolo\s+o(?:f(?:f)?)?$/i.test(prefix)) return [{ label: "off", value: "yolo off", description: "Disable YOLO; require proposal approval" }];
        if (/^run(?:\s+.*)?$/i.test(prefix)) {
          const rest = prefix.slice(3).trimStart();
          if (rest && /\s/.test(rest.trim())) return null;
          return ["task", "slice", "milestone", "all"].filter(scope => scope.startsWith(rest.toLowerCase()))
            .map(scope => ({ label: scope, value: `run ${scope}${scope === "all" ? "" : " "}`, description: scope === "milestone" ? "Next incomplete milestone or explicit endpoint ID (includes earlier work)" : scope === "all" ? "Entire roadmap" : `Next incomplete ${scope} or explicit stable ID` }));
        }
        if (/\s/.test(prefix)) return null;
        const matches = commands.filter(command => command.name.startsWith(prefix.toLowerCase()))
          .map(command => ({ label: command.name, value: `${command.name} `, description: command.description }));
        return matches.length ? matches : null;
      },
      async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
        const [action = "help", ...rest] = args.trim().split(/\s+/);
        const initialRequest = rest.join(" ").trim().replace(/^(['"])(.*)\1$/, "$2");
        if (action === "help") { ctx.ui.notify(help, "info"); return; }
        if (!commands.some(command => command.name === action)) {
          ctx.ui.notify(`Unknown Ship command: ${action}. ${help}`, "error"); return;
        }
        if (["init", "run", "recover", "add", "change", "promote", "yolo", "verify", "reconcile"].includes(action) && !ctx.hasUI) {
          ctx.ui.notify(`/ship ${action} requires an interactive UI.`, "error"); return;
        }
        try {
          if (action === "init") {
            if (initialRequest) throw new Error("Use /ship init without arguments; SHIP chooses discovery or a brief automatically");
            if (ctx.agent.kind !== "main") throw new Error("Initialize SHIP from the main OMP session");
            const root = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]).catch(() => realpath(ctx.cwd));
            if (await exists(shipDir(root))) {
              const state = await loadState(root);
              if (state.discovery?.status !== "cancelled" || state.discovery.goalSet) throw new Error(".ship already exists; refusing to overwrite it");
              const next = await restartNativeDiscovery(root, ctx.sessionManager.getSessionId());
              api.sendUserMessage(next);
              ctx.ui.notify("SHIP discovery restarted; awaiting read-only OMP research.", "info");
              return;
            }
            if (await hasExistingProject(root)) {
              const next = await initializeDiscovery(root, ctx.sessionManager.getSessionId());
              api.sendUserMessage(next);
              ctx.ui.notify("SHIP · read-only discovery started. Review its summary before approving; no goal or plan has been created.", "info");
              return;
            }
            const brief = await ctx.ui.input("Project brief", "Path to a nonempty brief file in this checkout");
            if (brief === undefined) return;
            if (!brief.trim()) throw new Error("Project brief path cannot be empty");
            if (!await ctx.ui.confirm("Initialize SHIP?", `Use ${brief.trim()} as the project brief in ${root}? Existing .ship state will not be overwritten.`)) return;
            await initialize(root, brief.trim());
            ctx.ui.notify("SHIP initialized. Use /ship run to plan and dispatch tasks in this OMP session.", "info");
            return;
          }
          let root: string;
          try { root = await projectRoot(ctx.cwd); }
          catch (error) {
            if (!["add", "change"].includes(action) || !(error instanceof Error) || !error.message.startsWith("No Ship project")) throw error;
            root = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]).catch(() => realpath(ctx.cwd));
            if (await exists(shipDir(root))) throw new Error("Existing .ship directory has no valid state; inspect it before adopting this repository");
            if (ctx.agent.kind !== "main") throw new Error("Adopt a project from the main OMP session");
            const request = initialRequest || await ctx.ui.input("What should SHIP change?", "Describe the requested change in this existing project");
            if (request === undefined) return;
            if (!request.trim()) throw new Error("A change request is required to start planning");
            ctx.ui.notify("SHIP · learning project", "info");
            await bootstrap(root, request);
            if (tentative.test(request)) {
              const choice = await ctx.ui.select("Tentative request", ["Plan this request now", "Capture for later", "Cancel"]);
              if (choice === "Capture for later") {
                await queueMessage(root, "capture", request);
                ctx.ui.notify("Idea captured. Use /ship promote when ready to plan it.", "info");
                return;
              }
              if (choice !== "Plan this request now") return;
            }
            const next = await requestNativePlan(root, ctx.sessionManager.getSessionId(), request, action === "add" ? "add" : "change", routing(ctx));
            if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next);
            ctx.ui.notify(next.startsWith("SHIP OMP-native") ? "SHIP · project profile ready; planning change. Review the proposal with /ship run." : next, next.startsWith("SHIP blocked") ? "warning" : "info");
            return;
          }
          const discoveryState = (action === "add" || action === "change") ? (await loadState(root)).discovery : undefined;
          if (discoveryState && !discoveryState.goalSet) {
            if (ctx.agent.kind !== "main") throw new Error("Set a discovery goal from the main OMP session");
            const request = initialRequest || await ctx.ui.input("What should SHIP change?", "Provide an explicit goal; discovery did not infer one");
            if (request === undefined) return;
            if (!request.trim()) throw new Error("An explicit goal is required");
            if (tentative.test(request)) {
              const choice = await ctx.ui.select("Tentative request", ["Plan this request now", "Capture for later", "Cancel"]);
              if (choice === "Capture for later") {
                await queueMessage(root, "capture", request);
                ctx.ui.notify("Idea captured. Use /ship promote when ready to plan it.", "info");
                return;
              }
              if (choice !== "Plan this request now") return;
            }
            await setNativeDiscoveryGoal(root, request);
            const next = await startNativeRun(root, ctx.sessionManager.getSessionId(), routing(ctx));
            if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next);
            ctx.ui.notify(next.startsWith("SHIP OMP-native") ? "SHIP explicit goal set; planning change." : next, next.startsWith("SHIP blocked") ? "warning" : "info");
            return;
          }
          if (action === "recover") {
            if (ctx.agent.kind !== "main") throw new Error("Recover SHIP from the main OMP session");
            if (!await ctx.ui.confirm("Recover confirmed-dead OMP work?", "Only continue after confirming the former OMP session AND every outstanding worker are dead; SHIP cannot inspect OMP worker liveness. Pending discovery research is reassigned with a new ID, without creating a goal or plan. Pending task assignments will be marked failed, their paid attempts consumed, and the batch transferred to this session; recovery may immediately dispatch another paid assignment. A budget-blocked review remains pending. Recovery refuses a live SHIP lock owner.")) return;
            if (await exists(path.join(shipDir(root), "lock"))) await recoverLock(root);
            const next = await recoverNativeRun(root, ctx.sessionManager.getSessionId(), routing(ctx));
            if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next);
            ctx.ui.notify(next.startsWith("SHIP OMP-native discovery") ? "SHIP recovered read-only discovery; awaiting research in this OMP session." : next.startsWith("SHIP OMP-native") ? "SHIP recovered dead work and sent the next assignment to this OMP session." : next, next.startsWith("SHIP blocked") ? "warning" : "info");
            return;
          }
          if (action === "status") {
            const state = await loadState(root, { readOnly: true });
            ctx.ui.notify(await formatStatus(root, state, initialRequest || undefined), state.phase === "blocked" ? "warning" : "info");
            return;
          }
          if (action === "reconcile") {
            if (initialRequest) throw new Error("Use /ship reconcile without arguments");
            if (ctx.agent.kind !== "main") throw new Error("Only the interactive main OMP session may reconcile ownership or checks");
            const preview = await previewNativeReconciliation(root);
            const choices: string[] = [];
            if (preview.checks.changes.length) choices.push("Review changed verification commands");
            if (preview.ownership?.eligiblePaths.length) choices.push("Review previously dirty paths now clean");
            if (!choices.length) {
              ctx.ui.notify("No changed repository checks or eligible clean ownership paths to reconcile.", "info");
              return;
            }
            choices.push("Cancel");
            const choice = await ctx.ui.select("Reconcile project observations", choices);
            if (!choice || choice === "Cancel") return;
            let next: string;
            if (choice === "Review changed verification commands") {
              const changes = preview.checks.changes.map(change =>
                `${change.type}: ${change.before?.kind ?? ""} ${change.before?.command ?? ""} → ${change.after?.kind ?? ""} ${change.after?.command ?? ""}\n  Before: ${JSON.stringify({ source: change.before?.source, runner: change.before?.runner, definition: change.before?.definition, fingerprint: change.before?.fingerprint })}\n  After: ${JSON.stringify({ source: change.after?.source, runner: change.after?.runner, definition: change.after?.definition, fingerprint: change.after?.fingerprint })}`);
              const message = `${changes.join("\n")}\nPackage policy fingerprints cover other package scripts and lifecycle hooks in addition to the displayed selected script body; review package.json for fingerprint-only changes.\nAffected tasks: ${preview.checks.affectedTaskKeys.join(", ") || "none"}\n${preview.checks.evidenceInvalidation}`;
              if (!await ctx.ui.confirm("Approve repository verification-policy change?", message)) return;
              next = await applyNativeReconciliation(root, ctx.sessionManager.getSessionId(), preview, { kind: "checks" });
            } else {
              const eligible = preview.ownership!.eligiblePaths;
              const message = `Previously dirty paths now clean:\n${eligible.join("\n")}\nStill dirty (remain user-owned):\n${preview.ownership!.stillDirtyPaths.join("\n") || "none"}\nBranch: ${preview.ownership!.branch}; HEAD: ${preview.ownership!.head ?? "unknown"}. Confirm only after reviewing these paths; SHIP rechecks Git state before applying.`;
              if (!await ctx.ui.confirm("Release clean paths from user-owned guard?", message)) return;
              next = await applyNativeReconciliation(root, ctx.sessionManager.getSessionId(), preview, { kind: "ownership", paths: eligible });
            }
            ctx.ui.notify(next, "info");
            return;
          }
          if (action === "verify") {
            if (ctx.agent.kind !== "main") throw new Error("Only the interactive main OMP session may approve human evidence");
            if (!/^[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(initialRequest)) throw new Error("Use /ship verify M001/S01/T01 with a stable task ID");
            const state = await loadState(root);
            const task = state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t => ({ key: `${m.id}/${s.id}/${t.id}`, task: t })))).find(entry => entry.key === initialRequest)?.task;
            if (!task) throw new Error(`Unknown task ID: ${initialRequest}`);
            if (!outputRequirements(task).includes("human-evaluation")) throw new Error("This task does not require human evaluation");
            if (task.status !== "verifying") throw new Error("Human review is only available while this task awaits verification");
            const evidence = task.evidence;
            if (!evidence) throw new Error("No persisted evidence is available for human review");
            const summary = [
              `${initialRequest}: ${task.title}`,
              `Goal: ${task.goal}`,
              `Acceptance:\n${task.acceptance.map(item => `- ${item}`).join("\n")}`,
              `Evidence fingerprint: ${evidence.acceptanceFingerprint ?? "missing"}`,
              `Commands:\n${evidence.commands?.map(item => `- ${item.ok ? "passed" : "failed"}: ${item.command}`).join("\n") || "none"}`,
              `Reviews:\n${evidence.reviews?.map(item => `- ${item.ok ? "passed" : "failed"}: ${item.kind}`).join("\n") || "none"}`,
              `Research: ${evidence.research ? `${evidence.research.path}\n${evidence.research.answer}\n${evidence.research.findings.map(item => `- ${item.criterion}: ${item.finding} (${item.support})`).join("\n")}` : "none"}`,
            ].join("\n\n");
            if (!await ctx.ui.confirm("Approve human evaluation?", `${summary}\n\nOnly approve if you personally checked the evidence against every acceptance criterion. This cannot be delegated to an agent.`)) return;
            const next = await approveNativeHumanEvidence(root, ctx.sessionManager.getSessionId(), initialRequest);
            if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next, { deliverAs: "followUp" });
            ctx.ui.notify(next, next.startsWith("SHIP blocked") ? "warning" : "info");
            return;
          }
          if (action === "yolo") {
            if (ctx.agent.kind !== "main") throw new Error("Change autonomy from the main OMP session");
            if (initialRequest && initialRequest !== "off") throw new Error("Use /ship yolo or /ship yolo off");
            const enabled = !initialRequest;
            const unlock = await acquireLock(root);
            try {
              const state = await loadState(root);
              state.autonomy = enabled ? "yolo" : "supervised";
              if (enabled) state.autonomySessionId = ctx.sessionManager.getSessionId();
              else delete state.autonomySessionId;
              await saveState(root, state);
              await appendEvent(root, { type: "autonomy", mode: state.autonomy, sessionId: ctx.sessionManager.getSessionId() });
            } finally { await unlock(); }
            ctx.ui.notify(enabled ? "SHIP YOLO enabled for this session only. Safety, approval and verification gates still apply." : "SHIP YOLO disabled; proposals require explicit approval.", "info");
            return;
          }
          if (action === "run") {
            const request = runRequest(rest);
            if (ctx.agent.kind !== "main") throw new Error("Run SHIP from the main OMP session");
            const state = await loadState(root);
            const pending = state.pendingProposal;
            let next: string;
            if (pending?.status === "pending") {
              const choice = await ctx.ui.select(`${previewProposal(state)}\n\nRequested run: ${runDescription(state, request)}. Approve only saves this target; it does not dispatch.`, ["Approve and run", "Approve only", "Reject", "Cancel"]);
              if (!choice || choice === "Cancel") return;
              if (choice === "Reject") {
                const reason = await ctx.ui.input("Why reject this proposal?", "Explain the required correction or decision");
                if (reason === undefined) return;
                if (!reason.trim()) throw new Error("A rejection reason is required");
                next = await rejectNativeProposal(root, ctx.sessionManager.getSessionId(), reason.trim());
              } else {
                const reviewed = previewProposal(state);
                const approvedCommands = new Map(state.milestones.flatMap(m => m.slices.flatMap(s => s.tasks.map(t =>
                  [`${m.id}/${s.id}/${t.id}`, t.verificationCommands] as const))));
                const introducedCommands = pending.milestones.some(m => m.slices.some(s => s.tasks.some(t =>
                  t.verificationCommands.some(command => !approvedCommands.get(`${m.id}/${s.id}/${t.id}`)?.includes(command)))));
                if ((pending.approvalBoundary === "explicit" || introducedCommands) &&
                    !await ctx.ui.confirm(introducedCommands ? "Approve exact planner-authored shell commands?" : "Confirm consequential roadmap change?",
                      `${reviewed}\n\n${introducedCommands ? "These planner-authored verification commands may execute as shell text. Confirm their exact text and provenance before applying." : "This proposal crosses an explicit approval boundary. Confirm acceptance before applying it."}`)) return;
                next = await approveNativeProposal(root, ctx.sessionManager.getSessionId(), choice === "Approve and run", routing(ctx), JSON.stringify(pending), request);
              }
            } else {
              if (!await ctx.ui.confirm("Start Ship in this OMP session?", `Target: ${runDescription(state, request)}. Plan or dispatch approved ready tasks using OMP task agents? Model calls may be paid.`)) return;
              next = await startNativeRun(root, ctx.sessionManager.getSessionId(), routing(ctx), request);
            }
            if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next);
            ctx.ui.notify(next.startsWith("SHIP OMP-native") ? "SHIP native planning/task assignment sent to this OMP session." : next, next.startsWith("SHIP blocked") ? "warning" : "info");
            return;
          }
          if (action === "pause" || action === "resume") {
            if (initialRequest) throw new Error(`Use /ship ${action} without arguments`);
            if (ctx.agent.kind !== "main") throw new Error("Only the main OMP session may control SHIP execution");
            const message = action === "pause"
              ? await pauseNativeHandoff(root, ctx.sessionManager.getSessionId())
              : await resumeNativeHandoff(root, ctx.sessionManager.getSessionId());
            ctx.ui.notify(message, message.includes("no transferable") ? "warning" : "info");
            return;
          }
          if (ctx.agent.kind !== "main") throw new Error("Plan SHIP changes from the main OMP session");
          let request = initialRequest;
          if (action === "promote") {
            if (request) throw new Error("Use /ship promote without arguments; select a captured idea");
            const ideas = await capturedIdeas(root, await loadState(root));
            if (!ideas.length) { ctx.ui.notify("No captured ideas to promote. Use /ship add or /ship change with a request.", "warning"); return; }
            const selected = await ctx.ui.select("Promote captured idea to a roadmap proposal", ideas.map(idea => idea.label));
            if (!selected) return;
            request = ideas.find(idea => idea.label === selected)!.text;
          } else if (!request) {
            const input = await ctx.ui.input("What should SHIP plan?", "Describe the goal or change in your own words");
            if (input === undefined) return;
            request = input.trim();
          }
          if (!request.trim()) throw new Error("A request is required to start planning");
          if (action !== "promote" && tentative.test(request)) {
            const choice = await ctx.ui.select("Tentative request", ["Plan this request now", "Capture for later", "Cancel"]);
            if (choice === "Capture for later") {
              await queueMessage(root, "capture", request);
              ctx.ui.notify("Idea captured. Use /ship promote when ready to plan it.", "info");
              return;
            }
            if (choice !== "Plan this request now") return;
          }
          const latest = await loadState(root);
          if (latest.discovery && !latest.discovery.goalSet) {
            await setNativeDiscoveryGoal(root, request);
            const next = await startNativeRun(root, ctx.sessionManager.getSessionId(), routing(ctx));
            if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next);
            ctx.ui.notify(next.startsWith("SHIP OMP-native") ? "Captured idea promoted to the project goal. Review the resulting plan with /ship run." : next,
              next.startsWith("SHIP blocked") ? "warning" : "info");
            return;
          }
          const next = await requestNativePlan(root, ctx.sessionManager.getSessionId(), request, action === "change" ? "change" : "add", routing(ctx));
          if (next.startsWith("SHIP OMP-native")) api.sendUserMessage(next);
          ctx.ui.notify(next.startsWith("SHIP OMP-native") ? "SHIP planner launched. Review the resulting proposal with /ship run before dispatch." : next,
            next.startsWith("SHIP blocked") ? "warning" : "info");
        } catch (error) {
          ctx.ui.notify(`Ship ${action} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      },
    });
  };
}

export default createShipExtension();
