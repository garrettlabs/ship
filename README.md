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

In an existing repository, start OMP with SHIP enabled and request the change directly:

```text
/ship add "add password reset"
# or /ship change "update the existing password reset flow"
```

The first add/change automatically adopts the current Git checkout, discovers project conventions and declared checks, persists minimal `.ship/` state, and sends the requested change to the OMP-native planner. Without inline text SHIP asks for the request once. No initialization wizard or project restructuring is required. Later `/ship add` and `/ship change` retain their precise roadmap-edit forms. `/ship run` explicitly resumes planning or dispatch. `/ship init` remains optional for a brief-file workflow: it refuses to overwrite `.ship/`, initializes Git if needed, and excludes `.ship/` from local Git tracking. `/ship status` works from a nested directory.

A native run asks an OMP planner to submit a validated roadmap through `ship_plan`; SHIP then sends concrete assignment instructions to the main session. The main session uses OMP's task agents (or works directly when the chosen route says so) and reports each result through `ship_outcome`. SHIP independently runs declared checks before marking work passed, and schedules successors only after prerequisites pass. Review/security tasks use OMP agents as required. OMP's native session controls govern interaction; there is no `ship` production CLI or detached SHIP worker.

## Commands

| Command | Purpose |
| --- | --- |
| `/ship init` | Optional brief-file initialization; interactive confirmation and no overwrite. |
| `/ship run` | Explicitly trigger planning/ready assignments in this OMP session, or reconcile a persisted batch. Required because OMP does not autonomously start SHIP's domain scheduler. |
| `/ship add "request"` | On first use, adopt the existing checkout and plan this request; with a roadmap, queue a fully specified task in an existing slice. |
| `/ship change "request"` | On first use, adopt and plan a change to existing code; with a roadmap, queue a goal/planning-hint edit for an unstarted task. |
| `/ship status` | Inspect phase, revision, task count, dispatch budget usage, active batch, and blocking reason. |
| `/ship pause`, `/ship resume` | Queue safe-boundary controls. Resume also clears a blocked phase after the cause/budget is addressed; these protect SHIP's persistent scheduler, not OMP sessions. |
| `/ship recover` | Destructively take over dead OMP work after confirming the former session **and every worker** are dead: mark pending assignments failed, consume their attempts, transfer the batch to this session, and possibly dispatch paid repair work immediately. A review awaiting more dispatch budget remains pending; a live SHIP lock owner is refused. |

Add/change forms select a concrete slice/task, prompt for required fields and optional semantic type, uncertainty, dependencies, owned files/domains and verification requirements. They record the current roadmap revision. The requests are queued in `.ship/inbox/`, **not immediately applied**: `/ship run` processes them at the next safe boundary, checks revision and DAG integrity, and persists either the accepted revision or an explicit blocked reason. Running from another OMP session cannot claim an outstanding batch/planning assignment; finish it in the owning session first. A legacy standalone worktree or active standalone attempt is intentionally rejected rather than silently moved into OMP's checkout: inspect or archive the original project state, and initialize a fresh native project when appropriate.

### Optional OMP Jev role judgments

SHIP defaults to deterministic routing. To opt into bounded Jev judgments for a project, install/enable the existing `@jev-harness/omp` extension in OMP and set `.ship/config.json`'s `judgment` to `{ "enabled": true, "confidenceThreshold": 0.7, "timeoutMs": 20000 }`. SHIP does not configure Jev credentials or a model: follow that extension's own setup instructions. Disabling the option or not installing/activating `jev_ask` leaves normal deterministic routing intact. Existing projects can add this optional config field.

New native planner submissions require a semantic type and an explainable `profile` with 1–10 complexity, uncertainty and risk, traits and rationale; older persisted plans and queued add/change tasks lacking this profile receive a clearly marked structural estimate. SHIP independently enforces DAG/ownership readiness, security traits, migration and destructive boundaries, hard minimum role capability and mandatory independent/security review and verification. It offers bounded choices for semantic task type, complexity, uncertainty, risk and eligible role to the public `jev_ask` tool in one request. Each semantic answer is confidence-gated independently; Jev may escalate classification/review but cannot lower a deterministic planner/security floor or claim verification passed. Live, configured OMP role aliases and available pricing feed coarse task-cost ranges; missing price metadata remains unknown. OMP resolves the final role to its currently configured model; SHIP never hardcodes a provider or imports a Jev SDK.

Because OMP does not expose a public extension-to-extension tool invocation, SHIP asks the **main OMP session** to call `jev_ask` once, checks that its public `tool_result` matches the exact correlated request, and only then dispatches work. If the tool cannot be called, the main session calls `ship_judgment` with the pending ID and `status: "unavailable"`. Low-confidence individual fields use their deterministic value; malformed/ineligible role answers, tool errors or expiry fall back to SHIP's deterministic route without another Jev request. If an invocation never returns, run `/ship run` after `timeoutMs` to expire its pending judgment and continue; do not dispatch the task while a judgment is outstanding. Add/change edits remain queued while a judgment is pending and apply only at the next safe boundary; every ready task is judged before entering a parallel batch. Each task's `routingDecision` and optional `semanticJudgment` in `state.json` record normalized backend, role/classification, confidence/probabilities when available and fallback reasons; neither contains credentials or the full Jev prompt. Setting `enabled: false` affects future undecided routes, not already running assignments.

Benchmark the deterministic baseline against ten representative routing fixtures from a development checkout with `node --no-warnings --experimental-strip-types scripts/benchmark-judgment.ts --out <temporary-prefix>`. The default unavailable mode reports honest deterministic fallbacks; `--simulate` exercises the comparison machinery but is **not** Jev evidence. After running OMP's public `jev_ask` tool with configured credentials, `--capture <public-tool-results.json>` compares recorded typed results and any reported latency/token/cost fields; missing metrics stay N/A. In the unconfigured run, six of ten cases were Jev-eligible and all six fell back, with zero measured Jev calls; synthetic choices differed on six roles and escalated three, which says nothing about actual quality. **Decision: experimental optional backend**, not recommended/default, until live Jev results and outcome quality can be measured. No SHIP-specific key or direct Jev client is used.

In a separate real OMP RPC smoke with the Jev extension installed but no `TYPESAFE_API_KEY`, the public `jev_ask` call failed in 26 ms; SHIP recorded `backend: deterministic, reason: error`, verified the task's repository check, and completed. With judgment disabled, no Jev call occurred. This measures the unavailable/error path only; Jev decision quality, successful-call latency, usage and cost remain unmeasured.


## State, checks and recovery

```text
.ship/
  PROJECT.md          saved project brief
  config.json         native limits and verification policy
  state.json          authoritative roadmap, phase, attempts, assignments and budgets
  project-profile.json normalized discovered facts and bounded source fingerprints (rebuildable)
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

Repository instructions (AGENTS.md, CLAUDE.md, README/CONTRIBUTING and relevant project guidance) take precedence over cached facts and SHIP defaults. The lightweight profile records known evidence, unknowns and fingerprints of relevant config/instruction/layout inputs; it refreshes changed facts rather than indexing source files. Undiscovered checks remain unknown, not invented. Deleting `.ship/` removes only SHIP state, not the source project. SHIP snapshots existing Git changes before planning; tasks with unclear or overlapping file ownership are blocked instead of overwriting user work. Branch changes also block dispatch until ownership is reviewed.
SHIP discovers repository checks, freezes each task's declared acceptance and routed requirements, and executes applicable shell checks with bounded time/output and process-tree supervision. Verification on Windows requires PowerShell for job-object containment and a POSIX `sh` on PATH (Git for Windows supplies one); macOS/Linux also require `sh`. Review requirements without executable commands require substantive independent OMP review evidence. Failed checks or missing reviews never become verified successes merely because an agent reports `passed`. Process supervision for verification is not an agent harness.

A crash may leave a short-lived lock; `/ship recover` is intentionally destructive and refuses a live lock owner. **Before confirming recovery, independently establish that the former OMP session and every outstanding worker have stopped**: SHIP cannot inspect OMP worker liveness or kill them. Pending native assignments become failed and consume their current attempts; recovery transfers ownership to this OMP session and can immediately schedule another paid assignment or exhaust a repair budget. Interrupted planning likewise consumes a planning attempt. A review blocked only by insufficient dispatch budget stays pending; increase `limits.maxDispatches`, then `/ship resume` and `/ship run` to dispatch its reviewer. Without recovery, restarting `/ship run` in the original session reconciles stored progress, while a different session cannot claim outstanding work. Inspect `.ship/state.json`, events, and verification evidence to diagnose blocked work. OMP agents operate in your checkout with your normal filesystem permissions; they are **not sandboxes**.

For a manual recovery smoke check, start `/ship run` with a pending assignment, stop the owning OMP session and **all** its workers, then `/ship recover` in a new session. Confirm the pending assignment is marked failed, its attempt is consumed, ownership changes, and a repair may dispatch immediately. Do not try this on live work. For a budget-blocked review, confirm recovery leaves its reviewer pending; raise the dispatch budget, `/ship resume`, then `/ship run` before reporting the completed reviewer result.

## Manual smoke

In a throwaway existing Git repository, start OMP with `omp --extension /path/to/Ship/extensions/ship.ts --cwd /path/to/repo` and run `/ship add "implement a small verifiable change"`. Check `/ship status`, `.ship/project-profile.json` and `.ship/EXECUTION_PLAN.md` for discovered conventions, routes, prerequisites and checks. Before a task starts, queue `/ship change` or `/ship add`; confirm its revision applies only at the next safe boundary. Modify a source file before first use and confirm SHIP preserves it and blocks overlapping or uncertain ownership. Inspect `.ship/events.jsonl` and `.ship/attempts/` for ordered dispatch and passing checks; reopen OMP and use `/ship status` to confirm persisted completion. For failures, inspect `.ship/state.json` before any confirmed-dead `/ship recover`.

## Development

`npm test` exercises domain planning, migrations, native extension scheduling/edits, and verification behavior; `npm run check` typechecks. No standalone worker CLI, RPC protocol fixture, or offline fake-worker demo is part of the shipped product.
