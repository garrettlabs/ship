import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Controller } from "../src/controller.ts";
import { FakeWorker } from "../src/fake-worker.ts";
import { atomicJson, configPath, loadState, saveState, shipDir, statePath } from "../src/store.ts";
import type { ShipConfig, ShipState } from "../src/types.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ship-test-"));
  execFileSync("git", ["init","-b","main"], {cwd:root});
  await import("node:fs/promises").then(fs=>fs.mkdir(shipDir(root),{recursive:true}));
  await writeFile(path.join(shipDir(root),"PROJECT.md"),"Build a hello file.\n");
  const now=new Date().toISOString();
  const state:ShipState={schemaVersion:1,projectName:"test",phase:"idle",roadmapRevision:0,milestones:[],paused:false,lastProgressAt:now,createdAt:now,updatedAt:now};
  const config:ShipConfig={schemaVersion:1,worker:{command:"omp",args:[],startupTimeoutMs:1000,inactivityTimeoutMs:1000,hardTimeoutMs:1000},limits:{maxTaskAttempts:2,maxDispatches:10}};
  await atomicJson(statePath(root),state); await atomicJson(configPath(root),config);
  return root;
}

const plan = JSON.stringify({milestones:[{id:"M001",title:"MVP",outcome:"hello exists",slices:[{id:"S01",title:"Hello",tasks:[{id:"T01",title:"Create hello",goal:"create hello.txt",acceptance:["hello.txt exists"],verificationCommands:["test -f hello.txt"]}]}]}]});

test("plans then executes and completes a task", async()=>{
  const root=await fixture();
  const worker=new FakeWorker([{ok:true,text:plan},{ok:true,text:"done"}]);
  const c=new Controller(root,worker);
  assert.equal(await c.step(),"progress");
  await writeFile(path.join(root,"hello.txt"),"hello\n");
  assert.equal(await c.step(),"complete");
  const s=await loadState(root); assert.equal(s.phase,"complete"); assert.equal(s.milestones[0].slices[0].tasks[0].status,"passed");
});

test("verification failure is retriable and bounded", async()=>{
  const root=await fixture();
  const worker=new FakeWorker([{ok:true,text:plan},{ok:true,text:"claimed done"},{ok:true,text:"claimed done again"}]);
  const c=new Controller(root,worker); await c.step();
  assert.equal(await c.step(),"progress");
  let s=await loadState(root); assert.equal(s.milestones[0].slices[0].tasks[0].status,"failed"); assert.equal(s.milestones[0].slices[0].tasks[0].attempts,1);
  assert.equal(await c.step(),"progress");
  s=await loadState(root); assert.equal(s.milestones[0].slices[0].tasks[0].attempts,2);
  assert.equal(await c.step(),"blocked");
});
