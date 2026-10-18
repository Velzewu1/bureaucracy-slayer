# HackHarvard unified demo runbook

The product has one visible workflow: one fixed goal, one controlled website, one
**Analyze Website** action, verified personalization, and one evidence-linked result.
Provider selection is an operator startup policy, never a user-facing mode switch.

## Safety rules

- Offline rehearsals make **zero Anthropic API calls**.
- Never run `npm.cmd run dev:server` or `npm.cmd run test:live-extract` during an
  offline rehearsal.
- Never press **Analyze Website** in an offline browser until the mock-only probe
  succeeds through that exact UI origin.
- The app rejects a mock response in `live` policy and rejects an unmarked response
  in `offline_mock` policy.
- Fixture and recorded replay are explicitly labeled; neither is presented as fresh.

## Requirements and preflight

From `C:\Users\Ansar\OneDrive\Documents\bureaucracy_slayer`:

```powershell
git branch --show-current
git merge-base --is-ancestor 2f41aa0 HEAD; if ($LASTEXITCODE -ne 0) { throw 'Wrong baseline' }
git status --short
node --version
npm.cmd ci --prefer-offline --no-audit --no-fund
npm.cmd --prefix mock-portal ci --prefer-offline --no-audit --no-fund
netstat -ano | Select-String ':5173|:5180|:5190'
```

Inspect any reported PID before using or stopping it:

```powershell
Get-Process -Id <PID> | Format-List Id,ProcessName,Path,StartTime
```

Do not stop an unknown process. Use isolated ports instead.

## Normal genuine-live startup

This is the normal product policy. It can incur Anthropic charges only after the user
presses **Analyze Website**, so use it only with explicit authorization and valid local
configuration.

Terminal 1 — fictional portal:

```powershell
npm.cmd run portal:dev
```

Terminal 2 — real server:

```powershell
$env:BUREAUCRACY_SLAYER_EXECUTION_POLICY = 'live'
npm.cmd run dev:server
```

Terminal 3 — UI:

```powershell
$env:BUREAUCRACY_SLAYER_EXECUTION_POLICY = 'live'
npm.cmd run dev:ui
```

The header must say **Live website analysis** before analysis. Genuine-live execution
is outside the offline judging procedure below.

## Explicit offline mock demo startup

Use three terminals. The execution-policy flag is mandatory: it makes the browser
accept only responses carrying the deterministic mock marker.

Terminal 1 — fictional portal:

```powershell
npm.cmd run portal:dev
```

Terminal 2 — deterministic API mock:

```powershell
$env:BUREAUCRACY_SLAYER_MOCK_API_PORT = '5191'
npm.cmd run dev:mock-api
```

Terminal 3 — unified UI:

```powershell
$env:BUREAUCRACY_SLAYER_EXECUTION_POLICY = 'offline_mock'
$env:BUREAUCRACY_SLAYER_LIVE_API_ORIGIN = 'http://127.0.0.1:5191'
npm.cmd run dev:ui -- --port 5177
```

Prove the exact proxy destination before opening Chrome:

```powershell
$probe = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:5177/api/live-extraction/offline-mock'
if ($probe.StatusCode -ne 200) { throw 'Offline mock probe failed' }
if ($probe.Headers['x-bureaucracy-slayer-offline-mock'] -ne '1') { throw 'Mock marker missing' }
$body = $probe.Content | ConvertFrom-Json
if ($body.offlineMock -ne $true) { throw 'UI proxy is not targeting the offline mock' }
```

Confirm the controlled portal separately:

```powershell
$portal = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:5180/dashboard'
if ($portal.StatusCode -ne 200 -or -not $portal.Content.Contains('Northstar')) {
  throw 'The intended mock portal is not reachable'
}
```

Open `http://127.0.0.1:5177/`. Before clicking, verify the header and provenance
panel both say **Offline mock configured**. After completion they must say
**Deterministic offline mock** and explicitly state that this is not a fresh extraction.

## Unified walkthrough

1. Show the one server-owned goal and Northstar website. Point out that questions are
   locked pending verified policy extraction.
2. Click the single **Analyze Website** button. Show queued, collecting, source
   selection, extraction, and validation states.
3. After delivery, show the truthful review-required result from the sanitized mock,
   the Semantic Audit finding, exact citations, excluded actions, and technical trace.
4. Switch between **Guided** and **All facts**. The views share one `UserState`; answers
   replan locally without collection or Claude.
5. Change an applicable fact such as Standard to Instant. Show the local decision
   trace/counterfactual update and the `No Claude call` / `No browser collection`
   comparison when available. A rejected permission remains unavailable regardless of
   answers.

The current recorded/mock model correctly remains `review_required`; do not claim it
authorizes cancellation. Every step is guidance-only and `autoExecutable: false`.

## Explicit replay fallback

If the mock API is unavailable during judging, stop only the UI terminal and restart it
with one of these explicit policies. Neither command contacts Anthropic or Playwright.

Previously generated Sonnet replay:

```powershell
$env:BUREAUCRACY_SLAYER_EXECUTION_POLICY = 'recorded_replay'
Remove-Item Env:BUREAUCRACY_SLAYER_LIVE_API_ORIGIN -ErrorAction SilentlyContinue
npm.cmd run dev:ui -- --port 5177
```

Hand-checked successful decision fixture:

```powershell
$env:BUREAUCRACY_SLAYER_EXECUTION_POLICY = 'verified_fixture'
Remove-Item Env:BUREAUCRACY_SLAYER_LIVE_API_ORIGIN -ErrorAction SilentlyContinue
npm.cmd run dev:ui -- --port 5177
```

The header exposes **Recorded Sonnet replay** or **Verified fixture**. Analyze once to
load its canonical facts. The fixture is the controlled path for demonstrating a ready
Scheduled + Standard route and deterministic Standard → Instant prohibition; disclose
that it is hand-checked replay data.

## Recovery and interruption

- During a running job, refresh and press **Resume analysis**. The retained job is
  polled without another POST.
- If the initial POST outcome is ambiguous, **Retry analysis** reuses the same request
  ID. Duplicate clicks coalesce into one in-flight operation.
- A failed fresh analysis clears prior facts and guidance. It never falls back silently.
- A completed result is not persisted across a full refresh. Restart the mock for a new
  offline job, rerun the probe, and analyze again; or explicitly restart the UI in a
  replay policy.
- The mock accepts one physical job per process. Restart its own terminal between full
  walkthroughs.

## Safe shutdown

Press `Ctrl+C` once in each terminal you started: UI, mock/API, then portal. Close the
terminals to clear environment overrides. Never use a broad `Stop-Process node`.

## Pre-judging checklist

- [ ] `git status --short` contains no unexpected tracked changes.
- [ ] The correct UI, portal, and API process identities are known.
- [ ] `BUREAUCRACY_SLAYER_EXECUTION_POLICY` matches the intended source.
- [ ] The mock probe succeeds through the exact UI origin before offline analysis.
- [ ] Only one **Analyze Website** button is visible.
- [ ] Personalization is locked before and interactive after verified delivery.
- [ ] Provenance says mock/replay/live truthfully.
- [ ] Review-required rules never create a ready route.
- [ ] Standard → Instant replanning does not collect or call Claude.
- [ ] Browser zoom is normal and no credentials are visible.
