# Ship

SHIP adds persistent planning, dependency scheduling, role routing, and verification policy to an [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) session. **OMP owns models, sessions, coding agents, tool execution, and the checkout.** SHIP does not launch its own OMP RPC workers, controller, worktree, or terminal UI.

## Install and start

Node.js 22.6+, Git, and an authenticated OMP installation are required. For a local checkout, install development dependencies and link SHIP into OMP:

```bash
cd /path/to/Ship
npm ci
omp plugin link /path/to/Ship
```

`omp plugin install /path/to/Ship` also links a local checkout. After publication, `omp plugin install ship-autopilot` installs the npm package instead. OMP reads the package's `omp.extensions` entry (`extensions/ship.ts`); keep `package.json`'s package and `omp` versions in sync when releasing. To load directly from a development checkout without registering a plugin, start OMP from a trusted project checkout with:

```bash
omp --extension /path/to/Ship/extensions/ship.ts --cwd /path/to/project
```

The npm package includes `extensions/`, `src/`, and the verification process helpers under `src/`; it does not ship development tests or fixtures.

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
| `/ship recover` | Destructively take over dead OMP work after confirming the former session **and every worker** are dead: mark pending assignments failed, consume their attempts, transfer the batch to this session, and possibly dispatch paid repair work immediately. A review awaiting more dispatch budget remains pending; a live SHIP lock owner is refused. |

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

A crash may leave a short-lived lock; `/ship recover` is intentionally destructive and refuses a live lock owner. **Before confirming recovery, independently establish that the former OMP session and every outstanding worker have stopped**: SHIP cannot inspect OMP worker liveness or kill them. Pending native assignments become failed and consume their current attempts; recovery transfers ownership to this OMP session and can immediately schedule another paid assignment or exhaust a repair budget. Interrupted planning likewise consumes a planning attempt. A review blocked only by insufficient dispatch budget stays pending; increase `limits.maxDispatches`, then `/ship resume` and `/ship run` to dispatch its reviewer. Without recovery, restarting `/ship run` in the original session reconciles stored progress, while a different session cannot claim outstanding work. Inspect `.ship/state.json`, events, and verification evidence to diagnose blocked work. OMP agents operate in your checkout with your normal filesystem permissions; they are **not sandboxes**.

For a manual recovery smoke check, start `/ship run` with a pending assignment, stop the owning OMP session and **all** its workers, then `/ship recover` in a new session. Confirm the pending assignment is marked failed, its attempt is consumed, ownership changes, and a repair may dispatch immediately. Do not try this on live work. For a budget-blocked review, confirm recovery leaves its reviewer pending; raise the dispatch budget, `/ship resume`, then `/ship run` before reporting the completed reviewer result.

## Manual smoke

In a throwaway Git repository, write a brief describing a small feature with two independent file owners and a dependent integration task. Load SHIP with `omp --extension /path/to/Ship/extensions/ship.ts --cwd /path/to/repo`; run `/ship init` with the brief path, then `/ship run`. Check `/ship status` and `.ship/EXECUTION_PLAN.md` for routes, prerequisites, and verification requirements. Before a task starts, queue `/ship change` or `/ship add`; confirm its revision applies only at the next safe boundary. Inspect `.ship/events.jsonl` and `.ship/attempts/` for ordered dispatch and passing checks; reopen OMP and use `/ship status` to confirm persisted completion. For failures, inspect `.ship/state.json` before any confirmed-dead `/ship recover`.

## Development

`npm test` exercises domain planning, migrations, native extension scheduling/edits, and verification behavior; `npm run check` typechecks. No standalone worker CLI, RPC protocol fixture, or offline fake-worker demo is part of the shipped product.
