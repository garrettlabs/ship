#!/usr/bin/env node
/** Deterministic route benchmark with optional externally captured PUBLIC OMP jev_ask results. */
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { classifyTask, type ClassificationInput } from "../src/task-classification.ts";
import { applyDecision, confidenceThreshold, derivedProfile, eligibleRoles, fallback, parseChoice, parseSemanticAnswers, semanticTaskTypes } from "../src/judgment.ts";
import { routeTask } from "../src/role-router.ts";
import type { ExecutionRole, Task, TaskType, TaskUncertainty } from "../src/types.ts";

const fixturePath = fileURLToPath(new URL("../test/fixtures/judgment-cases.json", import.meta.url));
const roles: ExecutionRole[] = ["smol", "task", "slow"];
const roleRank: Partial<Record<ExecutionRole, number>> = { smol: 0, task: 1, slow: 2 };
type Case = ClassificationInput & { id: string; taskType: TaskType; uncertainty: TaskUncertainty };
type Captured = { id: string; toolResult: unknown; latencyMs?: number; inputTokens?: number; outputTokens?: number; costUsd?: number };
type Capture = { source: "public-omp-jev-tool"; capturedAt: string; results: Captured[] };
function semanticBucket(score: number): "TRIVIAL" | "STANDARD" | "COMPLEX" {
  return score >= 7 ? "COMPLEX" : score <= 3 ? "TRIVIAL" : "STANDARD";
}

function usage(): string {
  return `Usage: node --no-warnings --experimental-strip-types scripts/benchmark-judgment.ts [--capture FILE | --simulate] [--out PREFIX]\n\nDefault: unavailable (no Jev call); --simulate: illustrative choices, NOT Jev evidence.\n--capture FILE: replay externally recorded PUBLIC OMP jev_ask tool results, no SDK/credentials.\nCapture JSON: {"source":"public-omp-jev-tool","capturedAt":"2026-09-26T12:00:00Z","results":[{"id":"bounded-implementation","toolResult":{"answers":{"bounded-implementation":{"type":"choice","choice":"task","confidence":0.9,"probabilities":{"smol":0.05,"task":0.9,"slow":0.05}}}},"latencyMs":123}]}\nUse one question ID matching each eligible fixture case ID. The public result may put answers at toolResult.answers or toolResult.details.answers. Include measured latencyMs and reported inputTokens/outputTokens/costUsd ONLY if observed; omissions are N/A. A capture asserts its provenance; the script cannot independently authenticate it. Missing captures are unavailable, not assumed outcomes. Output PREFIX.json and PREFIX.md (default: benchmark-results in current directory).\n`;
}
function parseArgs(args: string[]) {
  let capture: string | undefined, simulate = false, out = "benchmark-results";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") { console.log(usage()); process.exit(0); }
    if (args[i] === "--simulate") simulate = true;
    else if (args[i] === "--capture" || args[i] === "--out") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${args[i]} requires a value`);
      if (args[i] === "--capture") capture = args[++i]; else out = args[++i];
    } else throw new Error(`Unknown argument: ${args[i]}\n${usage()}`);
  }
  if (capture && simulate) throw new Error("--capture and --simulate are mutually exclusive");
  if (capture && [resolve(`${out}.json`), resolve(`${out}.md`)].includes(resolve(capture))) throw new Error("Capture file must not be overwritten by output artifacts");
  return { capture, simulate, out };
}
function nonnegative(value: unknown, label: string, integer = false): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid ${label}`);
  return value;
}
function taskFor(input: Case): Task {
  const classification = classifyTask(input);
  const execution = routeTask({ ...input, complexity: classification.complexity, risk: classification.risk });
  const task: Task = {
    ...input, dependencyLevel: 0, complexity: classification.complexity, risk: classification.risk,
    classificationSignals: classification.signals, classificationRationale: classification.rationale,
    parallelEligible: classification.parallelEligible, executionRoute: classification.executionRoute,
    verificationPlan: { requirements: [] }, status: "pending", attempts: 0,
    profile: { complexity: 1, uncertainty: 1, risk: 1, traits: [], rationale: [] },
    execution, routingDecision: { backend: "deterministic", role: execution.role, fallbackUsed: true, reason: "disabled" },
  };
  task.profile = derivedProfile(task, classification.rationale, classification.signals);
  return task;
}
function answerOf(result: unknown, id: string): unknown {
  if (!result || typeof result !== "object") return undefined;
  const payload = result as Record<string, unknown>;
  const details = payload.details && typeof payload.details === "object" ? payload.details as Record<string, unknown> : payload;
  const answers = details.answers;
  return answers && typeof answers === "object" ? (answers as Record<string, unknown>)[id] : undefined;
}
function assertCases(value: unknown): Case[] {
  if (!Array.isArray(value) || value.length < 8) throw new Error("Fixture must contain at least eight representative cases");
  const ids = new Set<string>();
  for (const c of value) {
    if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id || ids.has(c.id) ||
      !["LOW", "MEDIUM", "HIGH", "UNKNOWN"].includes(c.uncertainty) || !c.taskType ||
      !["title", "objective", "goal"].every(k => typeof c[k] === "string") ||
      !["acceptance", "verificationRequirements", "verificationCommands", "dependencies", "affectedDomains", "affectedFiles"].every(k => Array.isArray(c[k]) && c[k].every((v: unknown) => typeof v === "string"))) throw new Error("Invalid or duplicate fixture case");
    ids.add(c.id);
  }
  return value as Case[];
}
function asCapture(value: unknown, ids: Set<string>): Capture {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid capture");
  const capture = value as Capture;
  if (capture.source !== "public-omp-jev-tool" || typeof capture.capturedAt !== "string" || !Number.isFinite(Date.parse(capture.capturedAt)) || !Array.isArray(capture.results)) throw new Error("Capture requires public-omp-jev-tool provenance, capturedAt and results");
  const seen = new Set<string>();
  for (const r of capture.results) {
    if (!r || typeof r.id !== "string" || !ids.has(r.id) || seen.has(r.id) || !Object.hasOwn(r, "toolResult")) throw new Error("Capture has unknown, duplicate or missing-result entry");
    seen.add(r.id);
    nonnegative(r.latencyMs, `${r.id}.latencyMs`);
    nonnegative(r.inputTokens, `${r.id}.inputTokens`, true);
    nonnegative(r.outputTokens, `${r.id}.outputTokens`, true);
    nonnegative(r.costUsd, `${r.id}.costUsd`);
  }
  return capture;
}
const display = (value: number | null, unit = "") => value === null ? "N/A" : `${Number(value.toFixed(3))}${unit}`;
const ratio = (numerator: number, denominator: number) => denominator ? `${numerator}/${denominator} (${display(100 * numerator / denominator, "%")})` : "N/A (0 eligible observations)";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = assertCases(JSON.parse(await readFile(fixturePath, "utf8")));
  const captures = args.capture ? asCapture(JSON.parse(await readFile(resolve(args.capture), "utf8")), new Set(cases.map(c => c.id))) : undefined;
  const captured = new Map(captures?.results.map(r => [r.id, r]) ?? []);
  const mode = args.simulate ? "simulated" : captures ? "live" : "unavailable";
  const rows = cases.map(input => {
    const start = performance.now();
    const task = taskFor(input), baseline = task.execution;
    const baselineLatencyMs = performance.now() - start;
    const eligible = eligibleRoles(task, roles);
    // Copy this request into the public jev_ask tool; paste its result into the capture file.
    // No model pricing estimates are invented when OMP has not supplied them.
    const request = eligible.length >= 2 ? {
      state: { correlation: input.id, objective: task.objective, type: task.taskType,
        complexity: task.profile.complexity, uncertainty: task.profile.uncertainty,
        risk: Math.max(task.profile.risk, task.risk === "HIGH" ? 8 : 1),
        traits: task.profile.traits, candidates: eligible.map(role => ({ role, capability: role === "smol" ? 3 : role === "task" ? 6 : 9 })) },
      questions: { [input.id]: { type: "choice",
        instructions: "Which eligible OMP role is the lowest-cost option likely to complete this task reliably without unnecessary capability? Select only a listed role.",
        criteria: Object.fromEntries(eligible.map(role => [role, `OMP role ${role}; choose for reliable completion at minimum estimated cost`])) },
        [`${input.id}.taskType`]: { type: "choice", instructions: "Classify semantic task type. Respect the planner objective and explicit safety requirements; do not reinterpret dependencies or verification results.", criteria: Object.fromEntries(semanticTaskTypes.map(type => [type, type])) },
        [`${input.id}.complexity`]: { type: "choice", instructions: "Select task complexity 1–10 based on reasoning, coupling and scope; the planner score is authoritative as a safety floor.", criteria: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${i + 1}`, `${i + 1}`])) },
        [`${input.id}.uncertainty`]: { type: "choice", instructions: "Classify uncertainty from available task evidence. Do not erase unknown or high uncertainty from planner evidence.", criteria: Object.fromEntries(["LOW", "MEDIUM", "HIGH", "UNKNOWN"].map(value => [value, value])) },
        [`${input.id}.risk`]: { type: "choice", instructions: "Classify risk, preserving security, migration and destructive signals; SHIP enforces the deterministic risk floor.", criteria: Object.fromEntries(["LOW", "HIGH", "UNKNOWN"].map(value => [value, value])) } },
    } : null;
    const capture = captured.get(input.id);
    // Simulation is intentionally synthetic: no recorded latency, tokens, or cost.
    const simulatedRole = baseline.role === "task" ? "slow" : "task";
    const raw = args.simulate && eligible.length >= 2 ? { type: "choice", choice: simulatedRole, confidence: 0.85,
      probabilities: { [simulatedRole]: 0.85 } } : capture ? answerOf(capture.toolResult, input.id) : undefined;
    const simulatedFields = { taskType: task.taskType, complexity: String(task.profile.complexity),
      uncertainty: task.uncertainty, risk: task.risk };
    const simulatedResponse = args.simulate && eligible.length >= 2 ? { answers: Object.fromEntries(
      Object.entries(simulatedFields).map(([key, choice]) => [`${input.id}.${key}`,
        { type: "choice", choice, confidence: 0.85, probabilities: { [choice]: 0.85 } }])) } : undefined;
    const payload = capture?.toolResult;
    const response = payload && typeof payload === "object" && "details" in payload ? payload.details : payload;
    const semantic = eligible.length >= 2 && (simulatedResponse || response) ?
      parseSemanticAnswers(simulatedResponse ?? response, input.id, confidenceThreshold, task.taskType) : null;
    const semanticComparison = {
      taskType: semantic?.taskType ? { proposed: semantic.taskType.value, confidence: semantic.taskType.confidence,
        agrees: semantic.taskType.value === task.taskType } : null,
      complexity: semantic?.complexity ? { proposed: semantic.complexity.value, bucket: semanticBucket(semantic.complexity.value),
        confidence: semantic.complexity.confidence, agrees: semanticBucket(semantic.complexity.value) === task.complexity } : null,
      uncertainty: semantic?.uncertainty ? { proposed: semantic.uncertainty.value, confidence: semantic.uncertainty.confidence,
        agrees: semantic.uncertainty.value === task.uncertainty } : null,
      risk: semantic?.risk ? { proposed: semantic.risk.value, confidence: semantic.risk.confidence,
        agrees: semantic.risk.value === task.risk } : null,
      fallbacks: semantic?.fallbacks ?? null,
    };
    const parsed = raw === undefined ? undefined : parseChoice(raw, eligible, confidenceThreshold);
    const reason = eligible.length < 2 ? "ineligible-by-policy" : parsed === undefined ? "unavailable" : typeof parsed === "string" ? parsed : null;
    const decision = reason ? fallback(task, "unavailable") : parsed as Exclude<typeof parsed, string | undefined>;
    const selected = applyDecision(task, decision);
    const observed = capture !== undefined && eligible.length >= 2;
    const baseRank = roleRank[baseline.role], selectedRank = roleRank[selected.role];
    return { id: input.id, title: input.title, classification: { taskType: task.taskType, complexity: task.complexity, risk: task.risk,
      uncertainty: task.uncertainty, executionRoute: task.executionRoute, signals: task.classificationSignals },
      baseline: { mode: baseline.mode, role: baseline.role, specialist: baseline.specialist ?? null, latencyMs: baselineLatencyMs },
      request,
      semantic: semanticComparison,
      eligible, judgment: { status: reason ?? "accepted", role: reason ? null : decision.role, confidence: reason ? null : decision.confidence ?? null,
        selectedRole: selected.role, latencyMs: observed ? capture.latencyMs ?? null : null,
        inputTokens: observed ? capture.inputTokens ?? null : null, outputTokens: observed ? capture.outputTokens ?? null : null,
        costUsd: observed ? capture.costUsd ?? null : null },
      difference: reason ? null : selected.role !== baseline.role,
      escalation: reason || baseRank === undefined || selectedRank === undefined ? null : selectedRank > baseRank,
    };
  });
  const eligibleRows = rows.filter(r => r.eligible.length >= 2);
  const attempted = eligibleRows.filter(r => r.judgment.status !== "unavailable");
  const accepted = eligibleRows.filter(r => r.judgment.status === "accepted");
  const differences = accepted.filter(r => r.difference).length;
  const escalations = accepted.filter(r => r.escalation).length;
  const known = (field: "latencyMs" | "inputTokens" | "outputTokens" | "costUsd") => rows.filter(r => r.judgment[field] !== null);
  const total = (field: "inputTokens" | "outputTokens" | "costUsd") => {
    const entries = known(field);
    return entries.length === eligibleRows.length && eligibleRows.length > 0 ? entries.reduce((sum, r) => sum + (r.judgment[field] ?? 0), 0) : null;
  };
  const latencyRows = known("latencyMs");
  const semanticAgreement = Object.fromEntries((["taskType", "complexity", "uncertainty", "risk"] as const).map(field => {
    const compared = rows.filter(r => r.semantic[field] !== null);
    return [field, { observations: compared.length, agreement: ratio(compared.filter(r => r.semantic[field]?.agrees).length, compared.length) }];
  }));
  const metrics = { cases: rows.length, eligible: eligibleRows.length, captured: captured.size, attempted: attempted.length,
    accepted: accepted.length, fallback: eligibleRows.length - accepted.length, agreement: ratio(accepted.length - differences, accepted.length),
    differences: ratio(differences, accepted.length), escalation: ratio(escalations, accepted.length),
    baselineMeanLatencyMs: rows.reduce((sum, row) => sum + row.baseline.latencyMs, 0) / rows.length,
    capturedMeanLatencyMs: latencyRows.length ? latencyRows.reduce((sum, row) => sum + (row.judgment.latencyMs ?? 0), 0) / latencyRows.length : null,
    latencyObservations: latencyRows.length, inputTokens: total("inputTokens"), outputTokens: total("outputTokens"), costUsd: total("costUsd"),
    costObservations: known("costUsd").length, tokenObservations: rows.filter(r => r.judgment.inputTokens !== null && r.judgment.outputTokens !== null).length,
    semanticAgreement };
  const artifact = { mode, captureSource: captures ? { file: args.capture, declaredSource: captures.source, capturedAt: captures.capturedAt } : null,
    disclaimer: mode === "simulated" ? "Illustrative synthetic choices only; never evidence of Jev quality, savings, latency or cost." :
      mode === "live" ? "Externally supplied public OMP Jev tool capture; provenance self-declared, not authenticated. No causal quality or cost improvement inferred." :
        "Jev tool unavailable/not invoked; no Jev quality, latency, usage or cost measurements.",
    methodology: "Fixed representative fixtures; classifyTask + derivedProfile + routeTask baseline; eligibleRoles + parseChoice + applyDecision for captured role choices, deterministic fallback for missing/invalid responses. parseSemanticAnswers accepts bounded semantic answers independently of routing; semantic agreement compares accepted answers only. Benchmark role eligibility uses the deterministic classification; the production backend recomputes stricter policy gates after semantic answers, so comparisons do not predict final execution. Complexity 1–3/4–6/7–10 are comparison buckets, not SHIP's effective safety floor. Agreement/escalation denominators are accepted eligible choices only. Baseline timing is local process overhead, not task execution. Captured latency is supplied tool-call duration, not comparable to baseline process overhead. Token/cost totals are N/A unless every eligible result supplies those values.",
    metrics, cases: rows };
  const lines = [`# SHIP judgment benchmark — ${mode}`, "", artifact.disclaimer, "", `Cases: ${metrics.cases}; eligible: ${metrics.eligible}; captured: ${metrics.captured}; attempted: ${metrics.attempted}; accepted: ${metrics.accepted}; fallback: ${metrics.fallback}.`,
    `Routing agreement: ${metrics.agreement}; role differences: ${metrics.differences}; escalations: ${metrics.escalation}.`,
    `Semantic agreement (accepted answers only): ${(["taskType", "complexity", "uncertainty", "risk"] as const).map(field => `${field} ${semanticAgreement[field]?.agreement}`).join("; ")}.`,
    `Baseline route/classification mean: ${display(metrics.baselineMeanLatencyMs, " ms")} (local); captured Jev mean: ${display(metrics.capturedMeanLatencyMs, " ms")} (${metrics.latencyObservations} observations).`,
    `Jev input tokens: ${display(metrics.inputTokens)}; output tokens: ${display(metrics.outputTokens)} (${metrics.tokenObservations} complete observations); cost USD: ${display(metrics.costUsd)} (${metrics.costObservations} observations).`, "", "| Case | Deterministic classification | Jev type | Jev complexity bucket | Jev uncertainty | Jev risk | Baseline | Eligible | Judgment | Selected | Difference | Escalation | Jev latency | Cost USD |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map(r => `| ${r.id} | ${r.classification.taskType}/${r.classification.complexity}/${r.classification.uncertainty}/${r.classification.risk} | ${r.semantic.taskType?.proposed ?? "N/A"} | ${r.semantic.complexity?.bucket ?? "N/A"}${r.semantic.complexity ? ` (${r.semantic.complexity.proposed}/10)` : ""} | ${r.semantic.uncertainty?.proposed ?? "N/A"} | ${r.semantic.risk?.proposed ?? "N/A"} | ${r.baseline.role}${r.baseline.specialist ? ` (${r.baseline.specialist})` : ""} | ${r.eligible.join(", ") || "none"} | ${r.judgment.status} | ${r.judgment.selectedRole} | ${r.difference === null ? "N/A" : r.difference} | ${r.escalation === null ? "N/A" : r.escalation} | ${display(r.judgment.latencyMs, " ms")} | ${display(r.judgment.costUsd)} |`),
    "", "Agreement and escalation only describe routing choices, not task outcome or quality. Semantic columns show accepted bounded answers, not production reclassification; SHIP keeps its safety floors and may re-route. Missing/invalid capture results retain deterministic baseline. Simulated data must not be used to claim real Jev improvements.", ""];
  await writeFile(resolve(`${args.out}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
  await writeFile(resolve(`${args.out}.md`), lines.join("\n"));
  console.log(`Wrote ${resolve(`${args.out}.json`)} and ${resolve(`${args.out}.md`)} (${mode}).`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
