# Integration Checklist

Use this checklist for each track handoff and again on the assembled branch.
Passing it reduces known integration risk; it does not guarantee safety merely
because track directories do not overlap.

## 1. Baseline and ownership

- [ ] The track names its baseline commit and that commit contains the verified
      Phase 1 implementation.
- [ ] `git diff --name-only <baseline>...HEAD` contains only paths owned by the
      track.
- [ ] No generated output, browser binaries, `node_modules/`, `dist/`,
      credentials, cookies, tokens, screenshots with sensitive content, or
      test-result artifacts are committed.
- [ ] No track changed contracts, architecture, agent guidance, shared
      fixtures/helpers, root configuration, or the mock portal.
- [ ] The handoff lists tests run, tests not run, exact commands, unresolved
      risks, and requested dependency/configuration changes.

Any failed ownership check blocks integration. Do not resolve it by accepting
an oversized commit and hoping merge conflict detection will protect shared
semantics.

## 2. Canonical contract compatibility

Validate collector output with `SiteSnapshotSchema.parse`, not a duplicate
type. Confirm all of the following:

- [ ] `schemaVersion` is `1`; objects are strict and contain no extra fields.
- [ ] IDs satisfy `^[a-z]+_[a-zA-Z0-9_-]{6,}$`.
- [ ] URLs are absolute HTTP(S) URLs and timestamps are ISO datetimes.
- [ ] The snapshot has 1–12 pages.
- [ ] Page, block and action IDs are unique snapshot-wide.
- [ ] Every `WebsiteAction.pageId` equals its containing page ID.
- [ ] Action kinds and locator shapes are exactly the implemented enum and
      discriminated union.
- [ ] Optional fields are omitted rather than emitted as `undefined`.
- [ ] Every normalized block has non-empty text and
      `textHash === hashText(block.text)`.
- [ ] Collector code imports `normalizeEvidenceText`, `hashText`, and
      `hashCanonical` from `src/contracts/` where applicable; it does not create
      a competing normalization or canonicalization implementation.
- [ ] Stable IDs and fingerprints are deterministic under repeated collection
      of unchanged DOM content and distinguish duplicate occurrences.
- [ ] Page and snapshot hashes are deterministic under repeated collection.

The exact canonical payload for page and snapshot `contentHash` is not encoded
by the current Zod schemas, and the current validator treats those values as
opaque bindings. Track A must document and test its payload recipe. If the
recipe affects refresh/reuse semantics or conflicts with architecture, that is
an integration blocker requiring a serial architecture decision; it must not be
invented independently by another track.

For all existing outputs:

- [ ] `ProcedureModelSchema`, `EvidenceResultSchema`, `UserStateSchema`, and
      `SafeActionPlanSchema` still accept valid Phase 1 artifacts.
- [ ] Public engine and evidence exports retain their signatures.
- [ ] No local handwritten interface shadows an inferred Zod type.
- [ ] No new operator, rule effect, status, issue meaning, or execution field
      was introduced.

## 3. Collector-to-evidence interoperability

Run at least one real capture against the unmodified local mock portal and feed
the resulting snapshot through the actual evidence validator with a model bound
to that snapshot.

- [ ] Crawl starts only from configured HTTP(S) seeds.
- [ ] Discovery is bounded to 12 pages, same-origin URLs and explicit
      allowlists, with at most one retry per page.
- [ ] URL canonicalization removes navigation aliases without merging distinct
      content incorrectly.
- [ ] Visible policy text becomes normalized evidence blocks; hidden inputs,
      input values, credentials, cookies, tokens and unrelated content are not
      collected.
- [ ] Real visible links, buttons and supported form controls become actions
      with accessible labels and at least one valid locator candidate.
- [ ] Disabled or invisible controls follow one documented rule and cannot
      enter `verifiedWebsiteActionIds`.
- [ ] Cross-origin targets are omitted or represented conservatively and are
      rejected by evidence validation.
- [ ] A citation uses the exact captured `page.url`, not merely
      `canonicalUrl`.
- [ ] Citation block IDs resolve on the cited page and normalized exact
      excerpts validate without fuzzy matching.
- [ ] Citation `actionIds` resolve to actions on the cited page.
- [ ] Browser-backed procedure actions resolve to observed website actions;
      user tasks remain unbound.
- [ ] `ProcedureModel.sourceSnapshotId` and `sourceSnapshotHash` exactly match
      the collected artifact.
- [ ] An altered excerpt, block ID, action ID or source hash fails closed.
- [ ] Repeating an unchanged capture produces the documented stable
      identifiers/hashes; a material action or policy change changes the
      relevant binding.

Do not treat schema acceptance alone as interoperability. The evidence
validator additionally checks exact text hashes, page membership, same-origin
targets, visibility/enabled state and source bindings.

## 4. Core audit acceptance

- [ ] Active prohibitions dominate permits independent of rule order or
      confidence.
- [ ] Active permit plus prohibition emits conflict diagnostics and never a
      ready action.
- [ ] Unknown potentially active prohibitions and mandatory requirements
      produce `needs_information`, not permission.
- [ ] Missing or rejected restrictive evidence cannot create permission by
      omission.
- [ ] Stale snapshot IDs/hashes and artifact bindings have global precedence.
- [ ] Unavailable actions, dangling references and dependency cycles fail
      closed.
- [ ] Every ready plan step has valid rule citations and an observed website
      action, except evidenced non-executable `user_task` steps.
- [ ] Route selection and reason codes are deterministic under input ordering.
- [ ] Public interfaces and schema meanings remain unchanged.

## 5. Required verification gates

Before each integration:

```powershell
npm run typecheck
npm test
npm run demo
```

After Track B, run those gates before accepting Track A. After Track A and the
serial Playwright dependency window, additionally run:

- [ ] the collector unit tests;
- [ ] the collector test against the locally served, unmodified mock portal;
- [ ] repeated-capture stability tests;
- [ ] malformed/unavailable/cross-origin collector cases;
- [ ] the full Phase 1 suite to detect regressions.

Use the collector command actually added and verified during serial integration;
do not claim `npm run test:e2e` exists until the integration owner has added and
run it. Default tests must remain deterministic and require no public network or
live Claude call.

Record test counts as observations, not permanent acceptance criteria. The
reported 49-test baseline must not decrease without an explained test
replacement.

## 6. Root configuration gate

- [ ] Track A supplies a dependency request without editing root files.
- [ ] All implementation tracks touching affected code are stopped.
- [ ] The integration owner installs an exact pinned Playwright package and
      updates root manifest/lockfile together.
- [ ] Any browser installation command and local portal startup are documented.
- [ ] The integration owner alone adds or changes scripts/configuration.
- [ ] Root TypeScript includes collector source/tests without weakening strict
      options.
- [ ] The nested mock-portal manifest and lockfile remain unchanged.

## 7. Blockers and escalation

Stop integration for:

- a required edit outside track ownership;
- any proposed contract reinterpretation or schema change;
- disagreement about hash/ID/normalization semantics;
- collector output rejected by canonical parsing or evidence validation;
- a failing baseline test, unexplained test-count reduction, or non-determinism;
- dependency/version conflicts or root config edits from more than one branch;
- required changes to the mock portal or shared fixtures;
- collection of secrets, hidden values, cross-origin content, or unbounded
  navigation.

Escalation procedure:

1. preserve the failing artifact and smallest deterministic reproduction;
2. identify whether the defect belongs to producer, consumer or shared
   contract;
3. stop every affected track and notify the integration owner;
4. record expected/current behavior, affected files, reason codes, schema
   version impact and proposed test;
5. let the integration owner make one serial decision and change;
6. rerun all gates and rebase/recreate affected worktrees.

No agent may work around a blocker with a cast, duplicate schema, fuzzy
matching, silent coercion, broadened allowlist or weakened test.

