# HackHarvard offline demo runbook

This is the safe, repeatable P0 demo path. It makes **zero Anthropic API calls**.
Use only Verified Fixture, Recorded Sonnet, and the deterministic Live mock. Never run
`npm.cmd run dev:server` or `npm.cmd run test:live-extract` during an offline rehearsal.

## Requirements

- Windows PowerShell and Chrome.
- Node `^20.19.0` or `>=22.12.0`.
- The `master` worktree at `aae1b88` or a verified descendant.
- Root and `mock-portal` dependencies installed from their lockfiles.
- No API key or `.env` file is required for this offline demo.

From the repository root:

```powershell
git branch --show-current
git merge-base --is-ancestor aae1b88 HEAD; if ($LASTEXITCODE -ne 0) { throw 'Wrong baseline' }
git status --short
node --version
npm.cmd ci --prefer-offline --no-audit --no-fund
npm.cmd --prefix mock-portal ci --prefer-offline --no-audit --no-fund
```

`npm ci` is also the recovery for OneDrive placeholder files that exist but cannot be
resolved by Vite. It must not change either lockfile.

## Port preflight

Never infer process identity from a port number. Inspect listeners before starting:

```powershell
netstat -ano | Select-String ':5173|:5180|:5190'
```

For every reported PID, inspect it before using or stopping it:

```powershell
Get-Process -Id <PID> | Format-List Id,ProcessName,Path,StartTime
```

Expected defaults are UI `5173`, portal `5180`, and deterministic mock API `5190`.
If any port is occupied and its identity is uncertain, do not stop it. Use the isolated
setup below. A page returning HTTP 200 is not enough to prove it is the current UI or
the mock API.

## Standard three-process startup

Use three PowerShell terminals at the repository root. Start them in this order.

Terminal 1 — fictional portal:

```powershell
npm.cmd run portal:dev
```

Terminal 2 — deterministic API mock (not the real server):

```powershell
npm.cmd run dev:mock-api
```

Terminal 3 — UI:

```powershell
npm.cmd run dev:ui
```

Before opening Live mode, prove the UI proxy reaches the mock-only probe:

```powershell
$probe = Invoke-RestMethod 'http://127.0.0.1:5173/api/live-extraction/offline-mock'
if ($probe.offlineMock -ne $true) { throw 'UI is not targeting the deterministic mock API' }
```

Also confirm the portal is the fictional Northstar site:

```powershell
$portal = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:5180/dashboard'
if ($portal.StatusCode -ne 200 -or -not $portal.Content.Contains('Northstar')) {
  throw 'The intended mock portal is not reachable'
}
```

Open `http://127.0.0.1:5173/` in Chrome. Confirm the UI terminal reports the current
worktree and that the page includes the **Guided / All facts** switch after analysis.

## Collision-safe isolated startup

Use this instead of terminating an unknown process. The portal stays on `5180`; verify
it as above. The overrides accept only a decimal port and a `127.0.0.1` HTTP origin.

Terminal 2:

```powershell
$env:BUREAUCRACY_SLAYER_MOCK_API_PORT = '5191'
npm.cmd run dev:mock-api
```

Terminal 3:

```powershell
$env:BUREAUCRACY_SLAYER_LIVE_API_ORIGIN = 'http://127.0.0.1:5191'
npm.cmd run dev:ui -- --port 5177
```

Required safety check:

```powershell
$probe = Invoke-RestMethod 'http://127.0.0.1:5177/api/live-extraction/offline-mock'
if ($probe.offlineMock -ne $true) { throw 'Isolated UI is not targeting the mock API' }
```

Then open `http://127.0.0.1:5177/`. Do not press **Start live extraction** unless the
mock terminal says `Offline Live Extraction mock listening` and the probe succeeds.

## Truthful scenario order

1. **Verified Fixture → Dynamic replanning**: the truthful ready-cancellation path.
   Analyze Scheduled + Standard + processing not begun, then open the cancellation
   citation.
2. In **Guided**, open earlier answers and change Transfer method to **instant**. The
   planner removes cancellation, marks it `PROHIBITED`, adds Contact support, and shows
   `Snapshot unchanged`, `Evidence unchanged`, `No Claude call`, and `No browser collection`.
3. **Recorded Sonnet extraction**: a genuine previously generated model, revalidated
   locally. It remains `Human review required` because Semantic Audit rejects overbroad
   cancellation and recovery permissions.
4. **Live Sonnet extraction with the deterministic mock**: demonstrate queued/running/
   validating lifecycle and browser-side verification. Say explicitly that the response
   is a sanitized deterministic mock of the recorded result, not a new Sonnet call.

Do not claim that Recorded or Live mock authorizes cancellation. Their correct result is
review-required. Every displayed step remains guidance-only with `autoExecutable: false`.

## Reset, refresh, and fallback

- Switching modes creates a fresh mode workspace; facts do not leak across modes.
- Reloading returns the presentation to Verified Fixture.
- During a running Live mock job, reload, select **Live Sonnet extraction**, then click
  **Resume live extraction**. This polls the retained job without another POST.
- A completed Live result is not persisted through a full reload. After a refresh, use
  **Recorded Sonnet extraction** as the deterministic fallback.
- The mock accepts one physical job per process. For another Live rehearsal, stop only
  the mock terminal with `Ctrl+C`, restart `npm.cmd run dev:mock-api`, rerun the mock probe,
  and then start Live again.
- If the mock is unavailable, the UI must show `Live extraction failed operationally`
  with no stale guidance. Restart the mock, rerun the probe, and click
  **Retry live extraction**. The retained request ID keeps the POST idempotent.
- Browser Back/Forward is safe but is not the presentation reset mechanism; switch modes
  or reload instead.

## Deterministic fallback

If Live is slow, unavailable, or its probe fails, do not point the UI at the real server.
Skip Live and show Recorded Sonnet. Recorded uses the immutable saved snapshot/model,
recomputes hashes and evidence, runs Semantic Audit, evaluator, and planner locally, and
makes no Claude or Playwright calls.

## Safe shutdown

Press `Ctrl+C` once in each terminal you started: UI, mock API, then portal. Close the
isolated terminals to clear their environment overrides. Do not use broad `Stop-Process
node`, and never stop a PID you did not start and verify.

## Pre-judging checklist

- [ ] `git status --short` has no unexpected tracked changes.
- [ ] UI, portal, and mock terminals show the intended commands and ports.
- [ ] The mock-only probe succeeds through the UI URL.
- [ ] Chrome is on the current UI origin, not a stale tab.
- [ ] Fixture Dynamic replanning starts at Scheduled + Standard.
- [ ] Fixture citation opens and contains “Scheduled transfers may be canceled before processing begins.”
- [ ] Standard → Instant shows cancellation `PROHIBITED` and `No Claude call`.
- [ ] Recorded Sonnet shows Semantic review and no guidance steps.
- [ ] Live mock has been restarted if it already served one job.
- [ ] Browser zoom is normal; no DevTools or credentials are visible.
- [ ] The presenter will call Fixture, Recorded, and Live mock by their exact names.

## Chrome rehearsal record (2026-10-17)

Three complete rehearsals passed on current `master` using Chrome and the isolated mock:

| Run | Elapsed interaction time | Result |
| --- | ---: | --- |
| A | 71.1 s | Pass — mobile 390×844, keyboard controls, citation, Guided backtracking, Instant prohibition, Recorded review, Live refresh/resume |
| B | 36.6 s | Pass — normal viewport, all required decisions and refresh/resume |
| C | 38.7 s | Pass — normal viewport, all required decisions and refresh/resume |

These timings measure automated on-screen interactions, not spoken narration. Fixture
ready rendering was observed at 0.74 s; mock progress appeared at 0.34 s. Chrome showed
no application console warnings or errors. A preliminary run was partial because stale
servers occupied `5173` and `5190`; it is not counted among the three passes and directly
motivated the isolated-port and mock-probe safeguards.
