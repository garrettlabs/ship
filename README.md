# Ship Autopilot

Early MVP of a file-backed autonomous development controller that treats OMP as a disposable coding worker.

## What works today

- `.ship/` initialization from a project brief.
- Deterministic controller state persisted in JSON plus an append-only event log.
- OMP RPC subprocess adapter that waits for `prompt_result` and session settlement rather than confusing command acknowledgement with completion.
- Just-in-time initial roadmap generation.
- One-task-at-a-time execution with fresh OMP processes.
- Controller-owned acceptance commands, bounded retries, Git commits, and resumable task state.
- `.ship/` is added to the repository-local Git exclude file so controller state is not swept into task commits.
- `status`, `pause`, `capture`, and `doctor` CLI surfaces.
- Offline tests with a fake worker.

## Requirements

- Node.js 22.6+ (this MVP uses Node's built-in TypeScript type stripping).
- Git.
- OMP for live runs: https://github.com/can1357/oh-my-pi

## Try it

```bash
npm test
npm run ship -- --help

mkdir /tmp/my-project && cd /tmp/my-project
git init -b main
cp /path/to/brief.md brief.md
node --experimental-strip-types /path/to/ship-autopilot/src/cli.ts init --brief brief.md
node --experimental-strip-types /path/to/ship-autopilot/src/cli.ts doctor
node --experimental-strip-types /path/to/ship-autopilot/src/cli.ts run --once
```

For a live run, `omp` must be on PATH and authenticated.

## State model

`.ship/state.json` is the authoritative workflow snapshot. `.ship/events.jsonl` is an audit log. `.ship/ROADMAP.md` is a generated human-readable projection. Attempt summaries are immutable-ish records under `.ship/attempts/`.

This is deliberately simpler than GSD: no database, no parallel task graph, no daemon, and no background scheduler yet.

## Current limitations

This is the first vertical slice, not the full unattended-hours system yet. In particular:

- Captures are queued but not yet consumed by a replanner.
- Pause is checked between controller steps, not during an active OMP turn.
- There is no lock/concurrent-controller protection yet.
- There is no slice-boundary reflection/replanning yet.
- Crash reconciliation around a commit/state-write boundary still needs explicit hardening.
- The real OMP adapter has been implemented against the current RPC docs but cannot be live-tested in this environment because OMP is not installed here.

## Next implementation slice

1. single-controller lock + inbox consumption;
2. crash reconciliation using Git HEAD + attempt records;
3. slice completion reflection and roadmap patch proposals;
4. failure diagnosis/repair prompts with persistent retry budgets;
5. failure-injection tests for worker death and controller restart.
