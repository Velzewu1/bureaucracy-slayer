# Live Sonnet implementation plan

This plan begins only after the contract in `docs/live-extraction-api.md` and `src/orchestration/live-extraction-contract.ts` is merged. The contract is the handoff boundary; future agents must not reinterpret its fields or add transport data ad hoc.

## Shared decisions frozen by the contract

- API: polling over `POST /api/live-extraction/jobs` and `GET /api/live-extraction/jobs/:jobId`.
- Fixed server-owned portal and goal; the browser supplies neither.
- One active physical extraction worker; request-ID idempotency prevents duplicate paid runs.
- Backend performs collection, the existing two-stage extraction, conversion, semantic audit, and evidence validation.
- Browser strict-parses artifacts, recomputes hashes, reruns the same deterministic audit/validator, then evaluates and plans user facts locally.
- Evidence degradation and semantic review are successful artifacts, not operational failures.
- Cancellation is client-local in P0. It stops polling and never claims to abort an in-flight paid request.
- No action-execution endpoint and no automatic retry.

## Ownership

The contract files are frozen before parallel work. If a contract correction is required, Agent C owns one coordinated change after notifying Agents A and B; A and B pause integration against that schema until it lands.

### Agent A — Backend

Owns:

- `src/server/**`
- `src/orchestration/live-extraction-job*.ts`
- the live composition use case under `src/orchestration/`
- narrowly required bounded-timeout configuration in `src/extractor/anthropic.ts`
- `tests/unit/live-extraction-job*.test.ts`
- `tests/integration/live-extraction-server*.test.ts`

Responsibilities:

1. Implement the loopback-only HTTP adapter and strict request/response parsing.
2. Implement one-worker job lifecycle, random IDs, idempotency, terminal retention, tombstones, and late-result discard.
3. Compose `collectWebsite` and `extractProcedure`; do not create another extractor.
4. Fix portal, goal, goal scope, and collection bounds on the server.
5. Map collector/extractor failures exactly as documented and sanitize messages.
6. Configure Anthropic request timeout and SDK retry count explicitly; live mode uses no automatic retry.
7. Publish only the contract artifact. Never publish raw debug/model/provider envelopes.

Must not edit:

- `src/ui/**`
- `vite.ui.config.ts`
- `package.json` or `package-lock.json`
- the shared contract or canonical contracts after handoff
- cross-component e2e/security tests owned by Agent C

Agent A should prefer Node's built-in HTTP server because all required validation already uses Zod and no server dependency is currently installed. Adding Fastify would require a concrete unmet requirement and Agent C ownership of dependency/config files.

### Agent B — Frontend

Owns:

- `src/ui/adapters/liveExtractionProvider.ts`
- `src/ui/types.ts`
- `src/ui/modeState.ts`
- `src/ui/App.tsx`
- affected components under `src/ui/components/**`
- a browser-safe live artifact verification helper under `src/ui/adapters/`
- `tests/ui/live-*.test.ts`
- existing UI tests that require three-mode expectations

Responsibilities:

1. Add `live_sonnet` as a third mode with a distinct provider and mode-local workspace.
2. Lock the displayed goal and portal to the contract constants; do not send either in the POST body.
3. Implement one POST plus non-overlapping one-second polling, typed failures, cleanup, and resume by retained job ID.
4. Recompute all snapshot hashes, rerun semantic audit/evidence validation with existing shared implementations, and fail closed on differences.
5. Convert the verified artifact into the existing `DemoAnalysis` shape, then locally run evaluator, planner, Decision Intelligence, counterfactuals, and adaptive questioning.
6. Keep Live sessions isolated from Verified Fixture and Recorded Sonnet sessions. Never display stale analysis after a mode switch or a superseded request.
7. Present progress phases and precise operational errors without turning `degraded` or review-required results into generic failures.

Must not edit:

- `src/server/**`
- backend orchestration/job-store files
- `vite.ui.config.ts`
- `package.json` or `package-lock.json`
- the shared live contract or canonical contracts after handoff
- e2e/security tests owned by Agent C

### Agent C — Integration and Security

Owns:

- `vite.ui.config.ts`
- root `package.json` and `package-lock.json` if scripts are necessary
- `tests/e2e/live-extraction*.test.ts`
- cross-component API contract/security tests under `tests/integration/`
- local run documentation and contract-coordination changes

Responsibilities:

1. Add the Vite `/api` proxy to `http://127.0.0.1:5190` and strict development ports without wildcard CORS.
2. Add/start scripts only after the underlying server exists; do not claim a command works before running it.
3. Verify backend and frontend independently conform to the frozen Zod contract.
4. Test fixed-target enforcement, redirect/discovery restrictions, method/body/content-type limits, idempotency, one physical worker, retention, timeout behavior, and response/log secret leakage.
5. Run the complete local vertical slice against the controlled portal with fake transports by default. Any real Sonnet test remains explicit and opt-in.
6. Resolve integration failures in the owning agent's module through coordination; do not build duplicate adapters in integration code.

Must not implement feature logic inside Agent A or B ownership areas.

## Integration order

1. Land and freeze this contract commit.
2. Agent C adds the minimal proxy/port and command scaffolding needed by both sides, then communicates exact local endpoints.
3. Agents A and B work in parallel against the frozen schemas. Both use fake transports in default tests.
4. Agent A publishes a schema-valid fake-success/fake-failure server fixture.
5. Agent B verifies its provider against those fixtures and confirms local replan makes no API call.
6. Agent C runs contract, security, and end-to-end matrices; any schema change is coordinated centrally.
7. Run one explicit live Sonnet rehearsal only after all offline tests are green. Do not save or commit secrets or raw envelopes.

## Test matrix

| Area | Required assertions | Owner |
|---|---|---|
| Shared schemas | Strict request; fixed action; ID formats; discriminated states; artifact identity bindings; unknown-field rejection | Contract commit / C for later changes |
| HTTP boundary | JSON/content-type/body/method handling; status codes; no-store/nosniff; exact-origin behavior | A, cross-checked by C |
| Idempotency | Repeated request ID has one job and one collector/extraction invocation | A/C |
| Capacity | Different request while worker occupied returns `JOB_ALREADY_RUNNING`; timed-out underlying work still occupies worker | A/C |
| Lifecycle | Ordered phases; terminal immutability; two-result/15-minute retention; bounded tombstones; 404 versus 410 | A/C |
| Collector security | Fixed URL; same-origin navigation/discovery; unsafe methods and redirects blocked; no user URL reaches collector | A/C |
| Failure mapping | Every collector failure and each Stage 1/Stage 2 transport/response/output failure retains its public code | A/C |
| Review outcomes | Valid, degraded, invalid, and semantic-audit review artifacts remain successful jobs and display evidence issues | A/B/C |
| Artifact integrity | Browser rejects changed block text/hash, action fingerprint, page/site hash, model binding, evidence disposition, or audit findings | B/C |
| Mode isolation | Switching modes clears Live presentation state; late poll cannot populate another mode; sessions never cross providers | B/C |
| Poll cleanup | One request at a time; timer and fetch abort on unmount/mode change/cancel; no duplicate POST | B |
| Local planning | User-fact edits change evaluation/plan/Decision Intelligence with zero collector or Claude calls | B/C |
| Leakage | No key, workspace ID, Authorization/Cookie header, thinking block, raw response, prompt, Stage DTO, stack, or sensitive input in response/log | A/C |
| Timeout | Logical failure at 180 seconds, late result discarded, no overlapping replacement worker | A/C |

All default tests are offline and deterministic. Use fake clocks, ID generators, collector adapters, and Claude transports.

## Acceptance criteria

- The mode selector contains Verified Fixture, Recorded Sonnet, and Live Sonnet.
- Starting Live Sonnet performs one idempotent POST and visibly reports typed phases while polling.
- The server can collect only `http://127.0.0.1:5180/dashboard` and extract only the fixed goal.
- A successful response contains schema-valid canonical snapshot/model/evidence, source-selection summary, audit, and minimal provenance—nothing from raw Claude transport.
- The browser independently verifies hashes, audit, and evidence through existing deterministic modules before showing a plan.
- `EvidenceResult.status` visibly distinguishes valid from degraded/invalid; audit findings produce review explanations.
- Ready, forbidden, needs-information, and review-required outcomes render with exact citations.
- User-state changes replan locally without collection or Claude.
- Duplicate submissions cannot start duplicate paid calls.
- Mode changes, cancellation, and navigation stop polling without claiming server-side cancellation.
- Single-worker, timeout, retention, body limit, loopback binding, origin, SSRF-navigation, and leak tests pass.
- Verified Fixture and Recorded Sonnet behavior and Decision Intelligence remain green.
- No endpoint performs or authorizes an irreversible browser action.

## Local run target

These are target commands for the implementation phase, not commands available in this contract-only commit:

```powershell
npm install
npm run portal:dev       # portal: http://127.0.0.1:5180
npm run dev:server       # API:    http://127.0.0.1:5190
npm run dev:ui           # UI:     http://127.0.0.1:5173, /api proxied to 5190
```

Required environment remains server-side:

```text
ANTHROPIC_API_KEY
ANTHROPIC_MODEL
ANTHROPIC_MAX_TOKENS
COLLECTOR_TEST_URL=http://127.0.0.1:5180/dashboard
```

The server ignores any browser attempt to override them. Agent C must update this section only after the new command exists and has been run successfully.

Verification before implementation handoff:

```powershell
npm run typecheck
npm test
git diff --check
```

The opt-in `npm run test:live-extract` command is not part of default verification and must not be run for contract or offline implementation tests.

## Known limitation

The existing collector/extractor transport boundary has no abort signal. P0 client cancellation is therefore cleanup of polling, not guaranteed cancellation of server work. Backend timeout is a logical terminal result plus late-result discard; the physical worker remains occupied until the bounded underlying operation settles. A true cancellation contract requires a later, separately tested adapter change and must not be implied by this API.
