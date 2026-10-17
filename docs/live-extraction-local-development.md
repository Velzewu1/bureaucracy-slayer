# Live extraction local development

The Live Sonnet demo uses three loopback-only processes:

| Process | Origin | Command |
| --- | --- | --- |
| UI | `http://127.0.0.1:5173` | `npm run dev:ui` |
| Mock portal | `http://127.0.0.1:5180` | `npm run portal:dev` |
| Live extraction API | `http://127.0.0.1:5190` | `npm run dev:server` (reserved; added by the backend owner with the server entrypoint) |

At contract baseline `404d503`, the backend entrypoint and `dev:server` package script do not
exist. The command name and port above are the integration handoff; do not substitute a guessed
entrypoint. Until the backend implementation is merged, use the offline mock API harness in
`tests/integration/live-extraction/`.

## Install

Install the root application and the independently versioned mock portal:

```powershell
npm install
npm --prefix mock-portal install
```

Default tests are offline and must not call Anthropic:

```powershell
npm run typecheck
npm test
```

Do not run `npm run test:live-extract` as part of normal development or CI. It is an explicit,
paid live rehearsal.

## Environment

Copy `.env.example` to an ignored `.env` only when running the real API. The Anthropic key,
workspace ID, and model configuration are server-only. Never prefix them with `VITE_`, place
them in browser code, paste them into test fixtures, or include them in logs.

The controlled P0 target remains:

```text
Portal: http://127.0.0.1:5180/dashboard
Goal:   I sent an $850 transfer to the wrong recipient. Can I cancel it? If not, what are my alternatives?
```

The browser sends neither value. The API reads the trusted portal configuration and owns the
fixed goal.

## Run the three processes

After the backend owner lands and verifies `dev:server`, open three terminals from the repository
root:

```powershell
# Terminal 1
npm run portal:dev

# Terminal 2
npm run dev:server

# Terminal 3
npm run dev:ui
```

All three development servers must bind to `127.0.0.1` with strict ports. The UI proxies only
`/api/live-extraction` to `http://127.0.0.1:5190`; the proxy does not rewrite the origin or add
wildcard CORS. The API must independently enforce the exact browser origin and remain bound to
loopback.

## Offline integration harness

The reusable mock API is a test-only `node:http` server on an ephemeral loopback port. It serves
strictly parsed fake job timelines and never imports the collector, Anthropic SDK, backend job
store, or frontend provider. Use it for contract and transport tests before the real server and
Live UI mode are available:

```powershell
npx vitest run tests/integration/live-extraction-api-security.test.ts --configLoader runner
```

Phase 2 browser tests should keep using fake transports by default. A live paid extraction is
permitted only as a separate, explicit rehearsal after all offline checks pass.
