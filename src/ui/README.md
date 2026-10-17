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
    "dev:ui": "vite --config vite.ui.config.ts",
    "build:ui": "vite build --config vite.ui.config.ts",
    "preview:ui": "vite preview --config vite.ui.config.ts",
    "test:ui": "vitest run tests/ui"
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

`FixtureDemoProvider` validates the bundled recorded artifacts and calls the
real deterministic evaluator and planner. Its user-state replanning is genuine;
its saved website snapshot and extracted procedure model are not live
Playwright/Claude results. A future HTTP provider can implement the same
interface without changing presentation components.
