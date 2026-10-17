# Safe Parallel Workflow

## Recommendation

Use one Git worktree per active agent and a separate integration worktree.
Directory ownership remains mandatory because branches and worktrees isolate
filesystem writes but do not prevent semantically incompatible changes.

Do not launch agents from the current `HEAD`: the verified Phase 1 files are
present as working-tree changes rather than in `HEAD`. A worktree created now
would start from the earlier architecture-only commit.

## 1. Establish the baseline

The integration owner performs this once in the primary worktree:

```powershell
git status --short
npm run typecheck
npm test
npm run demo
```

Review every intended source file and `.gitignore`, exclude generated files and
dependencies, then create a local checkpoint commit. Do not use `git add -A`
without reviewing the path list. The checkpoint should include this parallel
protocol so every agent receives the same rules.

```powershell
git diff --cached --name-only
git commit -m "Checkpoint verified Phase 1 and parallel protocol"
$baseline = git rev-parse HEAD
```

Record `$baseline` in every agent prompt and handoff. If the three verification
commands do not pass at that commit, stop; there is no valid common baseline.

## 2. Create isolated worktrees

Keep worktrees outside the OneDrive-synchronized project directory where
practical:

```powershell
$baseline = git rev-parse HEAD
New-Item -ItemType Directory -Force C:\Users\Ansar\worktrees | Out-Null
git worktree add C:\Users\Ansar\worktrees\bureaucracy-integration -b integration/parallel $baseline
git worktree add C:\Users\Ansar\worktrees\bureaucracy-collector -b track/collector $baseline
git worktree add C:\Users\Ansar\worktrees\bureaucracy-core-audit -b track/core-audit $baseline
```

Never point two agents at the same worktree or branch. Track C is complete when
these documents are committed; it does not need a concurrent implementation
worktree.

## 3. Launch the active agents

Launch Track A and Track B only after the baseline and worktrees exist.

Track A packet:

- worktree: `C:\Users\Ansar\worktrees\bureaucracy-collector`
- writable: `src/collector/**`, `tests/collector/**`
- read first: architecture, agent guide, all parallel docs and implemented
  contracts
- output: bounded collector, mock-portal tests, dependency request and handoff
- prohibitions: no root config/dependencies, contracts, engine/evidence,
  existing tests/fixtures or mock-portal edits

Track B packet:

- worktree: `C:\Users\Ansar\worktrees\bureaucracy-core-audit`
- writable: `src/engine/**`, `src/evidence/**` and the four exact unit-test
  files listed in `OWNERSHIP.md`
- read first: architecture, agent guide, all parallel docs, contracts and
  current tests
- output: fail-closed audit/refactor, adversarial regressions and handoff
- prohibitions: no public-interface, contract, collector, shared
  fixture/helper, integration-test, mock-portal or root-config edits

Each agent must:

1. confirm its baseline hash and clean worktree before editing;
2. treat all non-owned paths as read-only even if a tool offers to edit them;
3. commit focused changes on its own branch;
4. run `git diff --name-only <baseline>...HEAD` before handoff;
5. stop and escalate if a required fix crosses ownership.

Agents cannot be assumed to honor these constraints automatically. The
integration owner verifies the diff; prompt text is not an enforcement
mechanism.

## 4. Working rules

- Do not merge, rebase or cherry-pick another active track into a track
  worktree.
- Do not share uncommitted patches between worktrees.
- Do not let agents modify a shared file in turns while both tracks remain
  active; close ownership first.
- Do not resolve compile errors by copying contracts, weakening types, casting,
  or importing another module's internals.
- Keep mock-portal startup/read operations separate from writes. It is a
  controlled external fixture from the collector's perspective.
- Track A reports missing Playwright dependencies as expected until the serial
  dependency window; it must still run all checks possible without changing
  root files.
- Track B must keep the Phase 1 public APIs and artifact compatibility intact.

## 5. Handoff format

Every track supplies:

```text
Track:
Baseline commit:
Final commit(s):
Changed files:
Contract assumptions:
Tests run and results:
Tests not run and why:
Dependency/config requests:
Known risks/blockers:
Next integration action:
```

An omitted test or dependency request is not implied success.

## 6. Serial integration sequence

Use the dedicated integration worktree and integrate one track at a time.

1. Verify both track branches are committed and no agent is still writing to
   the path being integrated.
2. Inspect Track B's complete diff and ownership.
3. Cherry-pick Track B's focused commits into `integration/parallel`.
4. Run `npm run typecheck`, `npm test`, and `npm run demo`. Stop on failure.
5. Inspect Track A's complete diff and ownership. Reject root or mock-portal
   edits.
6. Review collector ID, normalization and hash recipes before accepting output.
7. Cherry-pick Track A's source/test commits.
8. Close Track A. Open a serial root-config window owned only by the integration
   owner.
9. Apply the approved exact Playwright dependency and lockfile update. Add only
   the minimum verified collector test script/configuration.
10. If required for canonical layout, move `tests/collector/**` to
    `tests/e2e/**` now, while no test track is active.
11. Run typecheck, all Phase 1 tests, collector unit tests, local mock-portal
    tests, repeated-capture stability tests and the demo.
12. If collector code must change, close the root-config window, make the new
    integration baseline available to Track A, and grant only collector-owned
    files for the fix. Do not permit Track A to revise root configuration.
13. Review the combined diff against the integration checklist and commit the
    assembled result.
14. Only then create worktrees for future extraction and frontend tracks.

Prefer cherry-picking focused commits over merging an agent branch wholesale;
it makes out-of-scope files visible and allows a rejected commit to stay out of
the integration branch.

## 7. Detecting contract incompatibility

Treat these as evidence of incompatibility:

- canonical Zod parsing rejects a producer's object;
- repeated unchanged captures produce different IDs/hashes without a documented
  reason;
- collector block hashes fail `hashText`;
- citations require fuzzy matching or use canonical URLs where exact page URLs
  are required;
- evidence validation rejects action page membership, source bindings,
  availability or origin;
- an agent requests a cast, duplicate schema or changed enum/status meaning;
- Phase 1 fixtures or valid serialized artifacts stop parsing;
- engine behavior changes without a structured reason-code regression test.

Resolve incompatibility by reproducing it at the boundary with the smallest
parsed object, identifying the owning layer, and fixing that layer in a serial
window. If field meaning or schema shape must change, use the contract-change
protocol; do not patch producer and consumer independently.

## 8. Conflict handling

Textual conflict:

1. stop affected writers;
2. compare each change against path ownership;
3. keep the owned change and return the out-of-scope change;
4. rerun all checks.

Semantic conflict without a Git conflict:

1. save the rejected artifact and Zod/evidence diagnostics;
2. classify it as producer, consumer or contract behavior;
3. assign exactly one owner for the fix;
4. integrate the fix serially and rerun both component and full-flow tests.

Never choose a version based only on which branch merged first.

## 9. Launch gate

Immediate launch is **NO-GO** until:

- the verified Phase 1 working tree and these docs are committed as one known
  baseline;
- both implementation worktrees are created from that commit;
- each agent receives its exact write allowlist;
- Track A acknowledges that root dependency changes are deferred to the
  integration owner; and
- the integration owner acknowledges the unresolved page/snapshot hash recipe
  and collector-test final-path decision as merge gates.

After those conditions are met, Track A and Track B are **GO** to run in
parallel. Future extraction and frontend tracks remain **NO-GO** until the
serial integration sequence is green.

