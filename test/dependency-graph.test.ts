import test from "node:test";
import assert from "node:assert/strict";
import { DependencyGraph } from "../src/dependency-graph.ts";
import { parsePlan } from "../src/model.ts";
import { plan } from "./helpers.ts";

function planned(dependencies: string[][], ownership: string[][] = []) {
  const raw = JSON.parse(plan());
  const template = raw.milestones[0].slices[0].tasks[0];
  raw.milestones[0].slices[0].tasks = dependencies.map((deps, index) => ({
    ...template, id: `T${String(index + 1).padStart(2, "0")}`, title: `Task ${index + 1}`,
    dependencies: deps, uncertainty: "LOW", affectedFiles: ownership[index] ?? [`src/component${index + 1}.ts`],
  }));
  return parsePlan(JSON.stringify(raw));
}

const ids = (nodes: { key: string }[]) => nodes.map(node => node.key.split("/").at(-1));

test("chain, fan-out/fan-in and multiple roots have stable topological levels and input-order ties", () => {
  const chain = new DependencyGraph(planned([["T02"], ["T03"], []]));
  assert.deepEqual(ids(chain.order), ["T03", "T02", "T01"]);
  assert.deepEqual(chain.levels.map(ids), [["T03"], ["T02"], ["T01"]]);
  const fan = new DependencyGraph(planned([["T03", "T04"], ["T03"], [], [], ["T04"]]));
  assert.deepEqual(ids(fan.order), ["T03", "T02", "T04", "T01", "T05"]);
  assert.deepEqual(fan.levels.map(ids), [["T03", "T04"], ["T01", "T02", "T05"]]);
  assert.deepEqual([...fan.dependencies.get("M001/S01/T01")!], ["M001/S01/T03", "M001/S01/T04"]);
  assert.deepEqual(ids(fan.readyTasks()), ["T03", "T04"]);
});
test("qualified edges resolve across milestones while missing, self, duplicate aliases and cycles diagnose explicitly", () => {
  const raw = JSON.parse(plan(2));
  raw.milestones[0].slices[0].tasks[0].dependencies = ["M002/S01/T01"];
  assert.deepEqual(ids(new DependencyGraph(parsePlan(JSON.stringify(raw))).order), ["T01", "T01"]);
  raw.milestones[1].slices[0].tasks[0].dependencies = ["M001/S01/T01"];
  assert.throws(() => parsePlan(JSON.stringify(raw)), /Cyclic task dependency: M001\/S01\/T01 -> M002\/S01\/T01 -> M001\/S01\/T01/);
  raw.milestones[0].slices[0].tasks[0].dependencies = ["T01"];
  raw.milestones[1].slices[0].tasks[0].dependencies = [];
  assert.throws(() => parsePlan(JSON.stringify(raw)), /Self task dependency/);
  raw.milestones[0].slices[0].tasks[0].dependencies = ["T99"];
  assert.throws(() => parsePlan(JSON.stringify(raw)), /Missing task dependency: T99/);
  raw.milestones[0].slices[0].tasks[0].dependencies = [];
  raw.milestones[1].slices[0].tasks[0].dependencies = ["T01", "M002/S01/T01"];
  assert.throws(() => parsePlan(JSON.stringify(raw)), /Self task dependency/);
  const aliases = JSON.parse(plan());
  const template = aliases.milestones[0].slices[0].tasks[0];
  aliases.milestones[0].slices[0].tasks.push({ ...template, id: "T02", dependencies: ["T01", "M001/S01/T01"] });
  assert.throws(() => parsePlan(JSON.stringify(aliases)), /Duplicate task dependency/);
});

test("failed prerequisites block descendants without persisting blocked statuses and become ready after repair", () => {
  const milestones = planned([[], ["T01"], ["T02"], []]);
  const graph = new DependencyGraph(milestones);
  const [root, child, grandchild, independent] = milestones[0].slices[0].tasks;
  root.status = "failed";
  assert.deepEqual(ids(graph.readyTasks()), ["T01", "T04"]);
  assert.deepEqual(graph.blockedTasks().map(({ key, failedAncestors }) => [key, failedAncestors]), [
    ["M001/S01/T02", ["M001/S01/T01"]], ["M001/S01/T03", ["M001/S01/T01"]],
  ]);
  assert.equal(child.status, "pending"); assert.equal(grandchild.status, "pending");
  root.status = "passed"; child.status = "failed";
  assert.deepEqual(ids(graph.readyTasks()), ["T02", "T04"]);
  assert.deepEqual(graph.blockedTasks().map(({ key }) => key), ["M001/S01/T03"]);
  child.status = "passed"; independent.status = "passed";
  assert.deepEqual(ids(graph.readyTasks()), ["T03"]);
  assert.deepEqual(graph.blockedTasks(), []);
});

test("candidate pairs require readiness, independent ancestry and disjoint known ownership", () => {
  const milestones = planned([[], [], ["T01"], ["T02"], []],
    [["src/ui"], ["src/api"], ["src/feature.ts"], ["src/other.ts"], ["src/ui/panel.ts"]]);
  const graph = new DependencyGraph(milestones);
  assert.deepEqual(graph.parallelCandidatePairs().map(pair => ids(pair)), [["T01", "T02"], ["T02", "T05"]]);
  milestones[0].slices[0].tasks[0].status = "passed";
  milestones[0].slices[0].tasks[1].status = "passed";
  assert.equal(milestones[0].slices[0].tasks[2].parallelEligible, false);
  assert.deepEqual(graph.parallelCandidatePairs().map(pair => ids(pair)), [["T03", "T04"], ["T03", "T05"], ["T04", "T05"]]);
  const unknown = planned([[], []], [[], ["src/known.ts"]]);
  unknown[0].slices[0].tasks[0].affectedDomains = [];
  assert.deepEqual(new DependencyGraph(unknown).parallelCandidatePairs(), []);
  const domains = planned([[], []], [[], []]);
  domains[0].slices[0].tasks[0].affectedDomains = ["ui/forms"];
  domains[0].slices[0].tasks[1].affectedDomains = ["ui"];
  assert.deepEqual(new DependencyGraph(domains).parallelCandidatePairs(), []);
  domains[0].slices[0].tasks[1].affectedDomains = ["api"];
  assert.deepEqual(new DependencyGraph(domains).parallelCandidatePairs().map(pair => ids(pair)), [["T01", "T02"]]);
  const risky = planned([[], []], [["src/a.ts"], ["src/b.ts"]]);
  risky[0].slices[0].tasks[0].taskType = "migration";
  assert.deepEqual(new DependencyGraph(risky).parallelCandidatePairs(), []);
  risky[0].slices[0].tasks[0].taskType = "integration";
  assert.deepEqual(new DependencyGraph(risky).parallelCandidatePairs(), []);
  risky[0].slices[0].tasks[0].taskType = "implementation";
  risky[0].slices[0].tasks[0].affectedDomains = ["shared data"];
  assert.deepEqual(new DependencyGraph(risky).parallelCandidatePairs(), []);
});

test("ambiguous ownership and migration work never become parallel candidates", () => {
  const ambiguous = planned([[], []], [["src//shared.ts"], ["src/shared.ts"]]);
  assert.deepEqual(new DependencyGraph(ambiguous).parallelCandidatePairs(), []);
  ambiguous[0].slices[0].tasks[0].affectedFiles = ["src/./shared.ts"];
  assert.deepEqual(new DependencyGraph(ambiguous).parallelCandidatePairs(), []);
  const migration = planned([[], []], [["src/legacy.ts"], ["src/new.ts"]]);
  migration[0].slices[0].tasks[0].goal = "Migrating legacy files";
  assert.deepEqual(new DependencyGraph(migration).parallelCandidatePairs(), []);
});

test("shared-mutable acceptance excludes candidates despite disjoint file ownership", () => {
  const milestones = planned([[], []], [["src/cache.ts"], ["src/ui.ts"]]);
  const [cache] = milestones[0].slices[0].tasks;
  cache.acceptance = ["Shared mutable cache state remains consistent across workers"];
  assert.deepEqual(new DependencyGraph(milestones).parallelCandidatePairs(), []);
});

test("boundaries in verification and affected files exclude otherwise independent candidates", () => {
  const milestones = planned([[], []], [["src/feature.ts"], ["src/ui.ts"]]);
  const [feature] = milestones[0].slices[0].tasks;
  const graph = new DependencyGraph(milestones);
  assert.deepEqual(graph.parallelCandidatePairs().map(pair => ids(pair)), [["T01", "T02"]]);
  feature.verificationRequirements = ["Check the integration boundary"];
  assert.deepEqual(graph.parallelCandidatePairs(), []);
  feature.verificationRequirements = ["Check the feature"];
  feature.verificationCommands = ["echo 'migration boundary'"];
  assert.deepEqual(graph.parallelCandidatePairs(), []);
  feature.verificationCommands = ["echo 'feature checked'"];
  feature.affectedFiles = ["src/shared-mutable/cache.ts"];
  assert.deepEqual(graph.parallelCandidatePairs(), []);
});

test("same-file and parent ownership overlap excludes pairs but unrelated files remain eligible", () => {
  const milestones = planned([[], [], [], []],
    [["src/shared.ts"], ["src/shared.ts"], ["src"], ["lib/other.ts"]]);
  assert.deepEqual(new DependencyGraph(milestones).parallelCandidatePairs().map(pair => ids(pair)),
    [["T01", "T04"], ["T02", "T04"], ["T03", "T04"]]);
});

test("direct and transitive prerequisites are not candidate pairs", () => {
  const milestones = planned([[], ["T01"], ["T02"], []]);
  const graph = new DependencyGraph(milestones);
  assert.deepEqual(graph.parallelCandidatePairs().map(pair => ids(pair)), [["T01", "T04"]]);
  milestones[0].slices[0].tasks[0].status = "passed";
  assert.deepEqual(graph.parallelCandidatePairs().map(pair => ids(pair)), [["T02", "T04"]]);
  milestones[0].slices[0].tasks[1].status = "passed";
  assert.deepEqual(graph.parallelCandidatePairs().map(pair => ids(pair)), [["T03", "T04"]]);
});
