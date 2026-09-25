import readline from "node:readline";
console.log(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }));
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", line => {
  const frame = JSON.parse(line);
  if (frame.type !== "prompt") return;
  console.log(JSON.stringify({ id: frame.id, type: "response", command: "prompt", success: true }));
  console.log(JSON.stringify({ type: "agent_start" }));
  console.log(JSON.stringify({ type: "message_update", messageId: "m1", assistantMessageEvent: { type: "text_delta", delta: "implemented" }, message: { role: "assistant", content: [] } }));
  console.log(JSON.stringify({ type: "agent_end", messages: [], isTerminal: true }));
  console.log(JSON.stringify({ type: "prompt_result", id: frame.id, agentInvoked: true, status: "completed", sessionSettled: false }));
  setTimeout(() => {
    console.log(JSON.stringify({ type: "session_settled" }));
  }, 30);
});
