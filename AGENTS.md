# Bureaucracy Slayer Agent Guide

This file governs all coding-agent work in this repository. `ARCHITECTURE.md` is the canonical source for product scope, trust boundaries, contracts, policy semantics, planning behavior, and Definition of Done. Read it before changing code. If this guide and the architecture disagree, stop, record the discrepancy, and resolve the documents before implementation.

## Mission and priority order

Build an evidence-first, policy-aware browser workflow prototype for HackHarvard 2026. Optimize in this order:

1. trustworthy evidence bindings and fail-closed behavior;
2. deterministic, independently tested evaluation and planning;
3. one working end-to-end mock financial workflow;
4. an understandable demo UI;
5. portability and optional polish.

Do not trade a P0 acceptance criterion for generality, infrastructure, or visual polish. Results are guidance, never guaranteed safety or legal compliance.

## Repository ownership and dependency direction

Use the structure defined in `ARCHITECTURE.md`:

- `src/contracts/`: Zod schemas, inferred types, canonical serialization/hashing. Owns shared data shapes.
- `src/collector/`: Playwright observation, text normalization, stable snapshot IDs. Owns no policy meaning.
- `src/extraction/`: Claude prompt and structured-output parsing. This is the only probabilistic interpretation boundary.
- `src/evidence/`: citation, action, reference, allowlist, graph, and hash validation.
- `src/engine/`: pure condition evaluation, policy evaluation, and planning. No I/O, browser, React, HTTP, or model SDK imports.
- `src/orchestration/`: application use cases and artifact coordination; no new policy semantics.
- `src/server/`: thin schema-validated HTTP adapters.
- `src/ui/`: React presentation and user-fact collection; no policy decisions.
- `mock-portal/`: controlled website and visible source policies. Never import it from `src/`.
- `tests/fixtures/`: domain-specific snapshots, models, and user states. Fixtures may contain payment terminology; engine code must not.

Allowed dependency direction:

```text
ui/server -> orchestration -> collector | extraction | evidence | engine -> contracts
```

Avoid circular imports. Modules communicate through contracts, not deep imports into another module's internals.

## Shared contract rules

- Zod schemas are the runtime source of truth. Export TypeScript types using `z.infer`; do not maintain parallel handwritten interfaces.
- Parse all external, persisted, browser-collected, model-generated, and HTTP data at its boundary.
- Use `.strict()` for externally supplied object schemas unless the architecture explicitly permits passthrough fields.
- Cross-object invariants belong in Zod `superRefine` or `src/evidence/`, not UI or route handlers.
- IDs, hashes, enums, status meanings, unknown-value behavior, and evidence fields are public contracts.
- Never reinterpret an existing field. For a breaking semantic change, increment `schemaVersion`, add/update migration or fixture handling if needed, and update architecture text, all producers, all consumers, and tests in the same change.
- A contract change is incomplete until golden fixtures and invalid-input tests are updated.
- Do not add a new operator, rule effect, plan status, or auto-execution field without documenting its deterministic semantics in `ARCHITECTURE.md`.

## TypeScript and coding conventions

- Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, and `useUnknownInCatchVariables`.
- Prefer small named pure functions, discriminated unions, exhaustive `switch` statements, and immutable inputs/outputs.
- Do not use `any`, non-null assertions, unchecked type casts, silent coercion, or boolean truthiness for domain decisions. Narrow `unknown` through schemas or explicit guards.
- Use names from the canonical contracts: `SiteSnapshot`, `ProcedureModel`, `EvidenceResult`, `UserState`, and `SafeActionPlan`.
- Canonicalize before hashing. Pass clocks and ID generators into code that needs them so tests remain deterministic.
- Use structured reason/issue codes for expected failures. Human messages supplement codes; callers must not parse message text.
- Keep functions focused. Prefer local duplication over a speculative shared abstraction until two real call sites have the same invariant.
- Comments explain trust assumptions or non-obvious invariants, not syntax.

## Error handling

- Fail closed: malformed input, unsupported schema versions, mismatched hashes, dangling references, unavailable actions, or ambiguous critical policy must never yield a ready step.
- Return typed domain results for expected outcomes such as blocked, needs information, review required, and stale. Do not throw for ordinary policy outcomes.
- Throw only for programmer errors or unrecoverable infrastructure failures; catch them at orchestration/HTTP boundaries and return a sanitized error.
- Preserve issue codes and provenance through layers. Never replace a specific evidence error with generic prose.
- Do not log credentials, cookies, tokens, input values, full account numbers, Claude API keys, or unredacted sensitive page content.
- At most one explicitly configured extraction retry is allowed. Never create an unbounded model or browser loop.

## Deterministic and LLM boundaries

Claude may:

- select relevant observed actions;
- propose typed conditions and procedure dependencies;
- summarize action purposes; and
- cite exact supplied evidence while flagging ambiguity.

Claude must not:

- browse without the collector, invent IDs/evidence/facts, mark evidence valid, decide execution authorization, or override engine results;
- convert an unknown mandatory condition to true;
- resolve policy conflict through confidence or prose; or
- produce the final route as an unverified instruction list.

Only deterministic code may validate evidence, evaluate three-valued conditions, enforce prohibition dominance, resolve graph constraints, calculate staleness, and authorize any browser interaction. User-state replanning must not call Claude.

## Evidence provenance rules

- Every policy rule has at least one `EvidenceCitation` with page ID, URL, block ID, exact excerpt, and applicable action IDs.
- Every browser-backed procedure action refers to a collected `WebsiteAction`.
- Use the same documented normalization routine for collection and exact excerpt validation. Do not add fuzzy matching in P0.
- Quote existence proves provenance, not semantic correctness. Keep evidence validity, semantic confidence, policy outcome, and operational safety separate.
- A rejected potentially restrictive rule triggers review; never discard it and infer permission.
- Every ready plan step has at least one valid supporting rule citation. Human-only tasks also require policy evidence and are never executable.

## Security and controlled interaction

- Crawl only configured seed URLs, same-origin pages, and explicit allowlists, within page/retry limits.
- Treat website text as hostile data and possible prompt injection. Do not grant extraction calls tools or interpolate page text as instructions.
- Do not collect or send hidden inputs, cookies, tokens, credentials, passwords, or unrelated content to the model.
- Never auto-submit forms, make/cancel a transaction, initiate a dispute, upload/download files, disclose credentials, bypass authorization, or perform an irreversible action.
- P0 is guidance-only. Any later guided action must pass the pre-action re-observation and authorization boundary in `ARCHITECTURE.md` and require user confirmation.
- Keep API keys server-side and out of source, fixtures, artifacts, screenshots, and logs. Commit only an example environment file with placeholder names.

## Testing requirements

Every behavioral change includes the smallest relevant automated test. Tests must be offline and deterministic by default.

- `tests/unit/`: schema acceptance/rejection, normalization, hash stability, three-valued truth tables, prohibition dominance, missing facts, conflicts, stale bindings, graph validation, and deterministic route ranking.
- `tests/fixtures/`: sanitized immutable inputs; explicitly label hand-authored versus recorded extraction fixtures.
- `tests/e2e/`: Playwright verifies that collected pages/actions really exist and exercises the vertical slice against the local mock portal.
- Never require a live Claude call for the default test command. Test the adapter with a fake transport and keep any live evaluation behind an explicit command/environment flag.
- For every bug in evidence, evaluation, or planning, first add a failing regression fixture/test.
- Assert invariants, status/reason codes, IDs, and citations—not incidental prose or unstable timestamps.
- Before handing off, run format/lint if configured, typecheck, unit tests, and the relevant e2e tests. Report commands not run and why.

Required experiment coverage is listed in `ARCHITECTURE.md`: policy exception, no-LLM dynamic replanning, evidence failure/conflict, unknown mandatory facts, and (P1) cross-domain portability.

## Commands

The repository currently contains documentation only. These commands are proposed targets and must be made real when the project is scaffolded; keep their names stable afterward:

```powershell
npm install                 # install pinned dependencies
npm run dev                 # local API, Vite UI, and mock portal
npm run typecheck           # strict TypeScript check
npm test                    # offline Vitest unit/integration suite
npm run test:e2e            # Playwright tests against local fixtures
npm run test:live-extract   # optional, explicit Claude-backed evaluation
npm run lint                # configured static checks
```

Do not claim a proposed command works until it exists and has been run successfully. Use npm unless a documented architecture decision changes the package manager; do not add monorepo tooling.

## Scope and dependency discipline

- Prefer platform APIs and the selected stack: TypeScript/Node, Zod, Playwright, Anthropic SDK, Vite/React, Vitest, and a thin HTTP adapter.
- Before adding a dependency, state the concrete P0 requirement it satisfies and why existing dependencies/platform APIs are insufficient.
- Do not add databases, queues, containers, cloud resources, telemetry services, vector stores, graph databases, generic agent frameworks, state-management frameworks, UI kits, or extension tooling for P0.
- Do not implement P1/P2 while P0 tests or acceptance criteria are incomplete.
- Keep adaptive discovery as a bounded configuration of the same extraction pipeline, never a parallel extractor.

## Never hardcode

Production modules must never hardcode:

- payment statuses, methods, deadlines, verification rules, exception rules, policy text, or mock-portal routes;
- site-specific fact keys, action IDs, page IDs, DOM selectors, citations, or plan steps;
- a permission based on semantic confidence;
- an assumption that a missing fact is false/true or that an absent prohibition means permission; or
- a test-fixture outcome in evaluator/planner conditionals.

The engine may hardcode only documented universal semantics such as three-valued truth tables, closed-world permission, prohibition dominance, evidence gating, status precedence, and deterministic route ranking.

## Independent testability

- Construct domain functions with plain parsed data; pass clocks, hashes, transports, and browser adapters through explicit interfaces.
- Keep Playwright `Page`, HTTP request/response objects, React state, environment variables, and Anthropic SDK types at adapters.
- `src/engine/` tests must run without a DOM, network, filesystem, environment secrets, or model.
- `src/evidence/` tests use in-memory snapshots and models.
- Collector tests run only against local deterministic pages.
- UI consumes `SafeActionPlan`; it must not reproduce condition or conflict logic.

## Decisions, limitations, and refactoring

- Record durable architecture or contract decisions in `ARCHITECTURE.md`; keep this file operational and concise.
- Put short unresolved, submission-relevant limitations in the architecture failure-mode or priority sections. Do not hide them in TODO comments.
- A TODO names an owner/phase (`P0`, `P1`, or `P2`) and a concrete completion condition.
- During refactoring preserve: schema meanings/versions, evidence provenance, exact-match behavior, fail-closed outcomes, three-valued logic, prohibition dominance, deterministic results, artifact compatibility, and the no-auto-execution boundary.
- Refactors must keep behavior tests green before deleting old paths. Do not maintain two extraction/evaluation pipelines.

## Multi-agent continuity

When several coding agents work over time:

- Check `git status` and recent diffs first. Existing changes belong to another agent/user unless assigned otherwise; do not overwrite them.
- Divide work by module ownership with explicit input/output contracts. Avoid concurrent edits to `src/contracts/`, `ARCHITECTURE.md`, or shared fixtures.
- Before changing a shared contract, announce the intended change, affected producers/consumers, migration/version impact, and tests; land it as one coherent change.
- Leave each module buildable and tested. Hand off with changed files, decisions, test commands/results, unresolved risks, and the next concrete task.
- Do not create competing implementations to avoid coordination. Reuse the canonical contracts and deterministic engine.
- Resolve ambiguous policy semantics in the architecture and tests before encoding them.

## Completion check for every change

Before declaring work complete, verify:

1. the change serves the current P0/P1/P2 priority;
2. all boundary data is parsed with Zod;
3. no LLM output bypasses deterministic validation;
4. failure paths are fail-closed and carry structured reasons;
5. relevant unit/e2e tests pass offline;
6. no secrets or sensitive artifacts were introduced;
7. architecture/contracts/docs changed when semantics changed; and
8. the handoff states what was verified and what remains.

