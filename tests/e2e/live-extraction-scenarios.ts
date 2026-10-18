export type LiveExtractionE2eScenario = Readonly<{
  id: string;
  title: string;
  fakeApiMode:
    | "not_applicable"
    | "successful_timeline"
    | "failed_timeline"
    | "tampered_success";
  requires: readonly ("agent_a_backend" | "agent_b_frontend")[];
  given: readonly string[];
  assertions: readonly string[];
  paidClaudeCalls: 0;
  guidanceOnly: true;
}>;

export const LIVE_EXTRACTION_E2E_SCENARIOS: readonly LiveExtractionE2eScenario[] = [
  {
    id: "verified-fixture-regression",
    title: "Verified Fixture remains functional",
    fakeApiMode: "not_applicable",
    requires: ["agent_b_frontend"],
    given: ["Verified Fixture mode", "scheduled standard fixture facts"],
    assertions: ["the canonical two-step cancellation guidance renders", "no live API request occurs"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "recorded-sonnet-regression",
    title: "Recorded Sonnet remains functional",
    fakeApiMode: "not_applicable",
    requires: ["agent_b_frontend"],
    given: ["Recorded Sonnet mode", "the sanitized recorded extraction bundle"],
    assertions: ["the recorded provenance renders", "no live API request occurs"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "live-start",
    title: "Live mode starts one extraction",
    fakeApiMode: "successful_timeline",
    requires: ["agent_a_backend", "agent_b_frontend"],
    given: ["Live Sonnet mode", "a fresh mode-local workspace"],
    assertions: ["one strict start command is posted", "the fixed goal and portal are not sent"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "live-progress",
    title: "Job progress appears",
    fakeApiMode: "successful_timeline",
    requires: ["agent_a_backend", "agent_b_frontend"],
    given: [
      "queued, collecting, selecting_sources, extracting_policy, mapping_procedure, validating, and succeeded fake states",
    ],
    assertions: ["typed phase labels appear in order", "no invented percentage is displayed"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "standard-cancellation-ready",
    title: "Standard cancellation produces a ready guidance route",
    fakeApiMode: "successful_timeline",
    requires: ["agent_a_backend", "agent_b_frontend"],
    given: ["verified standard scheduled-transfer evidence", "all mandatory user facts"],
    assertions: ["the plan is ready", "the observed cancellation route has exact citations"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "instant-cancellation-forbidden",
    title: "Instant cancellation stays forbidden",
    fakeApiMode: "successful_timeline",
    requires: ["agent_a_backend", "agent_b_frontend"],
    given: ["instant-transfer facts", "verified prohibition evidence"],
    assertions: ["cancellation is forbidden", "confidence cannot override the prohibition"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "completed-cancellation-forbidden",
    title: "Completed cancellation stays forbidden",
    fakeApiMode: "successful_timeline",
    requires: ["agent_a_backend", "agent_b_frontend"],
    given: ["completed-transfer facts", "verified cancellation and recovery policy evidence"],
    assertions: ["direct cancellation is absent", "only an evidenced alternative may render"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "ambiguous-recovery-review",
    title: "Ambiguous recovery stays review-required",
    fakeApiMode: "successful_timeline",
    requires: ["agent_a_backend", "agent_b_frontend"],
    given: ["a schema-valid degraded artifact", "a recovery permission requiring semantic review"],
    assertions: ["review-required is distinct from transport failure", "no ready recovery step renders"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "duplicate-start-idempotency",
    title: "Duplicate clicks do not duplicate paid jobs",
    fakeApiMode: "successful_timeline",
    requires: ["agent_a_backend", "agent_b_frontend"],
    given: ["two start gestures before the first job completes"],
    assertions: ["the same request ID maps to one job", "only one physical fake extraction starts"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "transport-failure",
    title: "A transport failure displays an operational error",
    fakeApiMode: "failed_timeline",
    requires: ["agent_a_backend", "agent_b_frontend"],
    given: ["a terminal STAGE_2_TRANSPORT_FAILED fake state"],
    assertions: ["the typed safe error renders", "no stale plan or raw provider detail renders"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "invalid-evidence-fails-closed",
    title: "Invalid backend evidence fails closed in the frontend",
    fakeApiMode: "tampered_success",
    requires: ["agent_b_frontend"],
    given: ["a success body with a conflicting snapshot, model, or evidence binding"],
    assertions: ["local verification rejects the whole artifact", "no partial plan renders"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "mode-session-isolation",
    title: "Mode switching does not leak sessions",
    fakeApiMode: "successful_timeline",
    requires: ["agent_b_frontend"],
    given: ["an in-flight Live poll", "a switch to Verified Fixture or Recorded Sonnet"],
    assertions: ["Live polling stops locally", "late Live data cannot populate the active mode"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
  {
    id: "guidance-only",
    title: "All actions remain guidance-only",
    fakeApiMode: "successful_timeline",
    requires: ["agent_a_backend", "agent_b_frontend"],
    given: ["every ready scenario and rendered step"],
    assertions: ["every plan step has autoExecutable false", "no execution or submission endpoint is called"],
    paidClaudeCalls: 0,
    guidanceOnly: true,
  },
] as const;
