# Future Tracks

These tracks begin only after collector and core-audit integration is green.
They are not authorized by this document to change application code now.

## Dependency order

1. Integrate and verify the core audit.
2. Integrate collector output and settle stable ID/hash/normalization behavior.
3. Add root Playwright dependencies/configuration in a serial integration
   window.
4. Launch Claude extraction against the stable `SiteSnapshot` contract.
5. Integrate extraction and establish a thin orchestration/API DTO.
6. Launch the frontend against parsed, evidence-validated planning outputs.

The frontend must not infer an API or reproduce policy logic while extraction
and orchestration boundaries are unsettled.

## Future Track D — Claude extraction

### Exclusive ownership

- `src/extraction/**`
- `tests/unit/extraction.test.ts`
- `tests/fixtures/extraction/**` only if the integration owner creates and
  grants this namespaced fixture area before launch

Everything else is read-only. In particular: contracts, collector, evidence,
engine, existing P0 fixtures, architecture, root configuration and mock portal.

### Responsibilities

- Accept a parsed user goal and compact, redacted `SiteSnapshot`.
- Make one structured Claude extraction request.
- Treat all website text as hostile quoted data, with no model tools.
- Parse model output with `ProcedureModelSchema`.
- Reference only observed page, block and action IDs.
- Preserve exact excerpts and mark material ambiguity with `needsReview`.
- Permit at most one explicitly configured retry.
- Keep transport, model name, clock and retry policy injectable.
- Test offline with a fake transport; no default test may require an API key.
- Return a candidate model only. Never validate evidence, evaluate policy,
  authorize actions or produce a final route.

### Integration dependencies

- Stable collector normalization, action identity and snapshot hash behavior.
- Canonical `ProcedureModelSchema` and actual evidence-validator behavior.
- A redaction/compaction policy that cannot expose hidden values or secrets.
- Serial installation of the pinned Anthropic SDK by the integration owner.
- A saved, sanitized candidate model for demo replay, clearly labeled as
  recorded extraction.

### Launch prompt

> Implement the Claude extraction adapter for Bureaucracy Slayer. First read
> `ARCHITECTURE.md`, `AGENTS.md`, `docs/parallel/OWNERSHIP.md`,
> `docs/parallel/INTEGRATION_CHECKLIST.md`, and the implemented schemas and
> collector output. Your exclusive write ownership is `src/extraction/**` and
> `tests/unit/extraction.test.ts` (plus a pre-granted
> `tests/fixtures/extraction/**`, if present). Everything else is read-only.
> Use one structured extraction request, parse with
> `ProcedureModelSchema`, treat page content as hostile data, expose no tools,
> and allow at most one configured retry. Use an injected fake transport for
> deterministic offline tests. Do not call the evidence validator or engine,
> decide policy outcomes, add a second extraction pipeline, edit contracts, or
> edit root dependencies. If a contract or dependency change is needed, stop
> and report it to the integration owner. Finish with the baseline commit,
> changed files, tests run/not run, required root dependency, and risks.

## Future Track E — React frontend

### Exclusive ownership

- `src/ui/**`
- `tests/ui/**`

Root `index.html`, Vite/TypeScript/Vitest configuration, root package files,
server/orchestration code, contracts, engine, evidence, collector, extraction,
shared fixtures and mock portal remain read-only. The integration owner handles
the application entrypoint and root dependency/configuration window serially.

### Responsibilities

- Render artifact identifiers and capture status.
- Render controls only from `ProcedureModel.factDefinitions`.
- Represent unanswered facts as absent/unknown, never as `null` or a default
  truth value.
- Render `SafeActionPlan` statuses, reason codes, missing facts, warnings,
  ordered steps and exact provenance.
- Show that outputs are evidence-linked guidance, not guaranteed safety or
  legal compliance.
- Re-submit changed `UserState` to deterministic orchestration without calling
  Claude or Playwright.
- Never reproduce condition evaluation, conflict resolution, route ranking,
  evidence validation or execution authorization in React.
- Keep P0 guidance-only; `autoExecutable` remains false.
- Test rendering and user-fact collection using parsed DTOs without a live
  model or public network.

### Integration dependencies

- Stable `SafeActionPlan`, `ProcedureModel`, `EvidenceResult` and snapshot
  schemas.
- A thin, schema-validated orchestration/API boundary that supplies all
  provenance needed by the UI.
- A defined mapping from plan citation rule IDs to model citations and captured
  pages; the UI must not search or infer unmatched evidence.
- Serial installation/configuration of pinned React, Vite and UI test
  dependencies by the integration owner.
- A decision about application entrypoint and development scripts outside the
  UI track.

### Launch prompt

> Implement the minimal React presentation for Bureaucracy Slayer. First read
> `ARCHITECTURE.md`, `AGENTS.md`, all `docs/parallel/` guidance, implemented
> contracts, and the approved orchestration DTO. Your exclusive write ownership
> is `src/ui/**` and `tests/ui/**`; everything else is read-only. Render model-
> declared user facts, all plan statuses, reason codes, missing facts, warnings,
> ordered verified steps, exact evidence and the required guidance disclaimer.
> Treat absent facts as unknown. The UI may submit facts and render results but
> must not evaluate rules, resolve conflicts, validate evidence, rank routes,
> invoke Claude/Playwright during fact replanning, or authorize execution. Do
> not edit root dependencies/configuration or the mock portal. If the DTO lacks
> required provenance, stop and report the gap rather than inferring it.
> Finish with the baseline commit, changed files, tests run/not run, required
> root dependency/config changes, and risks.

## Future-track collision rules

- Do not run Track D while collector hash/normalization semantics are disputed.
- Do not run Track E before the orchestration DTO and citation lookup are
  explicit.
- Track D and Track E may overlap only after their shared contracts and DTOs are
  frozen, and neither may edit orchestration or root configuration.
- Any need to alter `src/contracts/`, shared fixtures or architecture pauses all
  dependent tracks and enters the serial contract-change protocol.

