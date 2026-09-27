# Ship

A file-backed autonomous development controller using Oh My Pi (OMP) as a disposable worker. **0.2 is a tested local MVP, not yet a proven overnight-development system.**

The controller owns scheduling, verification, Git commits, recovery records, and operating limits. Fresh worker processes supply plans, code, and bounded review proposals. State is JSON; the roadmap and knowledge views are Markdown. There is no database or service dependency.

`src/controller.ts` is the reusable state machine: construct `Controller(root, worker, options)` with any `Worker`, then call `step()` or `run()`. `src/supervisor.ts` owns cancellation and an optional runtime limit around that same controller; construct `Supervisor(root, worker, { signal, maxRuntimeMs })` to run or step without the CLI. The CLI supplies OMP worker configuration, terminal signals, progress output, and exit codes.

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

`/ship` shows help; `/ship status` reads the supervisor's state through the standalone CLI. `/ship run` confirms before requesting a detached controller launch; paid model calls may follow. `/ship pause` and `/ship resume` queue safe-boundary controls. `/ship add` selects an existing slice and asks for a task title, goal, acceptance description, and executable verification command; `/ship change` updates only the goal of an unstarted, unattempted task. Both submit revision-checked roadmap edits to the supervisor inbox. They are **queued, not applied immediately**: the controller validates and applies them at its next safe boundary, or blocks with an explicit rejection reason if the revision or target has changed. While an attempt is active, edits wait until its reconciliation finishes. The extension does not run the controller internally or change `.ship/state.json` directly.

The standalone `ship` CLI remains available. For noninteractive use, `ship add --slice M001/S01 --title TITLE --goal GOAL --acceptance TEXT --check COMMAND --revision N` and `ship change --task M001/S01/T01 --goal GOAL --revision N` submit the same requests; read the current revision with `ship status --json`. Only edits to unstarted work are allowed; existing task checks and acceptance criteria cannot be weakened through `change`. A `resume` request does not itself restart a stopped controller.


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
ship add --slice M001/S01 --title TITLE --goal GOAL --acceptance TEXT --check COMMAND --revision N
ship change --task M001/S01/T01 --goal GOAL --revision N
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

## Execution-plan task metadata

Each task persists its objective (intended outcome), editable goal (implementation approach), task dependencies, descriptive acceptance and verification requirements, controller-run verification commands, known affected domains/files, semantic task type, uncertainty, complexity, risk, parallel eligibility, execution route, role-routing decision, and status. Supported semantic types include reconnaissance, planning/design, implementation, test, documentation, integration, review, and security review. The planner supplies scope and requirements; reusable SHIP core code derives classification and routing. These fields do **not** spawn parallel workers or select a model/provider; execution remains serial and acceptance still depends on controller-run checks.

Complexity is deterministic: multiple dependencies/domains, four or more affected files, high uncertainty, migration or integration mark a task `COMPLEX`; a focused known single-file documentation/test/configuration task with low uncertainty and no dependencies is `TRIVIAL`; other tasks are `STANDARD`. Risk is independent: explicit auth, secrets, destructive operations, migration/schema, persisted-data, filesystem-deletion, permissions or network/security signals in task scope or verification requirements produce `HIGH`; the migration task type itself is a risk signal. Absent signals with unknown uncertainty produce `UNKNOWN`, not an assertion of safety. Persisted rationale and signals explain the result. Neither classification nor agent descriptions replace acceptance evidence.

`execution` records `{ mode, role, reason }` plus optional `specialist` or `verificationSpecialist` intent. The independent role router uses task type, derived complexity/risk, uncertainty, scope and prerequisite count: reconnaissance uses `smol`/`scout`; obvious low-risk single-file edits stay `main`; bounded implementation uses `task`; design uses `plan`; complex high-uncertainty or multi-prerequisite work uses `slow`; independent reviews use `slow`/`reviewer` (or `security-reviewer` for security review). High-risk implementation keeps its writer role and records `verificationSpecialist: "security-reviewer"` instead of assigning security review as the writer. The role/specialist and reason are persisted and validated on reload, but they are **inspectable recommendations** in this iteration: worker dispatch does not yet consume them or start a security verification agent. OMP/user configuration, not SHIP, determines provider, model and thinking level. Parallel eligibility does not influence role selection.

Existing schema-v1 projects load safely: missing task metadata is derived in memory, without rewriting `.ship/state.json` on read; the next normal state save writes it atomically. Legacy status, attempt counts, roadmap revisions, frozen commands and recovery evidence are not reinterpreted. Unknown affected scope stays empty and uncertainty stays `UNKNOWN`.

The dependency engine validates missing, self, duplicate and cyclic edges; it produces stable topological order and levels. The controller still runs **one** ready task at a time, only after its prerequisites pass. Failed tasks remain retryable under existing budgets; descendants blocked by failed prerequisites are a derived view, not persisted `blocked` statuses. Parallel candidate pairs are recommendations only: both tasks must be ready and independent, have explicit disjoint likely-write ownership, and avoid migration, integration or shared-mutable boundaries. Unknown or ambiguous ownership yields no recommendation; no agents run concurrently.


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

OMP **18.3.2** completed a real RPC v1 execution smoke on native Windows on September 25, 2026. The run observed prompt acknowledgement, `prompt_result`, `session_settled`, final-answer retrieval, a controller-run acceptance check, and a committed source change. This is bounded compatibility evidence, not an hours-long live soak. Protocol-shaped subprocesses separately cover acknowledgement-only, malformed output, failed commands, cancellation, and unsettled sessions.

The explicitly paid/live opt-in smoke test is:

```bash
SHIP_LIVE_OMP=1 npm run smoke
```

On Windows Command Prompt, use `set SHIP_LIVE_OMP=1&& npm run smoke`. The script creates a temporary project and authorizes at most one real OMP execution dispatch. Ordinary tests never run it. Without the environment variable, it exits before starting a worker.

## Remaining MVP work

This is still a small serial planner: it produces the initial task hierarchy eagerly. Full just-in-time slice expansion, structural roadmap edits (reordering/splitting/adding milestones), parallel agent execution, user approval workflows, general diagnostic replanning, and cross-milestone knowledge retrieval are not implemented.

The next priority is a bounded unattended trial, followed by broader planning/reassessment operations. Do not treat one live smoke or the offline tests as evidence that arbitrary overnight software development is reliable.
