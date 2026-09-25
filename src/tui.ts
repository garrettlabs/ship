import { open } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import type { ShipState, WorkRequest } from "./types.ts";
import { loadState, queueMessage, queueWorkDecision, shipDir } from "./store.ts";
import { describeRequest } from "./work.ts";
import { tasks } from "./model.ts";

export function safe(value: unknown): string { return stripVTControlCharacters(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }
function fit(text: string, width: number) { const chars = Array.from(safe(text)); return (chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join("") + "~" : chars.join("")).padEnd(width); }
export async function tail(file: string, bytes = 16_384): Promise<string> {
  try {
    const f = await open(file, "r");
    try { const stat = await f.stat(); const size = Math.min(stat.size, bytes); const buf = Buffer.alloc(size); await f.read(buf, 0, size, stat.size - size); return buf.toString(); } finally { await f.close(); }
  } catch { return ""; }
}
export function renderDashboard(s: ShipState, activity: string[], width = 100, height = 30, view = "roadmap", offset = 0, footer?: string, selection = 0): string {
  width = Math.max(20, width); height = Math.max(10, height);
  const entries = tasks(s), passed = entries.filter(x => x.t.status === "passed").length;
  const current = entries.find(x => x.key === `${s.current?.milestoneId}/${s.current?.sliceId}/${s.current?.taskId}`);
  const lines = [
    `SHIP  |  ${s.projectName}  |  ${s.paused ? "PAUSED" : s.phase.toUpperCase()}`,
    `${passed}/${entries.length} tasks  |  ${s.dispatches ?? 0} dispatches  |  roadmap r${s.roadmapRevision}`,
    `Worktree: ${s.workspace?.branch ?? "not started"}`,
    `Current: ${current ? `${current.key} - ${current.t.title} (attempt ${current.t.attempts})` : "none"}`,
    s.blockedReason ? `BLOCKED: ${s.blockedReason}` : `Last accepted progress: ${s.lastProgressAt}`,
    "-".repeat(width),
  ];
  let rows: string[] = [];
  if (view === "knowledge") rows = (s.knowledge ?? []).flatMap(k => [`${k.id} [${k.kind}/${k.source}] ${k.text}`, `  Evidence: ${k.evidence}`]);
  else if (view === "activity") rows = activity;
  else if (view === "requests") {
    const all = s.workRequests ?? [], selected = all[Math.min(selection, Math.max(0, all.length - 1))];
    rows = selected ? [`Request ${Math.min(selection + 1, all.length)}/${all.length} | left/right selects | y approves | x rejects`, ...describeRequest(selected)] : ["No work requests yet. Press a to describe new work; s starts the controller."];
    // Unlike the roadmap, proposal detail must not hide long shell commands
    // behind truncation. Wrap every line; arrow keys reveal the full proposal.
    rows = rows.flatMap(line => { const chars = Array.from(safe(line)); const lines: string[] = []; do { lines.push(chars.splice(0, width).join("")); } while (chars.length); return lines; });
  }
  else for (const m of s.milestones) {
    rows.push(`${m.status === "complete" ? "[x]" : "[ ]"} ${m.id} ${m.title}`);
    for (const slice of m.slices) {
      rows.push(`  ${slice.status === "complete" ? "[x]" : "[ ]"} ${slice.id} ${slice.title}`);
      for (const t of slice.tasks) rows.push(`    ${t.status === "passed" ? "[x]" : t.status === "failed" ? "[!]" : t.status === "running" || t.status === "verifying" ? "[>]" : "[ ]"} ${t.id} ${t.title}`);
    }
  }
  if (!rows.length) rows.push(view === "roadmap" ? "No roadmap yet. Press s to start the controller." : "No records yet.");
  const bodyHeight = height - 9;
  const from = Math.min(offset, Math.max(0, rows.length - 1));
  const visible = rows.slice(from, from + bodyHeight);
  const split = width >= 100 && view === "roadmap";
  for (let i = 0; i < bodyHeight; i++) {
    if (split) { const left = Math.floor(width * 0.52); const right = i === 0 ? "RECENT ACTIVITY" : activity.slice(-(bodyHeight - 1))[i - 1] ?? ""; lines.push(`${fit(visible[i] ?? "", left)} | ${right}`); }
    else lines.push(visible[i] ?? "");
  }
  lines.push("-".repeat(width), "[s] start  [p] pause  [r] resume  [c] capture  [a] add  [q] detach", footer ?? `[1] roadmap  [2] knowledge  [3] activity  [4] requests  [arrows] scroll  | ${view}`);
  return lines.map(line => fit(line, width)).join("\n");
}
export async function tui(root: string, start: () => Promise<string>): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("TUI requires an interactive terminal; use ship status --json");
  await loadState(root);
  let view = "roadmap", offset = 0, selection = 0, note: string | undefined, noteType: "capture" | "add" = "capture";
  let notice = "", drawing = false, closed = false, busy = false;
  let displayed: WorkRequest | undefined;
  let confirming: { type: "approve" | "reject"; id: string; proposalId?: string } | undefined;
  emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const draw = async () => {
    if (drawing || closed) return; drawing = true;
    try {
      const s = await loadState(root);
      const records = (await tail(path.join(shipDir(root), "events.jsonl"))).split("\n").filter(Boolean);
      const activity = records.flatMap(line => { try { const e = JSON.parse(line); return [`${String(e.at).slice(11, 19)} ${e.type} ${e.task ?? e.slice ?? e.request ?? e.reason ?? ""}`]; } catch { return []; } });
      selection = Math.min(selection, Math.max(0, (s.workRequests?.length ?? 0) - 1));
      const footer = note !== undefined ? `${noteType === "add" ? "Add work" : "Capture"} (Enter submits; Esc cancels): ${note}` : confirming ? `Confirm ${confirming.type} ${confirming.id}? y confirms; Esc cancels. Review all checks first.` : notice || undefined;
      if (!closed) {
        process.stdout.write("\x1b[H" + renderDashboard(s, activity, (process.stdout.columns ?? 100) - 1, process.stdout.rows ?? 30, view, offset, footer, selection));
        displayed = view === "requests" ? s.workRequests?.[selection] : undefined;
      }
    } catch (error) { notice = String(error); } finally { drawing = false; }
  };
  await new Promise<void>(resolve => {
    const close = () => { if (closed) return; closed = true; clearInterval(timer); process.stdin.off("keypress", keypress); process.stdout.off("resize", resize); process.off("SIGTERM", close); process.off("SIGINT", close); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write("\x1b[?25h\x1b[?1049l"); resolve(); };
    const keypress = async (input: string | undefined, key: { name?: string; ctrl?: boolean } = {}) => {
      if (key.ctrl && key.name === "c") return close();
      if (busy) return;
      try {
        if (confirming) {
          if (key.name === "escape") confirming = undefined;
          else if (input === "y") {
            const decision = confirming; confirming = undefined; busy = true;
            await queueWorkDecision(root, decision.type, decision.id, decision.proposalId);
            notice = `${decision.type} queued for ${decision.id}. Start with s if the controller has exited.`;
          }
        } else if (note !== undefined) {
          if (key.name === "escape") note = undefined;
          else if (key.name === "return") { const text = note; note = undefined; busy = true; if (text.trim()) await queueMessage(root, noteType, text); notice = `${noteType === "add" ? "Work request" : "Capture"} queued. Start with s if no controller is running.`; if (noteType === "add") { view = "requests"; offset = 0; } }
          else if (key.name === "backspace") note = Array.from(note).slice(0, -1).join("");
          else if (input && !key.ctrl && input !== "\x1b" && note.length < 20_000) note += safe(input);
        } else if (input === "q") return close();
        else if (input === "p" || input === "r") { await queueMessage(root, input === "p" ? "pause" : "resume"); notice = `${input === "p" ? "Pause" : "Resume"} queued. Start with s if no controller is running.`; }
        else if (input === "c" || input === "a") { noteType = input === "a" ? "add" : "capture"; note = ""; notice = ""; }
        else if (view === "requests" && (input === "y" || input === "x")) {
          if (!displayed) throw new Error("No request selected");
          if (input === "y" && displayed.status !== "proposed") throw new Error("Only a pending proposal can be approved");
          confirming = { type: input === "y" ? "approve" : "reject", id: displayed.id, proposalId: displayed.proposal?.id };
        }
        else if (view === "requests" && (key.name === "left" || key.name === "right")) { selection = Math.max(0, selection + (key.name === "right" ? 1 : -1)); offset = 0; displayed = undefined; }
        else if (input === "s") { busy = true; notice = await start(); }
        else if (["1", "2", "3", "4"].includes(input ?? "")) { view = ({ "1": "roadmap", "2": "knowledge", "3": "activity", "4": "requests" } as Record<string, string>)[input!]; offset = 0; notice = ""; }
        else if (key.name === "down") offset++;
        else if (key.name === "up") offset = Math.max(0, offset - 1);
      } catch (error) { notice = String(error); } finally { busy = false; }
      void draw();
    };
    const resize = () => { void draw(); };
    const timer = setInterval(() => { void draw(); }, 500);
    process.stdin.on("keypress", keypress); process.stdout.on("resize", resize); process.on("SIGTERM", close); process.on("SIGINT", close);
    void draw();
  });
}
