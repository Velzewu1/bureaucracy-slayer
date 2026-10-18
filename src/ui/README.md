# Interactive demo UI integration

This directory is a React/Vite frontend module integrated with the root build.

## Integrated configuration

The runtime and build dependencies are pinned in the root manifest:

```powershell
npm install --save-exact react@19.2.0 react-dom@19.2.0
npm install --save-dev --save-exact vite@7.3.7 @types/react@19.2.2 @types/react-dom@19.2.2
```

The root `tsconfig.json` enables DOM and JSX support without weakening its strict options:

```json
{
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx"
  }
}
```

The root `package.json` provides:

```json
{
  "scripts": {
    "build:recorded": "node --require ./scripts/tsx-windows-user-shim.cjs --import tsx ./scripts/build-recorded-extraction-bundle.ts",
    "dev:ui": "vite --config vite.ui.config.ts --configLoader runner",
    "build:ui": "npm run build:recorded && vite build --config vite.ui.config.ts --configLoader runner",
    "preview:ui": "vite preview --config vite.ui.config.ts --configLoader runner",
    "test:ui": "vitest run tests/ui --configLoader runner"
  }
}
```

Then launch the fictional demo portal UI with:

```powershell
npm.cmd run dev:ui
```

The UI uses `vite.ui.config.ts` to set its root/output paths and provide a
browser-only SHA-256 adapter for the canonical synchronous hashing interface.
The adapter preserves SHA-256 output and does not change canonical code.

If component-level DOM tests are added later, install these optional pinned packages:

```powershell
npm install --save-dev --save-exact @testing-library/react@16.3.0 @testing-library/user-event@14.6.1 jsdom@27.0.1
```

## Integration boundary

`DemoDataProvider` in `types.ts` is the replaceable boundary:

- `analyze(request)` returns canonical snapshot, model, evidence, evaluation,
  and plan artifacts.
- `replan(sessionId, userState)` returns a new canonical planner result.
- `getEvidence(sessionId)` returns the canonical `EvidenceResult`.

`LiveExtractionProvider` is the production default behind the single visible
**Analyze Website** action. `FixtureDemoProvider` and `RecordedExtractionProvider`
remain non-UI regression and explicit operator-fallback boundaries. The build step validates the three source
artifacts, replays their staged conversion, runs the semantic qualifier audit,
and writes only the sanitized bundle in `generated/recordedSonnetBundle.ts`.
At runtime the provider recomputes hashes, audit findings, evidence, evaluation,
and planning; it never calls Anthropic or Playwright.

To run the unified product against the genuine live server:

```powershell
npm.cmd run build:recorded
npm.cmd run dev:ui
```

There is no user-facing provider selector. Set `BUREAUCRACY_SLAYER_EXECUTION_POLICY`
before starting Vite when an operator explicitly needs `offline_mock`,
`recorded_replay`, or `verified_fixture`. Mock mode additionally requires responses
to carry the mock-only provenance header; live mode rejects that header. Changing user
facts performs only bounded deterministic replanning and cannot clear semantic-review
gates.

## Guided personalization

Guided and All facts are presentation views over the same `ModeWorkspaceState.userState`.
All facts preserves the complete canonical form. Guided becomes available only after an
analysis supplies verified artifacts, asks one unresolved model-declared fact at a time,
and immediately calls the existing `DemoDataProvider.replan` boundary after an answer.
Switching views does not copy, reset, or reinterpret facts.

The guided view reuses the existing deterministic decision path:

- `analyzeDecisionIntelligence` supplies the trace, counterfactuals, and question list.
- `rankAdaptiveQuestions` owns question priority and ranks materially different bounded
  outcomes; the UI does not implement a competing ranking heuristic.
- `updateUserFact` adds or removes the canonical scalar value without coercing an unknown.
- `DemoDataProvider.replan` invokes the existing local evaluator/planner implementation;
  it does not collect pages or run extraction.
- `planDifference`, `SafeRoutePanel`, and `DecisionIntelligencePanel` retain route changes,
  exact citations, and the full technical trace.

If the ranked list cannot represent an unresolved canonical fact, the UI uses the first
unanswered `plan.missingFacts` entry in `ProcedureModel.factDefinitions` order. This is a
stable fallback, not an optimized question-selection claim. Facts absent from the plan's
missing-fact set are never surfaced as necessary by that fallback.
