# Ship Autopilot MVP

Ship is a file-backed autonomous development controller that uses Oh My Pi (OMP) as a disposable coding-agent harness.

The current MVP focuses on the first reliable vertical slice:

- initialize durable project state from a brief,
- plan the first milestone/slice/task through a worker,
- execute one task in a fresh worker,
- run acceptance checks in the controller,
- retry bounded failures,
- commit only after verification passes,
- persist state and an append-only event log,
- expose status/pause/capture/doctor commands.

It intentionally does **not** yet implement the full adaptive slice/milestone replanning loop.

## Requirements

- Node.js 22+
- Git
- OMP available as `omp` for live use

No npm install is currently required; the MVP uses Node's built-in TypeScript stripping and test runner.

## Quick start

```bash
git init my-project
cd my-project
git config user.name "Your Name"
git config user.email "you@example.com"

# Put this repo somewhere and call its CLI directly:
node /path/to/ship/src/cli.ts init --brief ./brief.md
node /path/to/ship/src/cli.ts status
node /path/to/ship/src/cli.ts run --once --worker fake
```

For live OMP:

```bash
node /path/to/ship/src/cli.ts doctor --worker omp
node /path/to/ship/src/cli.ts run --once
```

The live adapter starts:

```bash
omp --mode rpc --no-session
```

and waits for RPC `prompt_result`; if OMP reports `work_pending`, it also waits for `session_settled` before recycling the worker.

## CLI

```text
ship init --brief <file>
ship run [--once] [--max-runtime 8h] [--worker omp|fake]
ship status [--json]
ship pause
ship capture "<note>"
ship doctor [--worker omp|fake]
```

`pause` and `capture` are persisted to `.ship/inbox/`. Consumption of those messages by the run loop is a next-MVP item.

## Durable state

A project gets:

```text
.ship/
  PROJECT.md
  ROADMAP.md
  KNOWLEDGE.md
  config.json
  state.json
  events.jsonl
  attempts/
  inbox/
  logs/
```

The controller also writes `.git/info/exclude` entries for `.ship/` and `.ship-worktree/` so controller state is not swept into task commits without modifying the project's committed `.gitignore`.

`state.json` is the authoritative snapshot. Writes use temp-file + rename replacement. `events.jsonl` is an audit trail.

## Current execution model

The controller:

1. asks a worker for an initial structured roadmap if none exists,
2. selects the next pending task,
3. marks an attempt running,
4. invokes a fresh worker,
5. runs the task's acceptance commands itself,
6. retries failures up to the configured attempt limit,
7. commits verified source changes with a stable task/attempt marker,
8. marks the task complete only after the commit exists.

A worker saying "success" is never sufficient for acceptance.

## Tests

```bash
npm test
```

The offline suite covers:

- multiple tasks across two milestones,
- failed verification followed by a successful repair,
- the RPC lifecycle using a fake OMP subprocess,
- waiting for `session_settled` when work is pending.

The fake worker is deliberately simple and deterministic. It is for controller tests, not a simulation of model quality.

## OMP compatibility

The adapter targets the RPC contract documented in the current OMP repository. Before relying on it unattended, run `doctor` against the installed OMP version and run an opt-in live smoke test with your configured provider.

This environment did not contain an authenticated live OMP installation, so the included adapter has been exercised against a protocol-shaped subprocess, not a paid live model call.

## Next reliability work

The next controller milestones should be:

1. single-controller lock and stale-worker reconciliation,
2. crash recovery around execute/verify/commit boundaries,
3. safe consumption of pause/capture inbox messages,
4. structured knowledge records,
5. slice-boundary reflection and roadmap reassessment,
6. persistent no-progress and runtime budgets,
7. one dedicated run worktree/branch rather than working directly on the current tree.
