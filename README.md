# SHIP

SHIP is an [oh-my-pi (OMP)](https://github.com/can1357/oh-my-pi) extension for planning and verifying multi-step changes in an existing Git checkout. OMP owns the session, models, agents and tools. SHIP stores a versioned roadmap and evidence in `.ship/`. It does not run a detached worker, sandbox agents, push changes or publish releases.

Use ordinary OMP for a small one-off edit. Use SHIP when dependencies, explicit scope approval and progress across sessions matter. **Agents edit your checkout with your filesystem permissions; model calls can incur charges. Review the proposed scope and Git ownership before running work.**

## Install

Install Node.js 22.6+, Git, and [OMP](https://github.com/can1357/oh-my-pi). Authenticate an OMP model and confirm an ordinary request works. Make `sh` available for checks (Git for Windows provides it); Windows also needs PowerShell. SHIP requires OMP's `task` agent for planning; implementation may use `task`, `sonic`, `reviewer` or `security-reviewer`. Configure accessible `@plan` and `@slow` roles before work routed to them. SHIP does not configure a provider or own an API key.

```bash
git clone https://github.com/garrettlabs/ship.git Ship
cd Ship
npm ci
omp plugin link "/absolute/path/to/Ship"
omp --cwd "/absolute/path/to/your-project"
```

Alternatively load the extension with `omp --extension "/absolute/path/to/Ship/extensions/ship.ts" --cwd "/absolute/path/to/your-project"`. Keep the linked checkout installed. Run OMP **in the project**, not in the SHIP checkout.

## First approved run

Start in a disposable Git repository with an existing declared test command and a bounded change:

```text
/ship add "Add a boundary-case test for the existing public parser and run the declared tests"
/ship status
/ship run
```

First-use `/ship add` or `/ship change` adopts the repository in place. It profiles current instructions and declared checks, then asks the OMP planner for a draft. **Planning is not execution:** the draft waits for review. `/ship status` shows the pending request, affected scope, current tasks, ready work and approval boundary. `/ship run` offers **Approve and run**, **Approve only**, **Reject**, or **Cancel**. Consequential changes require another explicit confirmation. Rejection retains the approved roadmap and records the reason. Approve-only saves the new roadmap and selected run target without dispatching agents; return to `/ship run` to execute that saved target. An agent's outcome is not verification: SHIP runs required checks and requests independent/security reviews before marking a task passed.

`/ship init` optionally performs read-only reconnaissance before choosing a goal. For an existing checkout, review the scout summary before approving `.ship/DISCOVERY.md`; it is observed context, **not authorization to edit**. Then supply a goal with `/ship add "..."` or `/ship change "..."`. For a new empty project, `/ship init` asks for a nonempty brief file; `/ship run` drafts its first roadmap. SHIP does not infer a goal from reconnaissance.

## Evolve an approved roadmap

```text
/ship add "Add an export workflow to the existing application"
/ship change "Split the remaining import work and defer the optional cache"
/ship status M001/S01/T01
/ship run
```

Describe desired outcomes in ordinary language. The planner proposes operations against stable milestone/slice/task IDs: add a slice or milestone, revise or split unstarted work, or defer, cancel or supersede work. A completed or attempted task and its evidence cannot be rewritten. Unfinished prerequisites are not silently counted as complete; successor dependencies must be rewired to all replacement tasks. Later milestones may remain outline-only until their executable slice is expanded and approved. Proposals show affected scope and verification before approval; an input request alone never grants execution. `/ship status [M001/S01/T01]` reads current state without launching a worker.

Tentative requests (for example, “maybe add this later”) offer **Capture for later** instead of planning. `/ship promote` selects a saved idea when it becomes an explicit request. Captures are unplanned context, not an accepted decision or authorization. Accepted user decisions, reconnaissance observations, unresolved assumptions, prerequisite outcomes and recorded evidence references stay distinct in bounded planner/worker context. Current repository instructions take precedence over cached discovery.

## Verification and human decisions

Code work needs a passing executable verification command; SHIP will not invent one. Research, design, reconnaissance and documentation work can use an actual workspace artifact with an answer and supported findings for each current acceptance criterion instead of a fake shell command. Required independent/security reviews and configured protected checks still apply. Evidence is bound to task acceptance and artifact fingerprints; changing acceptance or artifact content invalidates prior proof. If acceptance explicitly requires human evaluation, use `/ship verify M001/S01/T01` in the **interactive main session** to read the recorded evidence and approve it yourself. Agents cannot assert human acceptance. Failed checks, adverse review findings and missing evidence never count as success.

Repository checks discovered from manifests can change. SHIP records package-script definitions and Makefile recipes alongside the runnable commands, compares them again before each check, and stops on drift. Review the exact old/new check policy and affected tasks with `/ship reconcile` before adopting a changed script, recipe, runner or command; a changed check cannot silently certify earlier work. A planner's task-specific shell commands appear verbatim in the proposal preview and require explicit main-session approval; YOLO cannot authorize new planner-authored command text. Likewise, reconcile previously dirty user-owned files only after reviewing their current Git status. SHIP preserves unrelated edits, checks branch and ownership before dispatch, and does not reset your files.

The policy fingerprint covers all package scripts (including lifecycle hooks) and the complete local Makefile; unsupported Makefile includes are not guessed into executable checks. It is a declaration-drift gate, not a sandbox or a guarantee that repository code and external tools cannot change while a command runs. Review proposed shell commands and changed repository scripts as executable code.

## Scheduler controls

| Command | Effect |
| --- | --- |
| `/ship status [task ID]` | Read bounded progress, ready/blocked work, pending approvals and evidence. |
| `/ship add "request"`, `/ship change "request"` | Ask for a reviewable initial or incremental proposal. |
| `/ship promote` | Choose a captured idea to plan explicitly. |
| `/ship run [task [M001/S01/T01] \| slice [M001/S01] \| milestone [M001] \| all]` | Review a pending proposal or advance approved work in the current OMP session. With no saved target, default to the first incomplete milestone. |
| `/ship reconcile` | Review changed declared checks and eligible clean user-owned paths; rechecks Git/policy before applying. |
| `/ship pause`, `/ship resume` | Queue scheduler controls for the next safe boundary. A clean handoff checkpoint allows another session to resume quiescent work after Git/progress revalidation. |
| `/ship verify M001/S01/T01` | Approve required human evaluation in the main interactive session after inspecting evidence. |
| `/ship yolo`, `/ship yolo off` | Enable or disable conservative same-session automatic approval/continuation. Default: supervised. |
| `/ship recover` | Destructive takeover **only after the former session and all workers are confirmed dead**. |

YOLO applies only to its initiating OMP session. It may approve routine, bounded proposals without new planner-authored shell commands and continue safe ready work without repeatedly asking. It does **not** bypass Git ownership, budgets, required checks/reviews, human evaluation, consequential scope choices, deployment, deletion, security or ambiguous product decisions. Unsafe proposals stay pending for user review; blocked work does not retry forever. Disable it with `/ship yolo off`.

The run target is persisted: `/ship run` resumes the saved scope, including after a safe session handoff, rather than silently widening to the whole roadmap. Choose `task` for the next incomplete task (or provide its stable ID), `slice` for the next incomplete slice (or provide its stable ID), `milestone` for the next incomplete milestone (or provide its endpoint ID), or `all` only when you intend to run the entire roadmap. A milestone includes unfinished work in earlier milestones, not just its own tasks. Supply a new scope or explicit ID to change the saved target; YOLO cannot expand it. `/ship status` displays the saved target, its verified/total task progress, and the supervised or same-session YOLO mode. Older states without a target remain untouched by status; their target is chosen on the next run. A future OMP goal ending at M002 can reuse the same persisted milestone endpoint to cover M001–M002. No SHIP-specific `/loop` orchestration is needed.

Ready independent tasks can share a batch only when ownership and safety checks permit it. `maxParallelTasks` caps the number of assignments even when more are safe. Task attempts, dispatches and reviewer dispatches count against persisted budgets. Raise limits only deliberately; a missing command, conflict or required approval is not a budget problem.

## State, recovery and configuration

`.ship/state.json` is authoritative; `.ship/ROADMAP.md` and `.ship/EXECUTION_PLAN.md` are generated views. `.ship/PROJECT.md` is the original brief, `.ship/project-profile.json` caches fingerprinted discovery, `.ship/KNOWLEDGE.md` presents recorded knowledge, `inbox/` holds safe-boundary messages, and `attempts/` and `events.jsonl` record verification and transitions. SHIP excludes `.ship/` using local Git excludes; that does not set a repository-wide `.gitignore`. Version-1 state is validated and backed up as `.ship/state.json.v1.backup` before migration to version 2; failed validation does not overwrite the original. Never delete an existing `.ship/` to bypass a state error.

Default `.ship/config.json`:

```json
{
  "schemaVersion": 1,
  "limits": { "maxTaskAttempts": 3, "maxDispatches": 100, "maxParallelTasks": 2 },
  "verificationTimeoutMs": 300000,
  "protectedChecks": [],
  "judgment": { "enabled": false, "confidenceThreshold": 0.7, "timeoutMs": 20000 }
}
```

The config schema and state schema are separate. Protected checks run alongside task-specific requirements; a failing or unavailable check cannot pass. Checks run with bounded output/time and process-tree supervision, **not inside an agent sandbox**. Optional Jev routing uses OMP's public `jev_ask` tool only when configured; deterministic safety floors still apply and Jev cannot certify verification. [OMP model-role settings](https://github.com/can1357/oh-my-pi/blob/main/docs/settings.md) and [task-agent discovery](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md) describe provider setup.

A quiescent pause records a handoff summary and Git fingerprints. Another session can resume only if roadmap progress, branch, HEAD, dirty paths and their contents still match; otherwise inspect and resolve the discrepancy. **Do not use `/ship recover` for an ordinary safe handoff.** Recovery is for confirmed-dead work: it marks pending assignments failed, consumes attempts, and may dispatch a paid repair. SHIP cannot detect whether another OMP worker is alive or prevent it from modifying the checkout. Return to the owning session if any worker may still run.

If blocked, start with `/ship status` and inspect `.ship/attempts/` and `.ship/events.jsonl`. Fix the reported check, missing provider role, Git conflict, approval or budget cause; then `/ship resume` and `/ship run` in the appropriate session. A plain `/ship run` resumes the persisted target; to choose another scope, specify it explicitly. Status itself does not change the work plan or launch an agent.

## Developer checks and repeatable smoke

Run `npm test` and `npm run check` in the SHIP checkout. CI exercises both Windows and Linux. For a live journey, create a **throwaway** Git repo with a small source function, package manifest and declared test script; make an initial commit. Launch OMP with the linked extension inside that repo. Request a boundary-case change, inspect `/ship status`, reject an intentionally wrong first draft, request a corrected one, approve it without running, then `/ship run` and inspect `.ship/attempts/` for checks and reviews. Capture a tentative idea, promote it, inspect the revision preview, approve it, pause after the batch settles, and reopen OMP to validate a clean resume. Separately exercise a human-evaluation task with `/ship verify`. Verify that any deliberately dirty file is protected, and test `/ship recover` only after terminating the owning session **and all workers**. Never run destructive-recovery smoke in a real project.
