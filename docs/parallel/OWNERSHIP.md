# Parallel Track Ownership

## Authority and baseline

`ARCHITECTURE.md`, `AGENTS.md`, and the implemented Zod schemas under
`src/contracts/` define the shared interfaces. The schemas win over assumptions
in an agent prompt. All tracks must start from the same committed, verified
baseline and record that commit hash in their handoff.

The current working tree is not a safe worktree baseline: the Phase 1
implementation is not contained in current `HEAD`. The integration owner must
first review and commit the intended baseline, excluding generated files and
dependencies, before launching implementation tracks.

## Ownership matrix

Ownership is exclusive write permission, not merely the directory an agent is
expected to focus on. Anything not explicitly writable is read-only.

| Role | Exclusive writable paths | Read-only dependencies | Explicitly prohibited writes |
| --- | --- | --- | --- |
| Track A — Codex collector | `src/collector/**`, `tests/collector/**` | `src/contracts/**`, `src/evidence/**`, `mock-portal/**`, architecture and agent guidance | Engine, evidence, contracts, existing tests and fixtures, mock portal, root configuration |
| Track B — Cursor core audit | `src/engine/**`, `src/evidence/**`, `tests/unit/conditions.test.ts`, `tests/unit/evaluator.test.ts`, `tests/unit/planner.test.ts`, `tests/unit/evidence.test.ts` | Contracts, fixtures, test helpers, integration tests, collector, architecture and agent guidance | Contracts, collector, shared fixtures/helpers, integration tests, mock portal, root configuration |
| Track C — Cursor coordination | `docs/parallel/**` | Entire repository | All application code, tests, fixtures, mock portal and root configuration |
| Integration owner — repository maintainer | No concurrent implementation ownership; serial integration windows only | Entire repository | Must not edit a track-owned path while that track is active |

Track B regression data must be constructed locally in its owned test file from
existing fixtures. It may not modify `tests/fixtures/p0.ts` or
`tests/helpers.ts`.

`tests/collector/` is an isolated staging path assigned by this protocol.
`ARCHITECTURE.md` lists `tests/e2e/` as the canonical final home for collector
tests. Track A must not write `tests/e2e/` concurrently. After Track A closes,
the integration owner may move the tests into `tests/e2e/` in a serial
integration commit, or obtain an architecture decision to retain the staging
path.

## Shared read-only files

These are collision gates. No active track may modify them:

- `src/contracts/**`
- `ARCHITECTURE.md`
- `AGENTS.md`
- root `package.json` and root lockfile
- root TypeScript, Vitest, Vite, Playwright, lint and formatting configuration
- `tests/fixtures/**`
- `tests/helpers.ts`
- `tests/integration/**`
- `tests/unit/contracts.test.ts`
- `mock-portal/**`, including its package and lockfiles

The collector may run the mock portal and inspect its public DOM. It may not
import mock-portal source into production code, use its internal domain modules
as an API, or change the portal to make collection easier.

## Integration owner

The solo repository maintainer is the integration owner. This role:

1. creates the committed baseline and track worktrees;
2. verifies every track diff is confined to its ownership;
3. closes or pauses all affected tracks before opening a shared-file write
   window;
4. performs root dependency and configuration updates serially;
5. resolves test relocation and contract questions;
6. integrates one track at a time and runs the repository verification gates;
7. rejects or returns out-of-scope changes instead of silently fixing them
   during a merge.

Integration ownership does not authorize an unreviewed architecture or contract
change.

## Root dependency decision

Use approach A: only the integration owner changes root dependencies.

Track A must report the exact Playwright package, pinned version, browser
requirement, proposed scripts, and commands it could not run. It must not edit
the root manifest or lockfile. Once Track A has stopped writing, the integration
owner opens a serial root-config window, installs the approved dependency,
updates the lockfile, and runs collector verification. Dependencies installed
inside `mock-portal/` are not a supported substitute for a root dependency.

The same rule later applies to the Anthropic SDK, React, Vite, and UI test
dependencies.

## Contract-change protocol

No track may silently change, shadow, cast around, or locally redefine a
canonical contract.

If an agent finds a contract defect:

1. stop work that depends on the disputed behavior;
2. write a short issue in the handoff with the failing input, current schema
   result, required behavior, affected producers/consumers, versioning impact,
   and smallest regression test;
3. do not edit `src/contracts/`, architecture, fixtures, or downstream modules;
4. the integration owner pauses every affected track and decides whether the
   issue is an implementation bug or a contract change;
5. a contract change is made as one serial change covering schema versioning,
   architecture, producers, consumers, fixtures, and invalid-input tests;
6. rebase or recreate affected worktrees from the new verified baseline.

Changing a field's meaning without a schema-version change is prohibited.

## Collision check

The active write sets are mutually exclusive when the matrix is followed.
Separation does not itself guarantee integration safety: collector output feeds
the evidence validator, both tracks import contracts, tests share a runner, and
dependency changes share root configuration.

The following paths have zero concurrent owners:

- `src/contracts/`: shared read-only; serial contract-change process only.
- root `package.json` and lockfile: integration owner, serial window only.
- `ARCHITECTURE.md` and `AGENTS.md`: shared read-only during active tracks.
- shared fixtures and helpers: shared read-only during active tracks.
- `mock-portal/`: shared read-only fixture.

