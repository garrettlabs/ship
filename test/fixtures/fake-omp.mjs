import readline from "node:readline";
const mode = process.argv[2] ?? "normal";
if (mode === "--version") { console.log("fixture-not-omp"); process.exit(0); }
const send = frame => console.log(JSON.stringify(frame));
if (mode === "malformed") console.log("not-json");
send({ type: "ready", protocolVersion: mode === "bad-version" ? 99 : 1 });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type === "get_last_assistant_text") return send({ id: frame.id, type: "response", command: frame.type, success: true, data: { text: "final answer only" } });
  if (frame.type !== "prompt") return;
  if (mode === "error") return send({ id: frame.id, type: "response", command: "prompt", success: false, error: "Missing authentication" });
  if (mode === "local") return send({ id: frame.id, type: "response", command: "prompt", success: true, data: { agentInvoked: false } });
  send({ id: frame.id, type: "response", command: "prompt", success: true });
  if (mode === "ack-only") return;
  if (mode === "oversize") { process.stdout.write("x".repeat(1_100_000)); return; }
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "intermediate narration, not JSON" } });
  send({ type: "prompt_result", id: "unrelated-request", status: "completed", sessionSettled: true });
  send({ type: "prompt_result", id: frame.id, status: "completed", sessionSettled: false });
  setTimeout(() => send({ type: "session_settled" }), 50);
});
rl.on("close", () => process.exit(0));
