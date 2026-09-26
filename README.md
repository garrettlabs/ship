# Ship

SHIP adds persistent planning, dependency scheduling, role routing, and verification policy to an [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) session. **OMP owns models, sessions, coding agents, tool execution, and the checkout.** SHIP does not launch its own OMP RPC workers, controller, worktree, or terminal UI.

## Install and start

Node.js 22.6+, Git, and an authenticated OMP installation are required. Install this package's dependencies with `npm ci`. From a trusted project checkout, start OMP with the SHIP extension:

```bash
omp --extension /path/to/Ship/extensions/ship.ts --cwd /path/to/project
```

Create a nonempty brief file (for example `brief.md`) containing the intended outcome and constraints; then use:

```text
/ship init     # select the brief file; creates .ship/ without model calls
/ship run      # confirm paid native OMP planning/task dispatch in this session
```

`/ship init` refuses to overwrite an existing `.ship/`, initializes Git if needed, and excludes `.ship/` from Git tracking via the repository's local exclude file. It does not create a second checkout or commit source changes. You can also run `/ship status` from a child directory of an initialized project.

A native run asks an OMP planner to submit a validated roadmap through `ship_plan`; SHIP then sends concrete assignment instructions to the main session. The main session uses OMP's task agents (or works directly when the chosen route says so) and reports each result through `ship_outcome`. SHIP independently runs declared checks before marking work passed, and schedules successors only after prerequisites pass. Review/security tasks use OMP agents as required. OMP's native session controls govern interaction; there is no `ship` production CLI or detached SHIP worker.

## Commands

| Command | Purpose |
| --- | --- |
| `/ship init` | Initialize from a brief path in the current OMP checkout; interactive confirmation and no overwrite. |
| `/ship run` | Explicitly trigger planning/ready assignments in this OMP session, or reconcile a persisted batch. Required because OMP does not autonomously start SHIP's domain scheduler. |
| `/ship add` | Queue a fully specified task in an existing slice. |
| `/ship change` | Queue a goal/planning-hint edit for an unstarted task. |
| `/ship status` | Inspect phase, revision, task count, dispatch budget usage, active batch, and blocking reason. |
| `/ship pause`, `/ship resume` | Queue safe-boundary controls. Resume also clears a blocked phase after the cause/budget is addressed; these protect SHIP's persistent scheduler, not OMP sessions. |
| `/ship recover` | Clear a dead-owner SHIP lock after confirmation. Recovery refuses a live owner; it does not kill a process or transfer another OMP session's batch. |

Add/change forms select a concrete slice/task, prompt for required fields and optional semantic type, uncertainty, dependencies, owned files/domains and verification requirements. They record the current roadmap revision. The requests are queued in `.ship/inbox/`, **not immediately applied**: `/ship run` processes them at the next safe boundary, checks revision and DAG integrity, and persists either the accepted revision or an explicit blocked reason. Running from another OMP session cannot claim an outstanding batch/planning assignment; finish it in the owning session first. A legacy standalone worktree or active standalone attempt is intentionally rejected rather than silently moved into OMP's checkout: inspect or archive the original project state, and initialize a fresh native project when appropriate.

## State, checks and recovery

```text
.ship/
  PROJECT.md          saved project brief
  config.json         native limits and verification policy
  state.json          authoritative roadmap, phase, attempts, assignments and budgets
  ROADMAP.md          generated human-readable roadmap
  EXECUTION_PLAN.json generated route and verification view
  EXECUTION_PLAN.md   generated human-readable execution plan
  KNOWLEDGE.md        generated captured knowledge view
  inbox/              queued boundary-safe user edits/controls
  events.jsonl        append-only progress/event history
  attempts/           bounded verification evidence
  lock/               short-lived SHIP state/check lock while present
```

`state.json` is an atomic snapshot. It includes a schema version and roadmap revision; load-time normalization derives current classification/routing for older task records without overwriting the original snapshot. Task IDs and dependency levels are checked as a DAG, and tasks retain objective, goal, acceptance, ownership hints, complexity/risk, OMP role decision, verification requirements, attempts, and status. `config.json` has `limits.maxTaskAttempts`, `limits.maxDispatches`, `verificationTimeoutMs`, and `protectedChecks`. Existing version-1 configs containing the obsolete `worker` and `review` fields are readable but those fields are ignored; no RPC worker is launched. Old standalone worktree/attempt metadata is retained as a diagnostic boundary rather than misinterpreted as native completion.

SHIP discovers repository checks, freezes each task's declared acceptance and routed requirements, and executes applicable shell checks with bounded time/output and process-tree supervision. Verification on Windows requires PowerShell for job-object containment and a POSIX `sh` on PATH (Git for Windows supplies one); macOS/Linux also require `sh`. Review requirements without executable commands require substantive independent OMP review evidence. Failed checks or missing reviews never become verified successes merely because an agent reports `passed`. Process supervision for verification is not an agent harness.

A crash may leave a short-lived lock; `/ship recover` is intentionally explicit and refuses a live owner. Persistent native assignments bind to their OMP session; restarting `/ship run` in that session reconciles stored progress, while a different session is told to finish outstanding work in the owner. Inspect `.ship/state.json`, events, and verification evidence to diagnose blocked work. OMP agents operate in your checkout with your normal filesystem permissions; they are **not sandboxes**.

## Development

`npm test` exercises domain planning, migrations, native extension scheduling/edits, and verification behavior; `npm run check` typechecks. No standalone worker CLI, RPC protocol fixture, or offline fake-worker demo is part of the shipped product.
