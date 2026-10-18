# Bureaucracy Slayer Guide (Chrome MV3)

Guidance-only companion for the **Northstar Mock Bank** loopback portal. It helps a person follow a verified route. It is not an evaluator, extractor, or autonomous browser controller.

## Fixture demonstration, not live sync

This build does **not** live-synchronize with the Bureaucracy Slayer app. There is no existing read-only plan-export boundary that an extension can trust.

Routes shown in the side panel are **prebuilt guidance envelopes** produced offline by the deterministic pipeline (evidence validator → evaluator → planner). The panel states `Offline fixture — not a live analysis.` Type one of the three recognized demonstration goals. Any other sentence is refused and does not select a different fixture. Developer controls can still load fixtures for testing; they are not part of normal use.

No Anthropic API calls are made at build, test, or run time.

## Load unpacked

1. Start Northstar: `npm run portal:dev` (http://127.0.0.1:5180).
2. Build: `npm run build:extension`. Output is `extension/dist/`.
3. Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `extension/dist`.
4. Open Northstar, then click the extension action to open the side panel.
5. Type a recognized goal, such as `Can I cancel my scheduled bank transfer?`, and click **Analyze Website**. Answer the questions the fixture asks. The extension never clicks the page for you.

Automated real-browser check (uses Edge or Chrome for Testing, because current branded Chrome ignores `--load-extension`):

```
npm run build:extension
npm run portal:dev
npm run verify:extension
```

## Permissions

| Permission | Why |
|---|---|
| `sidePanel` | Show the guide beside Northstar. |
| `storage` | Session-scoped envelope and freshness only. |
| `host_permissions: http://127.0.0.1:5180/*` | Query/update the local portal tab and inject the highlight-only content script. |

No history, cookies, `<all_urls>`, remote code, or telemetry.

## What the extension will and will not do

- **Will:** display a verified route, open an observed GET navigation target after an explicit click, highlight one unambiguous observed control.
- **Will not:** click, submit, cancel, type, or send anything on the page. State-changing controls (Cancel, Submit) are highlighted as “do this yourself” only.
- **Fail closed:** review-required, blocked, needs-information, stale, expired, invalidated, tampered, ungrounded, or unsupported-origin data never yields a navigable route.
