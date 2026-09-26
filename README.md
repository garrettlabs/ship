# Ship

A file-backed autonomous development controller using Oh My Pi (OMP) as a disposable worker. **0.3 is a tested local MVP, not yet a proven overnight-development system.**

The controller owns scheduling, verification, Git commits, recovery records, and operating limits. Fresh worker processes supply plans, code, and bounded review proposals. State is JSON; the roadmap and knowledge views are Markdown. There is no database or service dependency.

## Try the TUI without OMP or model calls

Node.js 22.6+ and Git are required. Process supervision currently supports Linux/macOS; use WSL2 rather than native Windows. The implementation and terminal interaction have been exercised on Linux, not macOS.

```bash
npm test                 # offline tests, no install or credentials needed
npm run demo             # complete a deterministic two-milestone example
npm run demo -- --tui     # watch the same example in the terminal UI
npm run demo -- --add     # propose/approve/execute an added milestone (simulated user)
npm run demo -- --tui --add  # approve the example proposal yourself in the TUI
npm run demo -- --change    # propose/approve/execute a changed task + requirement
npm run demo -- --tui --change  # inspect before/after and approve in the TUI
```

The demo creates a disposable project under your system temporary directory, prints its path, and uses an explicitly fake RPC subprocess. It tests integration, not model quality. The files and Git history remain available for inspection.

For type checking, install the pinned development-only dependencies:

```bash
npm ci
npm run check
```

## Live project workflow

OMP must be installed, on PATH, and authenticated separately. Start with a trusted project and a small brief. Worktrees share the user's filesystem and credentials: they are **not security sandboxes**.

```bash
# In a project with a committed source baseline and configured Git identity:
node --experimental-strip-types /path/to/ship/src/cli.ts init --brief ./brief.md
node --experimental-strip-types /path/to/ship/src/cli.ts doctor
node --experimental-strip-types /path/to/ship/src/cli.ts run --once

# Start a detached controller, then attach its UI:
node --experimental-strip-types /path/to/ship/src/cli.ts run --detach --max-runtime 8h
node --experimental-strip-types /path/to/ship/src/cli.ts tui
```

Alternatively, `npm link` in the Ship repository installs the `ship` command. Then `ship` without arguments opens the TUI.

`--once` includes necessary planning and bounded repairs, then stops after one accepted task. The default run continues through slice reviews and subsequent milestones until the approved plan is complete, blocked, paused, cancelled, or limited by its runtime/dispatch budget.

The controller creates one branch such as `ship/run-1234abcd` and a worktree at `.ship/worktree`. It starts from the project's committed HEAD, not uncommitted files. It never stashes your work, pushes, deploys, merges into your branch, or changes your checkout. Dependencies and ignored build files are not copied into the new worktree.

Inspect the resulting branch before merging. Worktree creation requires an initial commit and a configured Git author/committer; Ship does not invent an identity.

## Terminal controls

| Key | Action |
| --- | --- |
| `s` | Launch a detached controller; errors go to `.ship/logs/controller.log` |
| `p` / `r` | Queue pause / resume at a safe boundary |
| `c` | Capture a note; Enter submits, Escape cancels |
| `a` | Describe new requested work; Enter queues it, Escape cancels |
| `e` | Describe a change to existing work or requirements; same approval flow |
| `1` / `2` / `3` / `4` | Roadmap / knowledge / activity / work requests |
| Up / down | Scroll the selected view; proposal commands wrap instead of truncating |
| Left / right in view `4` | Select a work request |
| `y` / `x` in view `4` | Approve / reject the selected request, then `y` confirms (Escape cancels) |
| `q` or Ctrl+C | Detach the TUI without stopping the controller |

The activity panel shows controller transitions and verification outcomes, not a full OMP conversation viewer. The UI reads persisted state and never runs the scheduling loop itself. Closing the UI cannot cancel its detached controller. Ctrl+C in a **foreground `ship run`**, by contrast, cancels that run and terminates its owned worker group.

A paused controller remains alive and consumes inbox messages. After a controller has exited, queue `ship resume` and start it again with `ship run` or the TUI's `s` key. Resume does not reset retry counters or override acceptance failures.

## Commands

```text
ship init --brief <file>
ship run [--once] [--detach] [--max-runtime 8h]
ship tui
ship status [--json]
ship pause
ship resume
ship capture "<note>"
ship add "<request>"
ship change "<request>"
ship proposals [W0001] [--json]
ship approve W0001
ship reject W0001
ship recover
ship doctor
```

`init` and `doctor` make no model calls. `doctor` validates the state/configuration, Git baseline, platform, and worker executable. It does not prove authentication or RPC compatibility.

## Add work in natural language

`capture` means **information to consider**. `add` means **requested product work**. An addition is never silently treated as a lesson or automatically approved.

```bash
ship add "Add an alarm trap that attracts nearby zombies and can be triggered remotely."
# If no controller is running:
ship run --detach

# From another terminal after the planner has produced a proposal:
ship proposals
ship proposals W0001       # classification, placement, goals, acceptance, exact commands
ship approve W0001          # or: ship reject W0001
```

The controller assigns `W0001`-style request IDs when it consumes the inbox. It finishes the active task/reconciliation first, then starts a fresh OMP intake planner using the brief, current roadmap, existing approved additions, and knowledge. The planner chooses one **ADD_TASK**, **ADD_SLICE**, or **ADD_MILESTONE** patch and explains its placement. If no roadmap exists yet, the original brief is planned first. If the original project has already finished, the addition can create a follow-up milestone.

**A proposed patch waits for explicit approval before any further task or slice review is dispatched.** This keeps the target from becoming completed history while you inspect it. `ship run` keeps polling the inbox without model calls; `--once` returns `waiting` rather than running unapproved work. Additions are planned one at a time, so the next request sees the latest approved revision. Captures do not introduce an approval gate.

Commands are displayed as JSON-quoted strings so newlines and control characters remain visible. Review the proposed shell commands: approving a proposal authorizes those new checks to execute locally, alongside your protected project checks. The controller binds approval to the proposal's content fingerprint and roadmap revision, revalidates at the safe boundary, and saves the roadmap change, user provenance, application receipt, and processed inbox IDs together. Duplicate approvals and restarts cannot append the same work twice. Pausing still prevents execution even if an approval is applied.

The `add` workflow only supports additive patches; use `change` for existing work. Existing acceptance checks, IDs, completed work, and the active attempt are not rewritten. Adding to a completed slice/milestone is rejected; use a new follow-up slice in an unfinished milestone or a new milestone instead. Optional `dependsOn` values are full task keys such as `M001/S01/T01`; prerequisites must appear earlier in the serial roadmap. Missing, forward, self, and cyclic dependencies are rejected—this is not a parallel dependency scheduler.

Conflicts with explicit constraints are reported for a user decision rather than silently resolved. Conflict detection is model judgment, not a formal guarantee; inspect the proposal. A conflict or exhausted planning retry does not discard the request or rewrite the brief. For an **addition**, it allows already-approved work to proceed, then shows `waiting` if unresolved requests remain. Reject that request and submit a clarified one. The same reject/resubmit workflow applies to stale proposals; Ship never silently rebases your approval.

`add`, `proposals`, `approve`, and `reject` themselves make no model calls and never start a controller. A running controller consumes them at safe boundaries. If it exited, restart `ship run`; if paused, queue `ship resume`. Use `ship proposals --json` for the full request records. Request state persists under `workRequests` in `.ship/state.json`; planner outputs are saved in `.ship/attempts/work-W0001-1.json`. Existing 0.2 state loads with an empty request list—no database migration is needed. Do not run an older controller simultaneously against these files.

In the TUI press `a` to add work, `4` to inspect requests, and left/right to choose a request. Read its checks with up/down, then press `y` to approve or `x` to reject and `y` to confirm. Closing the TUI does not stop the waiting controller.

## Change existing work in natural language

Use **add for something new; change for something already in the project**. There are no separate requirement, priority, or milestone-editing commands.

```bash
ship change "Move trap gameplay ahead of physics polish."
ship change "M005 is too large. Split it into two smaller milestones."
ship change "Remove the pending controller-support slice from scope."
ship change "Support 48 zombies is no longer required; target 24 instead."

ship proposals             # requests share the same W0001 numbering as add
ship proposals W0002       # inspect the full before/after, checks and rationale
ship approve W0002          # or: ship reject W0002
```

`change` only queues your instruction. It does not call a model, launch the controller, edit source, or apply the request. A running controller finishes/reconciles its current attempt, asks a fresh planner for a structured patch, and waits for approval. Start `ship run` when no controller is running; a paused controller needs `ship resume` before planning/execution. TUI `e` submits a change; view `4`, `y`/`x`, and the confirmation step are shared with additions.

The planner can propose a batch of up to 30 operations:

- Edit a pending task's title, goal, acceptance criteria, checks, or dependencies; edit a pending slice's title or milestone's title/outcome.
- Reorder tasks **within their current slice**, slices **within their current milestone**, or milestones within the project.
- Cancel pending tasks, slices, or milestones. Nodes and IDs stay in the roadmap as `cancelled` tombstones; they are not marked passed and are never reused. The scheduler skips them, and the UI reports cancelled separately from passed.
- Split or replace pending work by adding newly numbered nodes, then cancelling the original in the **same atomic batch**. Dependencies must be updated or cancelled in that batch too.
- Amend an explicit requirement from the project brief, with an exact old/new passage, alongside any pending task/acceptance changes required by it.

Only **never-started, pending work** is structurally editable. Completed/cancelled/attempted tasks and their completed history remain immutable. Edits or cancellation of an entire parent require all its tasks to be unstarted. A pending task inside an active parent can still be edited. Cross-parent moves are not supported because full task keys are also evidence identities; use a pending-work replacement with fresh IDs instead. Moving pending work ahead of started history or leaving a live dependency on cancelled work is rejected.

### Approval means the exact displayed change

Before/after values and shell commands are rendered by the controller, not supplied as a model-written summary. Newlines/control characters in field values are JSON-escaped and the TUI wraps long details. Approval fingerprints include the patch, rendered preview, roadmap revision, and hashes of the roadmap, original brief and current requirement amendments. These are revalidated before application. Source/brief edits or another roadmap update invalidate approval; there is no silent rebase. The entire batch, provenance, application receipt, requirement amendments, and inbox IDs are saved together.

Changes to pending acceptance checks require your explicit approval and show a warning. They **never** modify `config.json`'s project-wide `protectedChecks`, change an active attempt's frozen checks, reset retry counters, or retroactively turn failed work into passed work. Semantic agreement between a natural-language request and a proposed patch is still model judgment: inspect the actual fields and commands before approval.

Unlike a failed/conflicting addition, an unresolved **change** (`conflict`, `failed`, or `stale`) holds the controller at `waiting`. It should not proceed with work you just asked to stop or alter. Reject it and submit a clarified `ship change`; rejection resumes the original plan. Pausing remains in force when an approval is applied.

### Requirements without hand-editing state

A requirement amendment quotes exactly one unique passage from the **current effective brief** and replaces or removes it. The controller assigns an `R0001`-style amendment ID and records the reason, user request and approved proposal. Subsequent planners, executors, and reviewers receive the amended brief. Earlier amendment records remain intact. A requirement change by itself is not a waiver of existing checks; the proposal must also address the affected pending task definitions, or report a conflict where history/protected checks prevent it.

The original `.ship/PROJECT.md` is not rewritten. `.ship/state.json` holds the ordered amendments and a hash of their original brief; `.ship/PROJECT-EFFECTIVE.md` is the generated, readable result. Use `ship change` rather than manually editing `state.json`, `ROADMAP.md`, or `PROJECT-EFFECTIVE.md`. After amendments exist, manually changing `PROJECT.md` blocks further execution instead of silently rebasing requirements; restore its original baseline and submit the intended change through this workflow. Existing requested scope outside the brief is changed through its roadmap nodes; this is not a general semantic requirements database.

### State compatibility

Ship 0.3 reads the previous schema-1 snapshots (including existing addition proposal fingerprints), then writes **schema 2** on the next controller save. New state includes cancelled statuses, change request kinds and optional requirement amendments. Stop an old controller before upgrading. Older releases reject schema 2 rather than silently skipping cancellations or amendments; downgrading an active project is unsupported. No database migration or extra user command is required.

## What this iteration implements

- One-controller lock, atomic snapshots, and independent inbox writers. A pause/capture cannot overwrite a task completion.
- Fresh, gated worker process groups. Execution starts only after ownership is recorded; losing the controller's IPC connection kills the ordinary worker group.
- Dedicated source worktree; partial changes are retained for repair rather than reset away.
- Controller-run acceptance commands with timeouts, exit codes, bounded output artifacts, and exact source-tree identity.
- Frozen checks per attempt. Empty checks, missing executables, timeout, changed source during verification, or a worker merely claiming success are not accepted.
- Commit intent before commit, followed by state finalization. Recovery recognizes a matching already-created task commit instead of creating another.
- Persistent task/planning/review/intake/dispatch limits and task failure evidence in subsequent repair prompts.
- User captures and attributed agent observations/lessons. Slice reviews can refine **unstarted task goals/implementation approaches** while preserving task IDs, acceptance commands, and completed history.
- User-requested task/slice/milestone additions with serial planning, exact-proposal approval, rejection, provenance, and stale/invalid patch protection.
- User-approved pending-work edits, ordering, cancellation, batched replacements/splits, and exact-passage requirement amendments with before/after previews.
- A detached TUI and reproducible offline demonstrations.

## State and crash behavior

```text
.ship/
  PROJECT.md           original user-owned brief (hash-bound after requirement amendments)
  PROJECT-EFFECTIVE.md  generated amended brief, when amendments exist
  config.json          user-owned limits, worker command, protected checks
  state.json           authoritative snapshot and commit intent
  ROADMAP.md           generated view
  KNOWLEDGE.md         generated, attributed knowledge view
  events.jsonl         audit only; never used to infer task completion
  attempts/            results, verification evidence, review proposals
  inbox/               independently submitted controls, captures, add/change requests, decisions
  logs/                bounded worker/check logs; controller output
  lock/                controller ownership
  process.json         owned process-group record while active
  worktree/            isolated source checkout
```

State writes use a unique temporary file, file sync, rename, and directory sync. Inbox application and processed message IDs are saved together. The audit trail can lag a committed snapshot; a truncated event-log tail cannot cause a task to rerun. Markdown views are not authoritative.

Task order is: persist attempt → execute → persist result/source snapshot → verify → persist verification and commit intent → commit → finalize task state. Task commits use `git commit-tree` plus compare-and-swap `update-ref`, intentionally bypassing commit hooks that could mutate verified files. Configure required checks in `protectedChecks`; hook-based formatting/signing is not part of this MVP's commit path.

After an abrupt controller crash, use `ship recover`, then `ship run`. Recovery refuses live or foreign-host owners and possibly live worker groups; it does not blindly kill PIDs or delete an ambiguous lock. An incomplete lock record needs manual inspection. Automatic stale-lock reclamation is intentionally not implemented.

An interrupted execution consumes an attempt and retains partial work. A recorded verification phase can rerun checks without rerunning the executor. A completed task commit is matched by tree, parent, and attempt marker before finalizing state. Unexpected edits/history or mismatched evidence block rather than guessing. Existing 0.1 in-place runs with attempted work are not automatically migrated into worktrees.

## Configuration

`config.json` contains the OMP command/arguments, startup/inactivity/hard timeouts, task-attempt and total-dispatch ceilings, `verificationTimeoutMs`, `protectedChecks`, and `review` (default true).

Counters persist across restarts. To extend an exhausted budget deliberately, edit the relevant limit, queue `ship resume`, and start the controller if it has exited. A fixed verification failure remains a failure; reviews cannot remove checks to get past it. An 8-hour runtime is a ceiling, not a promise of 8 hours of productive model work. No dollar-cost ceiling is implemented yet.

## OMP compatibility and live validation

The adapter targets the documented RPC **v1** contract: `ready`, correlated command responses, `prompt_result`, `session_settled`, and `get_last_assistant_text`. It does not mistake a prompt acknowledgement for completion or concatenate intermediate narration into the final JSON answer. Oversized/malformed frames fail explicitly; v2 chunk negotiation is not implemented.

References inspected September 25, 2026:
- https://github.com/can1357/oh-my-pi/blob/main/docs/rpc.md
- https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/modes/rpc/rpc-types.ts

The default arguments include `--no-ui`; review your OMP settings/extensions before unattended execution. Project/global OMP configuration remains relevant, and unattended dialog defaults are not a security boundary.

There was no installed/authenticated OMP in the implementation environment. **No real model session or hours-long live soak has been run.** The adapter is exercised with protocol-shaped subprocesses, including acknowledgement-only, malformed output, failed commands, cancellation, and unsettled sessions.

An explicitly paid/live opt-in smoke test is provided:

```bash
SHIP_LIVE_OMP=1 npm run smoke
```

It creates a temporary project and authorizes at most one real OMP execution dispatch. Ordinary tests never run it. Without the environment variable, the smoke script exits without starting a worker.

## Remaining MVP work

This is still a small serial planner: it produces the initial task hierarchy eagerly. Full just-in-time slice expansion, cross-parent moves and changes to attempted work, general dependency scheduling, automatic approval policies, general diagnostic replanning, and cross-milestone knowledge retrieval are not implemented.

The next priority is a real OMP smoke run and bounded unattended trial, followed by broader autonomous planning/reassessment operations. Structural changes in this version are human-requested and explicitly approved, not autonomous reviewer powers. Do not treat the offline tests as evidence that arbitrary overnight software development is reliable.
