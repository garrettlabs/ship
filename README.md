# Ship

A file-backed development planner and controller with an OMP-native execution path. The standalone controller/CLI remains available for its separate worktree-based workflow. In OMP mode, OMP owns models, sessions, task agents, and agent tool execution; SHIP owns the plan, dependency ordering, attempts, result correlation, and verification gates. No SHIP controller CLI is started by `/ship run`.

`src/controller.ts` and `src/supervisor.ts` implement the standalone worker workflow. `src/native-execution.ts` implements OMP-native task scheduling and verification using the same persisted plan and dependency graph, with `extensions/ship.ts` providing the public extension command and structured outcome tool.

## Try the TUI without OMP or model calls

Node.js 22.6+ and Git are required. Process supervision supports Linux, macOS, and Windows. Native Windows uses Windows PowerShell (`powershell.exe`, included with Windows) to create a [kill-on-close Job Object](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) before starting each worker or check; verification commands still require a POSIX `sh` on `PATH` (Git for Windows includes one). Windows batch worker shims (`.cmd`/`.bat`, including `omp` resolved from `PATH`) accept ordinary literal arguments but reject shell metacharacters and environment expansion syntax rather than interpolate untrusted input. If a process record cannot be verified as terminated (including legacy Windows records without a job token), recovery refuses overlapping work and retains the record for manual inspection. The terminal interaction has been exercised on Linux.

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

## OMP interactive frontend

Install dependencies with `npm ci`, then start OMP from an initialized Ship project (or a child directory) with the extension loaded explicitly:

```bash
omp -e /path/to/ship/extensions/ship.ts
```

`/ship` shows help; `/ship status` reads persisted project state. On an initialized project with no plan, `/ship run` first sends a main-session instruction to delegate read-only planning through OMP and submit validated JSON via `ship_plan`; only then does it assign ready work. SHIP never spawns its controller CLI in this mode. The stored roles `smol` and `task` map to OMP's `sonic` and `task` agents; specialists use their named OMP agents. For `plan` and `slow`, the public `before_subagent_spawn` hook selects the configured OMP role alias using the assignment's stable agent name; a missing alias cannot silently pass. Main-session assignments are handled directly. Safe disjoint ready work uses one OMP task-tool batch when enabled, or concurrent eval `agent()` calls when `task.batch` is disabled. After actual work, the main session calls `ship_outcome` with persisted batch/assignment IDs, passed/failed/partial status and a concrete summary. SHIP rejects stale, duplicate, foreign-session and subagent reports. SHIP runs required verification commands before advancing successors and requests independent/security review where required. A missing integration check, missing executable checks, failed command/review, or exhausted attempt budget cannot pass.

`/ship pause` and `/ship resume` queue safe-boundary controls. `/ship add` selects a slice, gathers title, goal, acceptance text and executable check, then optional semantic type, uncertainty, prerequisites, ownership and verification requirement. `/ship change` updates an unstarted task's goal and optional hints; acceptance and executable checks cannot be replaced. Both submit revision-checked edits to the inbox. During an active native batch, queued plan edits wait until all outcomes and verification settle. An interrupted batch remains persisted with its OMP session ID and assignment IDs: reopen that session and report its outstanding results rather than rerunning the same work. A different OMP session cannot claim the batch.


For the **standalone CLI workflow**, `--once` includes planning and bounded repairs before stopping after one accepted task. The standalone controller creates its own branch and `.ship/worktree` checkout from committed HEAD; it never stashes, pushes, merges into your branch, or changes your checkout. The OMP-native extension instead executes in the initialized project's checkout, never creates a SHIP worktree, and refuses state with a standalone workspace: passing dependencies from that isolated branch are not assumed to exist in OMP's checkout. An active OMP-native assignment also prevents the standalone controller from starting.

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
ship add --slice M001/S01 --title TITLE --goal GOAL --acceptance TEXT --check COMMAND --revision N [--type TYPE] [--uncertainty LEVEL] [--depends TASK[,TASK]] [--files PATH[,PATH]] [--domains NAME[,NAME]] [--verify TEXT]
ship change --task M001/S01/T01 --goal GOAL --revision N [same optional planning hints]
ship recover
ship doctor
```

`init` and `doctor` make no model calls. `doctor` validates the state/configuration, Git baseline, platform, and worker executable. It does not prove authentication or RPC compatibility.

## Standalone controller guarantees

- One-controller lock, atomic snapshots, and independent inbox writers. A pause/capture cannot overwrite a task completion.
- Fresh, gated worker process groups. Execution starts only after ownership is recorded; losing the controller's IPC connection kills the ordinary worker group.
- Dedicated source worktree; partial changes are retained for repair rather than reset away.
- Controller-run acceptance commands with timeouts, exit codes, bounded output artifacts, and exact source-tree identity.
- Frozen checks per attempt. Empty checks, missing executables, timeout, changed source during verification, or a worker merely claiming success are not accepted.
- Commit intent before commit, followed by state finalization. Recovery recognizes a matching already-created task commit instead of creating another.
- Persistent task/planning/review/dispatch limits and task failure evidence in subsequent repair prompts.
- User captures and attributed agent observations/lessons. Slice reviews can refine **unstarted task goals/implementation approaches** while preserving task IDs, acceptance commands, and completed history.
- A detached TUI and reproducible offline demonstration.

## Execution-plan task metadata

Each task persists its editable goal/objective, prerequisites and validated DAG dependency level, acceptance and verification requirements, controller-run verification commands, known ownership domains/files, semantic task type, uncertainty, complexity, risk, parallel eligibility, execution route, role-routing decision with reason, and status. Supported semantic types include reconnaissance, planning/design, implementation, test, documentation, integration, review, and security review. Initial planning and queued additions derive classification and routing through reusable SHIP core code. Changing an unstarted goal refreshes the objective and recomputes classification, role and verification policy against the preserved acceptance/checks and any supplied planning hints; graph validation rejects missing, self, duplicate or cyclic dependencies before committing the revision. These fields do **not** spawn parallel workers or select a model/provider; execution remains serial and acceptance still depends on controller-run checks.

Complexity is deterministic: multiple dependencies/domains, four or more affected files, high uncertainty, migration or integration mark a task `COMPLEX`; a focused known single-file documentation/test/configuration task with low uncertainty and no dependencies is `TRIVIAL`; other tasks are `STANDARD`. Risk is independent: explicit auth, secrets, destructive operations, migration/schema, persisted-data, filesystem-deletion, permissions or network/security signals in task scope or verification requirements produce `HIGH`; the migration task type itself is a risk signal. Absent signals with unknown uncertainty produce `UNKNOWN`, not an assertion of safety. Persisted rationale and signals explain the result. Neither classification nor agent descriptions replace acceptance evidence.

`execution` records `{ mode, role, reason }` plus optional `specialist` or `verificationSpecialist`. These decisions are consumed by `/ship run` and its public OMP spawn hook, not hardcoded model IDs or private spawn APIs. High-risk implementation retains its writer role and requests a separate `security-reviewer` for verification.

`verificationPlan.requirements` is a separate policy for each task. SHIP executes each task's acceptance commands and configured repository checks with timeouts, exit codes, and persisted evidence before it marks a task passed; a worker's assertion alone cannot pass. Non-command independent/security review is assigned to an OMP reviewer after commands succeed; a failed review prevents passage. Non-command integration requirements without executable evidence remain failed. Protected checks also run, and a task with no executable verification commands cannot pass.


Existing schema-v1 projects load safely: missing task metadata and dependency levels are derived in memory, without rewriting `.ship/state.json` on read; the next normal state save writes them atomically. Legacy status, attempt counts, roadmap revisions, frozen commands and recovery evidence are not reinterpreted. Unknown affected scope stays empty and uncertainty stays `UNKNOWN`. The generated `.ship/EXECUTION_PLAN.json` contains the revision, DAG levels, qualified prerequisites and complete per-task planning decisions; `.ship/EXECUTION_PLAN.md` presents the same decisions for human inspection. Both views update at normal state persistence boundaries and are not authoritative over `state.json`.

The dependency graph validates edges and yields ready tasks; a successor is dispatched only after prerequisite tasks have passed verification. OMP-native batches use the graph's conservative parallel candidate pairs: every task must be ready, independent, low-risk and low-uncertainty, with explicit disjoint file/domain ownership. Otherwise only one ready task is assigned. Reports for a parallel batch are collected before verification and scheduling the next batch.


## State and crash behavior (standalone CLI unless noted)

```text
.ship/
  PROJECT.md           user-owned project brief
  config.json          user-owned limits, worker command, protected checks
  state.json           authoritative snapshot and commit intent
  ROADMAP.md           generated view
  EXECUTION_PLAN.json generated machine-readable execution plan
  EXECUTION_PLAN.md   generated human-readable execution plan
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

For OMP-native runs, `state.json` also contains `nativePlanning` and/or `nativeBatch` with session ID, roadmap revision, assignment IDs, stage and outcome statuses; `.ship/attempts/native-*.result.json` and `.verification.json` persist outcome and actual check evidence. Native state transitions share the standalone controller's project-wide filesystem lock. An interrupted batch is not automatically rerun: the same main OMP session submits outstanding results through `ship_outcome`, and `/ship run` resumes finalization when all outcomes were recorded. Failed or partial results remain visible and consume a bounded retry. If the dispatch budget prevents a required review, increasing the configured budget and queueing `/ship resume` allows that pending review to dispatch without rerunning its writer. SHIP does not infer success from a missing response or silently transfer ownership to another session.

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

OMP **18.3.2** completed a real RPC v1 execution smoke on native Windows on September 25, 2026. The run observed prompt acknowledgement, `prompt_result`, `session_settled`, final-answer retrieval, a controller-run acceptance check, and a committed source change. This is bounded compatibility evidence, not an hours-long live soak. Protocol-shaped subprocesses separately cover acknowledgement-only, malformed output, failed commands, cancellation, and unsettled sessions.

The explicitly paid/live opt-in smoke test is:

```bash
SHIP_LIVE_OMP=1 npm run smoke
```

On Windows Command Prompt, use `set SHIP_LIVE_OMP=1&& npm run smoke`. The script creates a temporary project and authorizes at most one real OMP execution dispatch. Ordinary tests never run it. Without the environment variable, it exits before starting a worker.

## Remaining MVP work

This is still a small serial planner: it produces the initial task hierarchy eagerly. Full just-in-time slice expansion, structural roadmap edits (reordering/splitting/adding milestones), parallel agent execution, user approval workflows, general diagnostic replanning, and cross-milestone knowledge retrieval are not implemented.

The next priority is a bounded unattended trial, followed by broader planning/reassessment operations. Do not treat one live smoke or the offline tests as evidence that arbitrary overnight software development is reliable.
