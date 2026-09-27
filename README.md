# SHIP

SHIP adds persistent planning, dependency scheduling, role routing, and verification policy to an [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) coding session. It is an **OMP extension**, not a separate agent runner. OMP owns the models, sessions, coding agents, tools, and your checkout; SHIP stores the roadmap and progress in that checkout, decides which work is ready, and checks reported results. There is no production `ship` CLI, detached SHIP worker, separate worktree, or SHIP terminal UI.

## Install and make a first request

You need Node.js 22.6+, Git, and an installed, authenticated OMP. Shell verification also needs `sh` on PATH; on Windows it additionally needs PowerShell for process containment (Git for Windows supplies `sh`). From a local SHIP checkout:

```bash
cd /path/to/Ship
npm ci
omp plugin link /path/to/Ship
```

`omp plugin install /path/to/Ship` also links a local checkout. Once published, `omp plugin install ship-autopilot` installs the package. For an unregistered development checkout, load the extension directly instead:

```bash
omp --extension /path/to/Ship/extensions/ship.ts --cwd /path/to/your-repo
```

The package's OMP extension entry is `extensions/ship.ts`. Start OMP in an existing project repository with the plugin enabled (or use the direct-load command above), then ask for a concrete, checkable change:

```text
/ship add "Add a password-reset request endpoint; follow this repo's API conventions and run its declared checks"
/ship status
```

On first use, `/ship add "request"` and `/ship change "request"` adopt the current Git checkout, discover its instructions and declared checks, create minimal `.ship/` state, and ask the OMP-native planner for a roadmap. They do not require an initialization wizard or rearrange the project. Without inline request text, SHIP prompts once. `/ship change` is the natural first request when changing existing behavior. The planner inspects the project and submits a validated plan; planning itself is not permission to modify source files. If work has not advanced, use `/ship run` to explicitly resume planning or dispatch. OMP does not autonomously start SHIP's scheduler in the background.

### What commands do

| Command | When to use it |
| --- | --- |
| `/ship add "request"` | First use: adopt and plan the request. With an existing roadmap: choose a slice and queue a fully specified new task. |
| `/ship change "request"` | First use: adopt and plan a change to existing code. With a roadmap: choose a pending, never-attempted task and queue a goal/planning-hint edit. |
| `/ship run` | Explicitly advance planning, process safe-boundary edits, reconcile the owning session's batch, or dispatch ready work. |
| `/ship status` | Inspect phase, roadmap revision, task count, dispatch budget, active batch, and blocked reason; works from a nested project directory. |
| `/ship pause` / `/ship resume` | Queue safe-boundary scheduler controls; resume can clear a blocked phase after its cause or budget is addressed. They do not pause OMP itself. |
| `/ship init` | Optional brief-file workflow: confirm a nonempty project brief, initialize Git if needed, and initialize `.ship/`; refuses to overwrite existing SHIP state. |
| `/ship recover` | **Destructive, confirmed-dead-session takeover**; see [Recovery](#recovery-and-safety-limits). |

With an existing roadmap, `/ship add` requires at least one planned slice and asks for a title, goal, acceptance and verification shell command. `/ship change` requires a pending task with zero attempts and asks for a revised goal; started, failed and completed tasks cannot be changed this way. Both forms offer optional semantic type, uncertainty, dependency, ownership and verification hints. For example, `/ship add "Document the reset endpoint's error responses"` opens a task form after the password-reset roadmap exists. If no slice or eligible task appears, finish planning or choose another request rather than treating the command as applied.

Submitting the form only queues an edit. `/ship run` applies queued edits at a safe boundary after checking the recorded roadmap revision and dependency graph; a stale or unsafe edit is rejected with a reason.

| State to recognize | What to check |
| --- | --- |
| **Queued** | The command says *queued* and a request is in `.ship/inbox/`; the roadmap revision has not changed. |
| **Applied** | After `/ship run` reaches a safe boundary, the roadmap revision and generated roadmap/plan views reflect the accepted edit. |
| **Blocked** | `/ship status` reports `blocked` and a reason (such as a stale revision, overlapping user work, or failed checks); resolve the cause before `/ship resume` and `/ship run`. |
| **Verified** | Task state is `passed` only after its required checks and reviews pass; inspect `.ship/attempts/` for check evidence. `complete` additionally requires any configured project integration checks. An agent's `passed` report alone is not proof. |

## How a run progresses

1. The main OMP session asks a planner to submit a roadmap through `ship_plan`. SHIP validates task IDs, dependency levels, objectives, acceptance criteria, ownership and verification requirements as a dependency graph (DAG). A task is ready only after its prerequisites pass.
2. SHIP classifies and routes ready tasks against the configured OMP roles. The main session receives concrete assignments and uses OMP task agents, or works directly if the selected route allows. Independently ready tasks can enter one parallel batch only when ownership and safety rules permit; overlapping or unclear ownership, risky migrations and destructive boundaries constrain parallelism. Assignments belong to the OMP session that started the batch.
3. The main session reports results through `ship_outcome`. Required independent or security reviews use OMP agents; the report alone cannot waive them. SHIP runs applicable declared repository checks and protected checks before marking work passed, persists bounded evidence, then releases dependent tasks. Failed checks or missing substantive review evidence fail verification and may use the remaining repair/dispatch budget.

New planner submissions include semantic type and an explainable task profile (1–10 complexity, uncertainty and risk, traits and rationale); older records without a profile get a marked structural estimate. Deterministic routing enforces hard role-capability, security, review and verification floors. OMP resolves a selected role against its live model configuration, rather than SHIP hardcoding a model provider. Estimated task-cost ranges use available configured role/pricing data; missing prices remain unknown.

## Project knowledge, Git changes, and state

SHIP looks for repository instructions (including `AGENTS.md`, `CLAUDE.md`, README/CONTRIBUTING and scoped guidance), ecosystem manifests, lockfiles, layout, migration hints and declared commands. Repository instructions take precedence over cached discovery and SHIP defaults. `.ship/project-profile.json` records bounded source fingerprints, discovered facts and explicit unknowns; changed sources refresh the profile. It is not a source-code index and an undiscovered check is **unknown**, not a guessed command. Task-specific architectural boundaries still require inspection.

Before planning, SHIP snapshots Git branch and dirty paths, including untracked files and both sides of renames. It preserves existing changes: unclear or overlapping task ownership blocks work rather than treating those changes as disposable. Branch changes can block dispatch until ownership is reviewed. OMP agents work in your checkout with your normal filesystem permissions; **they are not sandboxes**. Inspect the proposed ownership and checks before letting work proceed.

The local `.ship/` directory contains:

| Location | Meaning |
| --- | --- |
| `PROJECT.md`, `config.json` | Saved brief and per-project scheduler/verification policy. |
| `state.json` | Atomic authoritative snapshot: schema, roadmap revision, phase, tasks, attempts, assignments and budgets. |
| `project-profile.json` | Rebuildable discovery facts, unknowns and source fingerprints. |
| `ROADMAP.md`, `EXECUTION_PLAN.json`, `EXECUTION_PLAN.md`, `KNOWLEDGE.md` | Generated human-readable roadmap/plan/knowledge views and machine-readable execution plan. |
| `inbox/`, `events.jsonl`, `attempts/` | Queued safe-boundary changes, append-only event history, and verification evidence/logs. |
| `lock/` | Short-lived state/check lock while a SHIP operation owns it. |

Deleting `.ship/` removes SHIP's local state, not the source project. Optional `/ship init` excludes `.ship/` from local Git tracking; do not assume that is a team-wide `.gitignore` rule. Existing version-1 config files with former `worker` and `review` fields remain readable, but those fields are ignored: no RPC worker is launched. Legacy standalone worktree or active-attempt metadata is a diagnostic boundary, not native completion; inspect or archive the old state before starting a fresh native project rather than expecting an implicit migration.

## Configuration and optional Jev

`.ship/config.json` is created with these defaults; edit limits/checks to match your repository:

```json
{
  "schemaVersion": 1,
  "limits": { "maxTaskAttempts": 3, "maxDispatches": 100 },
  "verificationTimeoutMs": 300000,
  "protectedChecks": [],
  "judgment": { "enabled": false, "confidenceThreshold": 0.7, "timeoutMs": 20000 }
}
```

`maxTaskAttempts` bounds planning/task repairs; `maxDispatches` is a persistent budget for assignments, including reviewers. `verificationTimeoutMs` bounds each shell check. `protectedChecks` supplies commands run alongside task-specific declared verification. Checks run in the project with bounded time/output and process-tree supervision; a nonzero result or a check that cannot execute cannot become a verified success. A review requirement without an executable command instead needs substantive independent OMP review evidence. The verification process supervisor is **not** an agent sandbox.

Routing is deterministic by default. To try optional Jev judgments, install and enable `@jev-harness/omp` in OMP, configure its credentials according to that extension, and set `judgment.enabled` to `true`. SHIP owns no Jev key, model setting, SDK client or alternate invocation path.

SHIP asks the **main OMP session** to call the public `jev_ask` tool with bounded semantic choices, then correlates the result before dispatch. If the tool is unavailable, the main session calls `ship_judgment` with the pending ID and `status: "unavailable"`. Each field has its own confidence gate: low-confidence choices use the deterministic value; malformed/ineligible answers, tool errors and expiry fall back without retry. Jev can escalate classification or review, never lower deterministic security/capability floors or certify verification.

A pending judgment holds dispatch and queued roadmap edits. If the invocation never returns, use `/ship run` after `timeoutMs` to expire it. Disabling Jev affects future undecided routes, not running assignments. Persisted routing decisions and optional normalized semantic judgments contain no credentials or full Jev prompts.

**Jev remains experimental, not the default recommendation.** From a development checkout, run `node --no-warnings --experimental-strip-types scripts/benchmark-judgment.ts --out <temporary-prefix>` for the deterministic baseline. Default unavailable mode measures fallbacks; `--simulate` exercises comparison machinery, **not Jev quality**. After calling the public `jev_ask` tool with working credentials, `--capture <public-tool-results.json>` compares recorded typed results and reports only available latency/usage/cost metrics.

In an unconfigured ten-fixture run, six were Jev-eligible and all six fell back, with zero measured Jev calls; synthetic choices differed on six roles and escalated three. A separate OMP RPC smoke with the Jev extension but no `TYPESAFE_API_KEY` saw a public-tool error in 26 ms, deterministic error fallback, and a passing repository check; disabling judgment made no Jev call. Neither run measures successful-call latency, usage, cost or decision quality.

## Recovery and safety limits

Use `/ship status` first; inspect `.ship/state.json`, `.ship/events.jsonl` and `.ship/attempts/` to distinguish queued, running, failed, budget-blocked and verified work. In the original owning OMP session, `/ship run` can reconcile stored progress. A different session cannot claim outstanding planning or batch work simply by running it. A blocked review awaiting dispatch budget remains pending; raise `limits.maxDispatches`, then `/ship resume` and `/ship run` to dispatch its reviewer.

`/ship recover` is **destructive**. Before confirming it, independently establish that the former OMP session **and every outstanding worker** have stopped. SHIP cannot inspect OMP worker liveness or kill them, and it refuses a live SHIP lock owner. Recovery transfers batch ownership, marks pending assignments failed and consumes their current attempts; interrupted planning also consumes a planning attempt. It can dispatch paid repair work immediately or exhaust a budget. Never recover while former workers may still be writing in the checkout. SHIP does not promise to resolve conflicting source changes or resume a dead agent's in-memory work.

## Manual smoke and developer checks

In a **throwaway** Git repository with a small declared test command, start OMP with the extension and run `/ship add "add a small behavior with a test"`. Use `/ship status`; inspect `.ship/project-profile.json` for actual discovered guidance/checks and `.ship/EXECUTION_PLAN.md` for dependencies, routes and verification. Queue a later `/ship change` before its task starts, observe that it is queued rather than applied, then `/ship run` and confirm the revision changes only at the safe boundary. In a separate throwaway run, dirty a file before first use and confirm overlapping or uncertain ownership blocks instead of discarding it. For completed work, inspect ordered events and passing evidence in `.ship/attempts/`, then reopen OMP and confirm status persists.

Test recovery **only in a disposable repository**: start a pending assignment, stop its owning OMP session and all workers, then confirm `/ship recover` in a new session. Check the failed assignment, consumed attempt, transferred ownership and any immediate repair dispatch. For a budget-blocked review, confirm the reviewer stays pending until you raise the budget, `/ship resume`, and `/ship run`.

From a development checkout, `npm test` runs domain planning, migration, native scheduling/edit and verification tests; `npm run check` typechecks. The npm package includes the extension and runtime source, not development tests or fixtures. Keep the package and `omp` versions aligned for releases. There is no shipped standalone worker CLI, RPC fixture or fake-worker demo.
