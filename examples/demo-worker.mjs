// Deterministic OFFLINE protocol fixture. This does not invoke OMP or an LLM.
import readline from "node:readline";
import { writeFile } from "node:fs/promises";
if (process.argv.includes("--version")) { console.log("ship-offline-demo/1 (not OMP)"); process.exit(0); }
let final = "";
const send = frame => console.log(JSON.stringify(frame));
send({ type: "ready", protocolVersion: 1 });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async line => {
  const f = JSON.parse(line);
  if (f.type === "get_last_assistant_text") return send({ type: "response", id: f.id, command: f.type, success: true, data: { text: final } });
  if (f.type !== "prompt") return;
  send({ type: "response", id: f.id, command: "prompt", success: true });
  await new Promise(resolve => setTimeout(resolve, 600));
  if (f.message.includes("You are the work intake planner")) {
    const requestId = /USER REQUEST (W[0-9]+):/.exec(f.message)?.[1];
    const revision = Number(/"revision":(\d+)/.exec(f.message)?.[1]);
    // The fixture supports only this fixed example, not arbitrary planning.
    final = JSON.stringify({ requestId, revision, rationale: "Changelog is a separate follow-up outcome; preserve the greeting and documentation milestones", patch: { type: "ADD_MILESTONE", after: "M002", milestone: { id: "M003", title: "Changelog", outcome: "Delivered greeting is recorded", slices: [{ id: "S01", title: "Record delivery", tasks: [{ id: "T01", title: "Create changelog", goal: "Write CHANGELOG.md describing the greeting", acceptance: ["CHANGELOG.md describes greeting"], verificationCommands: ["grep -q 'greeting' CHANGELOG.md"], dependsOn: ["M002/S01/T01"] }] }] } } });
  } else if (f.message.includes("You are the planner")) {
    final = JSON.stringify({ milestones: [1, 2].map(n => ({ id: `M00${n}`, title: n === 1 ? "Greeting" : "Documentation", outcome: n === 1 ? "Greeting available" : "Usage documented", slices: [{ id: "S01", title: "Deliver", tasks: [{ id: "T01", title: n === 1 ? "Create greeting" : "Document greeting", goal: n === 1 ? "Write greeting.txt containing hello from ship" : "Document the greeting in README.md", acceptance: [n === 1 ? "Greeting file contains expected text" : "README describes greeting"], verificationCommands: [n === 1 ? "grep -q 'hello from ship' greeting.txt" : "grep -q 'greeting' README.md"] }] }] })) });
  } else if (f.message.includes("Review completed slice")) {
    const revision = Number(/"revision":(\d+)/.exec(f.message)?.[1]);
    final = JSON.stringify({ revision, rationale: "Reuse verified output without changing acceptance", lessons: [{ kind: "lesson", text: "A text fixture can demonstrate this controller without paid calls.", evidence: "completed task acceptance command" }], changes: f.message.includes("Review completed slice M001/") ? [{ task: "M002/S01/T01", goal: "Document the verified greeting.txt and show how to read it", reason: "reuse the delivered greeting" }] : [] });
  } else {
    const changelog = f.message.includes('"title":"Create changelog"');
    const docs = f.message.includes('"title":"Document greeting"');
    await writeFile(changelog ? "CHANGELOG.md" : docs ? "README.md" : "greeting.txt", changelog ? "# Changes\nDelivered greeting and usage documentation.\n" : docs ? "# Greeting\nRead the greeting with `cat greeting.txt`.\n" : "hello from ship\n");
    final = JSON.stringify({ summary: changelog ? "Recorded the delivered greeting" : docs ? "Documented the greeting" : "Created greeting", observations: ["Acceptance can be checked with grep."] });
  }
  send({ type: "prompt_result", id: f.id, status: "completed", sessionSettled: true });
});
rl.on("close", () => process.exit(0));
