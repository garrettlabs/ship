# Ship

A file-backed autonomous development controller using Oh My Pi (OMP) as a disposable worker. **0.2 is a tested local MVP, not yet a proven overnight-development system.**

The controller owns scheduling, verification, Git commits, recovery records, and operating limits. Fresh worker processes supply plans, code, and bounded review proposals. State is JSON; the roadmap and knowledge views are Markdown. There is no database or service dependency.

## Try the TUI without OMP or model calls

Node.js 22.6+ and Git are required. Process supervision currently supports Linux/macOS; use WSL2 rather than native Windows. The implementation and terminal interaction have been exercised on Linux, not macOS.

```bash
npm test                 # offline tests, no install or credentials needed
npm run demo             # complete a deterministic two-milestone example
npm run demo -- --tui     # watch the same example in the terminal UI
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
| `1` / `2` / `3` | Roadmap / knowledge / activity |
| Arrow keys | Scroll the selected view |
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
ship recover
ship doctor
```

`init` and `doctor` make no model calls. `doctor` validates the state/configuration, Git baseline, platform, and worker executable. It does not prove authentication or RPC compatibility.

## What this iteration implements

- One-controller lock, atomic snapshots, and independent inbox writers. A pause/capture cannot overwrite a task completion.
- Fresh, gated worker process groups. Execution starts only after ownership is recorded; losing the controller's IPC connection kills the ordinary worker group.
- Dedicated source worktree; partial changes are retained for repair rather than reset away.
- Controller-run acceptance commands with timeouts, exit codes, bounded output artifacts, and exact source-tree identity.
- Frozen checks per attempt. Empty checks, missing executables, timeout, changed source during verification, or a worker merely claiming success are not accepted.
- Commit intent before commit, followed by state finalization. Recovery recognizes a matching already-created task commit instead of creating another.
- Persistent task/planning/review/dispatch limits and task failure evidence in subsequent repair prompts.
- User captures and attributed agent observations/lessons. Slice reviews can refine **unstarted task goals/implementation approaches** while preserving task IDs, acceptance commands, and completed history.
- A detached TUI and reproducible offline demonstration.

## State and crash behavior

```text
.ship/
  PROJECT.md           user-owned project brief
  config.json          user-owned limits, worker command, protected checks
  state.json           authoritative snapshot and commit intent
  ROADMAP.md           generated view
  KNOWLEDGE.md         generated, attributed knowledge view
  events.jsonl         audit only; never used to infer task completion
  attempts/            results, verification evidence, review proposals
  inbox/               independently submitted pause/resume/capture messages
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

This is still a small serial planner: it produces the initial task hierarchy eagerly. Full just-in-time slice expansion, structural roadmap edits (reordering/splitting/adding milestones), dependency graphs, user approval workflows, general diagnostic replanning, and cross-milestone knowledge retrieval are not implemented.

The next priority is a real OMP smoke run and bounded unattended trial, followed by broader planning/reassessment operations. Do not treat the offline tests as evidence that arbitrary overnight software development is reliable.
