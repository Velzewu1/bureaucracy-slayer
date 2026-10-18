# Bureaucracy Slayer

> **AI agents know where to click. Bureaucracy Slayer verifies whether they should.**

Bureaucracy Slayer analyzes a bounded website snapshot, connects policy rules to exact source evidence, evaluates those rules against user facts, and produces a conservative action plan. If permission, evidence, or required information is uncertain, the application stops instead of guessing.

The included Northstar Mock Bank is fictional. It performs no real financial transactions.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- npm
- Chromium for Playwright-backed tests
- Three free local ports:
  - `5173` — web application
  - `5180` — Northstar Mock Bank
  - `5190` — analysis API

## Install

From the repository root:

```powershell
npm.cmd install
npm.cmd --prefix mock-portal install
```

## Run the project offline

This is the recommended way to try the project. It uses deterministic fixtures and makes **zero Anthropic API calls**.

Open three PowerShell terminals in the repository root.

### Terminal 1 — Northstar Mock Bank

```powershell
npm.cmd run portal:dev
```

Portal: <http://127.0.0.1:5180/dashboard>

### Terminal 2 — deterministic mock API

```powershell
npm.cmd run dev:mock-api
```

API: `http://127.0.0.1:5190`

### Terminal 3 — web application

```powershell
$env:BUREAUCRACY_SLAYER_EXECUTION_POLICY = 'offline_mock'
npm.cmd run dev:ui
```

Application: <http://127.0.0.1:5173>

Before selecting **Analyze Website**, confirm that the page says **Offline mock configured**.

### Verify the offline API

```powershell
$probe = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:5173/api/live-extraction/offline-mock'
if ($probe.StatusCode -ne 200) { throw 'Offline mock probe failed' }
if ($probe.Headers['x-bureaucracy-slayer-offline-mock'] -ne '1') { throw 'Offline mock marker missing' }
$body = $probe.Content | ConvertFrom-Json
if ($body.offlineMock -ne $true) { throw 'The UI is not connected to the offline mock' }
```

## Use the application

1. Open <http://127.0.0.1:5173>.
2. Confirm that the selected portal is `http://127.0.0.1:5180/dashboard`.
3. Enter one of the supported offline goals:

```text
Can I cancel my scheduled bank transfer?
```

```text
I sent a completed transfer to the wrong recipient. How can I recover it?
```

```text
I found a transfer I did not authorize. What should I do?
```

4. Select **Analyze Website**.
5. Answer the questions in **Guided** mode, or switch to **All facts**.
6. Inspect the decision, excluded actions, exact policy evidence, and provenance.
7. Change a fact to replan locally. Replanning uses only the deterministic evaluator and planner; it does not call Anthropic or collect the website again.

Offline mode intentionally rejects unsupported goals instead of selecting an unrelated fixture.

### Decision statuses

- **Safe route found** — every displayed step passed deterministic policy and evidence checks.
- **More information needed** — at least one mandatory fact is unknown.
- **Human review required** — ambiguous semantics, rejected evidence, or a conflict prevents a recommendation.
- **No permitted route** — every candidate route is prohibited or unavailable.
- **Plan is stale** — the plan no longer matches its source artifacts or user state.

Every result is guidance only. The application does not automatically submit forms, cancel transfers, or perform other sensitive actions.

## Reset Northstar

Northstar stores its simulated state in browser storage. If the transfer was canceled or a form was submitted, open:

<http://127.0.0.1:5180/dashboard?scenario=a1-scheduled-standard>

The URL reseeds the default scheduled Standard transfer scenario.

## Run with Live Anthropic extraction

Live mode performs fresh bounded collection and paid Anthropic extraction.

> **Live extraction incurs Anthropic API costs.**

Create a local `.env`:

```powershell
Copy-Item .env.example .env
```

Set the server-only values:

```dotenv
ANTHROPIC_API_KEY=your-local-key
ANTHROPIC_MODEL=claude-sonnet-4-5
ANTHROPIC_MAX_TOKENS=16000
COLLECTOR_TEST_URL=http://127.0.0.1:5180/dashboard
LIVE_EXTRACTION_MODE=goal_scoped
```

Never commit `.env`, expose the API key through a `VITE_*` variable, or paste credentials into the portal.

Start three terminals:

```powershell
# Terminal 1
npm.cmd run portal:dev
```

```powershell
# Terminal 2
npm.cmd run dev:server
```

```powershell
# Terminal 3
$env:BUREAUCRACY_SLAYER_EXECUTION_POLICY = 'live'
npm.cmd run dev:ui
```

Open <http://127.0.0.1:5173> and confirm that the page says **Live website analysis**. An Anthropic request begins only after **Analyze Website** is selected.

The Live pipeline:

1. collects the allowlisted Northstar site with Playwright;
2. selects goal-relevant pages, evidence blocks, and observed actions;
3. performs structured policy extraction and procedure mapping;
4. validates canonical contracts and exact evidence bindings;
5. runs the Semantic Qualifier Audit;
6. evaluates the policy model and plans a guidance-only route.

Model interpretation remains probabilistic. Deterministic validation proves that evidence and references are grounded; it does not guarantee that the extracted interpretation is semantically correct.

## Run a local replay

These modes require no API server and make no Anthropic calls.

Previously recorded Sonnet output:

```powershell
$env:BUREAUCRACY_SLAYER_EXECUTION_POLICY = 'recorded_replay'
npm.cmd run dev:ui
```

Hand-checked deterministic fixture:

```powershell
$env:BUREAUCRACY_SLAYER_EXECUTION_POLICY = 'verified_fixture'
npm.cmd run dev:ui
```

The goal is locked to the selected recording or fixture. The provenance banner identifies the mode and must not be interpreted as fresh website analysis.

## Build and test

```powershell
# Strict TypeScript checking
npm.cmd run typecheck

# Full offline Vitest suite
npm.cmd test

# UI tests
npm.cmd run test:ui

# Offline API integration tests
npm.cmd run test:live-integration

# Build the web application
npm.cmd run build:ui

# Build Northstar Mock Bank
npm.cmd run portal:build
```

Install Chromium before Playwright-backed tests:

```powershell
npx.cmd playwright install chromium
```

`npm.cmd run test:live-extract` is an explicit paid Live extraction command. It is not part of normal development or CI.

## Troubleshooting

### A local port is already in use

```powershell
netstat -ano | Select-String ':5173|:5180|:5190'
Get-Process -Id <PID> | Format-List Id,ProcessName,Path,StartTime
```

Stop only a process you recognize. The development servers use strict ports.

### The offline API is unavailable

Confirm that `npm.cmd run dev:mock-api` is still running and repeat the offline probe. Restart the UI after changing any environment variable.

### The goal is unsupported offline

Use one of the three exact goal strings listed above. The offline mock fails closed for other text.

### The portal shows a canceled transfer

Open the reset URL:

<http://127.0.0.1:5180/dashboard?scenario=a1-scheduled-standard>

### Playwright cannot find Chromium

```powershell
npx.cmd playwright install chromium
```

### Live extraction reports a certificate error

Correct the operating-system or organization trust store. The application deliberately does not bypass TLS certificate verification.

## Safety and scope

- Northstar is a controlled fictional test environment.
- Do not enter real banking information, credentials, or personal data.
- The application is guidance-only and performs no irreversible financial action.
- Missing facts, invalid evidence, unsupported goals, and ambiguous permissions fail closed.
- Bounded collection can miss relevant content.
- Semantic extraction can misunderstand policy text even when its citation exists.
- The prototype is not legal advice, a compliance determination, or a production banking authorization system.

