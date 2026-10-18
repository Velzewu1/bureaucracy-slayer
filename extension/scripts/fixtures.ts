import {
  ProcedureModelSchema,
  UserStateSchema,
  hashCanonical,
  type ProcedureModel,
  type UserState,
} from "../../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import { validateEvidence } from "../../src/evidence/index.js";
import { auditSemanticQualifiers } from "../../src/extractor/semantic-audit.js";
import {
  RecordedExtractionProvider,
  recordedExtractionBundle,
} from "../../src/ui/adapters/recordedExtractionProvider.js";
import type { GuidanceEnvelope } from "../src/envelope.js";
import { buildGuidanceEnvelope } from "./envelope-builder.js";

/**
 * Deterministic, offline fixture envelopes for the extension demo.
 *
 * - The snapshot is the RECORDED Northstar observation (real pages/actions).
 * - "Review required" uses the recorded Sonnet model unmodified (no API call).
 * - The cancel route model below is HAND-AUTHORED (not recorded) so that a
 *   ready route exists; it still passes through the real evidence validator,
 *   semantic audit, evaluator and planner. Nothing here is a live extraction.
 */

const snapshot = recordedExtractionBundle.sourceSnapshot;
const fixedClock = "2026-10-17T00:00:00.000Z";
const VALID_FOR_MS = 15 * 60 * 1000;
const goal = recordedExtractionBundle.extractionGoal;

const ids = {
  dashboardPage: "page_a0c2f9656e8c8467e179",
  helpTransfersPage: "page_e78fd49ae38512a93640",
  instantPage: "page_d01fb7cef56b70be985a",
  openDetailsAction: "action_1a62f2a6f52044f0680f",
  cancelButtonAction: "action_cec971f543cc085511e5",
} as const;

const excerpts = {
  open: "Open the transfer to see your options",
  standardCancel:
    "A scheduled standard transfer may be canceled from its transfer details page at any time before processing begins.",
  processing: "Once a transfer is processing, it can no longer be canceled online.",
  completed: "A completed transfer can't be directly canceled at all, because the money has already been delivered to the recipient.",
  instant: "An instant transfer can't be canceled once it has been submitted.",
} as const;

function citation(pageId: string, pageUrl: string, blockId: string, excerpt: string, actionIds: string[] = []) {
  return { pageId, pageUrl, blockId, excerpt, actionIds };
}

function authoredCancelModel(overrides: { standardExcerpt?: string } = {}): ProcedureModel {
  const dashboardUrl = `${new URL(snapshot.rootUrl).origin}/dashboard`;
  const helpUrl = `${new URL(snapshot.rootUrl).origin}/help/transfers`;
  const instantUrl = `${new URL(snapshot.rootUrl).origin}/help/instant-transfers`;
  return ProcedureModelSchema.parse({
    schemaVersion: 1,
    id: "procedure_extension_demo_cancel",
    sourceSnapshotId: snapshot.id,
    sourceSnapshotHash: snapshot.contentHash,
    extractedAt: fixedClock,
    goalSummary: "Cancel a scheduled standard transfer (hand-authored extension demo).",
    factDefinitions: [
      { key: "transfer_status", label: "Transfer status", type: "string", allowedValues: ["scheduled", "completed"], sensitive: false },
      { key: "payment_method", label: "Payment method", type: "string", allowedValues: ["standard", "instant"], sensitive: false },
      { key: "processing_started", label: "Transfer processing has begun", type: "boolean", sensitive: false },
    ],
    actions: [
      {
        id: "proc_open_transfer",
        kind: "navigate",
        label: "Open the transfer details",
        description: "Open the transfer from your dashboard to see its status and options.",
        websiteActionId: ids.openDetailsAction,
        prerequisiteActionIds: [],
        terminal: false,
      },
      {
        id: "proc_cancel_transfer",
        kind: "interact",
        label: "Cancel the transfer",
        description:
          "On the transfer details page, review the status and, if you still want to, use the Cancel transfer control yourself.",
        websiteActionId: ids.cancelButtonAction,
        prerequisiteActionIds: ["proc_open_transfer"],
        terminal: true,
      },
    ],
    goalActionIds: ["proc_cancel_transfer"],
    rules: [
      {
        id: "rule_open_permit",
        actionId: "proc_open_transfer",
        effect: "permit",
        appliesWhen: { kind: "always" },
        citations: [
          citation(ids.dashboardPage, dashboardUrl, "block_643694cf922111f295a6", excerpts.open, [ids.openDetailsAction]),
        ],
        semanticConfidence: 0.95,
        needsReview: false,
      },
      {
        id: "rule_cancel_permit",
        actionId: "proc_cancel_transfer",
        effect: "permit",
        appliesWhen: {
          kind: "all",
          conditions: [
            { kind: "fact", fact: "transfer_status", op: "eq", value: "scheduled" },
            { kind: "fact", fact: "payment_method", op: "eq", value: "standard" },
            { kind: "fact", fact: "processing_started", op: "eq", value: false },
          ],
        },
        citations: [
          citation(ids.helpTransfersPage, helpUrl, "block_fc059175893c4915951c", overrides.standardExcerpt ?? excerpts.standardCancel),
        ],
        semanticConfidence: 0.95,
        needsReview: false,
      },
      {
        id: "rule_cancel_deny_processing",
        actionId: "proc_cancel_transfer",
        effect: "prohibit",
        appliesWhen: { kind: "fact", fact: "processing_started", op: "eq", value: true },
        citations: [citation(ids.helpTransfersPage, helpUrl, "block_7205f3b02098bdd5cda6", excerpts.processing)],
        semanticConfidence: 0.95,
        needsReview: false,
      },
      {
        id: "rule_cancel_deny_completed",
        actionId: "proc_cancel_transfer",
        effect: "prohibit",
        appliesWhen: { kind: "fact", fact: "transfer_status", op: "eq", value: "completed" },
        citations: [citation(ids.helpTransfersPage, helpUrl, "block_7205f3b02098bdd5cda6", excerpts.completed)],
        semanticConfidence: 0.95,
        needsReview: false,
      },
      {
        id: "rule_cancel_deny_instant",
        actionId: "proc_cancel_transfer",
        effect: "prohibit",
        appliesWhen: { kind: "fact", fact: "payment_method", op: "eq", value: "instant" },
        citations: [citation(ids.instantPage, instantUrl, "block_0408d3189733d101eb07", excerpts.instant)],
        semanticConfidence: 0.95,
        needsReview: false,
      },
    ],
  });
}

function userState(revision: number, facts: UserState["facts"]): UserState {
  return UserStateSchema.parse({ schemaVersion: 1, revision, facts });
}

async function authoredEnvelope(
  options: Readonly<{
    key: string;
    sessionId: string;
    sequence: number;
    state: UserState;
    model?: ProcedureModel;
    label: string;
  }>,
): Promise<GuidanceEnvelope> {
  const model = options.model ?? authoredCancelModel();
  const audit = auditSemanticQualifiers(snapshot, model);
  const validation = validateEvidence(
    snapshot,
    model,
    { evidenceResultId: `evidence_ext_${options.key}`, checkedAt: fixedClock },
    audit.findings.map((finding) => ({ ruleId: finding.ruleId, message: finding.message })),
  );
  if (!validation.ok) throw new Error(`Authored fixture ${options.key} failed ${validation.stage} validation.`);
  const evaluation = evaluatePolicies(model, validation.evidence, options.state);
  const plan = planActions(model, validation.evidence, evaluation, options.state, {
    planId: `plan_ext_${options.key}`,
    generatedAt: fixedClock,
    userStateHash: hashCanonical(options.state),
  });
  return buildGuidanceEnvelope({
    snapshot,
    model,
    evidence: validation.evidence,
    plan,
    goal,
    sessionId: options.sessionId,
    sequence: options.sequence,
    validForMs: VALID_FOR_MS,
    sourceLabel: options.label,
  });
}

export type FixtureEntry = Readonly<{ id: string; label: string; envelope: GuidanceEnvelope }>;

export async function buildFixtureEnvelopes(): Promise<readonly FixtureEntry[]> {
  const authoredLabel = "Fixture demonstration (hand-authored route over the recorded Northstar snapshot)";
  const readyState = userState(1, { transfer_status: "scheduled", payment_method: "standard", processing_started: false });
  const changedState = userState(2, { transfer_status: "scheduled", payment_method: "standard", processing_started: true });
  const unknownState = userState(1, { transfer_status: "scheduled", processing_started: false });

  const recorded = new RecordedExtractionProvider({ now: () => fixedClock });
  const recordedAnalysis = await recorded.analyze({
    goal,
    portalUrl: snapshot.rootUrl,
    scenarioId: "dynamic-replanning",
    userState: recordedExtractionBundle.defaultScenario.userState,
  });

  return [
    {
      id: "cancel-ready",
      label: "1. Verified cancellation route (scheduled, standard)",
      envelope: await authoredEnvelope({ key: "ready", sessionId: "demo-cancel", sequence: 1, state: readyState, label: authoredLabel }),
    },
    {
      id: "cancel-facts-changed",
      label: "2. Same session after facts changed (processing began)",
      envelope: await authoredEnvelope({ key: "changed", sessionId: "demo-cancel", sequence: 2, state: changedState, label: authoredLabel }),
    },
    {
      id: "needs-information",
      label: "3. Payment method unknown (needs information)",
      envelope: await authoredEnvelope({ key: "unknown", sessionId: "demo-unknown", sequence: 1, state: unknownState, label: authoredLabel }),
    },
    {
      id: "missing-evidence",
      label: "4. Policy quote not found on page (evidence rejected)",
      envelope: await authoredEnvelope({
        key: "badquote",
        sessionId: "demo-evidence",
        sequence: 1,
        state: readyState,
        model: authoredCancelModel({ standardExcerpt: "Scheduled transfers are always cancellable." }),
        label: authoredLabel,
      }),
    },
    {
      id: "review-required-recorded",
      label: "5. Recorded Sonnet analysis (review required)",
      envelope: await buildGuidanceEnvelope({
        snapshot: recordedAnalysis.snapshot,
        model: recordedAnalysis.model,
        evidence: recordedAnalysis.evidence,
        plan: recordedAnalysis.plan,
        goal,
        sessionId: "demo-recorded",
        sequence: 1,
        validForMs: VALID_FOR_MS,
        sourceLabel: "Fixture demonstration (replay of a recorded extraction; no API call)",
      }),
    },
  ];
}
