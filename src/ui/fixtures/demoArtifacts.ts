import {
  ProcedureModelSchema,
  SiteSnapshotSchema,
  UserStateSchema,
  hashText,
  type ProcedureModel,
  type SiteSnapshot,
  type UserState,
} from "../../contracts/index.js";
import type { DemoScenario } from "../types.js";

const capturedAt = "2026-10-16T18:00:00.000Z";
const extractedAt = "2026-10-16T18:01:00.000Z";

const policyText = {
  cancellation: "Scheduled transfers may be canceled before processing begins.",
  instant: "Instant transfers cannot be canceled after verification has begun.",
  recovery: "Completed transfers may be submitted for recovery review.",
  support: "If a transfer cannot be canceled, contact support for available options.",
  procedure: "Open the transfer details and choose Cancel transfer to cancel an eligible transfer.",
} as const;

export const demoSnapshot: SiteSnapshot = SiteSnapshotSchema.parse({
  schemaVersion: 1,
  id: "snapshot_primary01",
  siteId: "site_northstar1",
  rootUrl: "https://northstar.test/",
  capturedAt,
  contentHash: "snapshotcontenthash0001",
  pages: [
    {
      id: "page_policy001",
      url: "https://northstar.test/help/transfers",
      canonicalUrl: "https://northstar.test/help/transfers",
      title: "Transfer policies",
      capturedAt,
      contentHash: "pagepolicyhash0001",
      blocks: [
        {
          id: "block_general01",
          text: policyText.cancellation,
          textHash: hashText(policyText.cancellation),
        },
        {
          id: "block_instant01",
          text: policyText.instant,
          textHash: hashText(policyText.instant),
        },
        {
          id: "block_recovery1",
          text: policyText.recovery,
          textHash: hashText(policyText.recovery),
        },
        {
          id: "block_support01",
          text: policyText.support,
          textHash: hashText(policyText.support),
        },
        {
          id: "block_procedure1",
          text: policyText.procedure,
          textHash: hashText(policyText.procedure),
        },
      ],
      actions: [
        {
          id: "action_open001",
          pageId: "page_policy001",
          kind: "link",
          label: "Open transfer details",
          targetUrl: "https://northstar.test/transfers/tx-001",
          method: "GET",
          visible: true,
          enabled: true,
          reversible: true,
          fingerprint: "fingerprintopen001",
          locators: [{ strategy: "role", role: "link", name: "Open transfer details" }],
        },
      ],
    },
    {
      id: "page_transfer01",
      url: "https://northstar.test/transfers/tx-001",
      canonicalUrl: "https://northstar.test/transfers/tx-001",
      title: "Transfer details",
      capturedAt,
      contentHash: "pagetransferhash01",
      blocks: [
        {
          id: "block_transfer01",
          text: "Transfer controls",
          textHash: hashText("Transfer controls"),
        },
      ],
      actions: [
        {
          id: "action_cancel01",
          pageId: "page_transfer01",
          kind: "button",
          label: "Cancel transfer",
          method: "POST",
          visible: true,
          enabled: true,
          reversible: false,
          fingerprint: "fingerprintcancel01",
          locators: [{ strategy: "role", role: "button", name: "Cancel transfer" }],
        },
        {
          id: "action_recover1",
          pageId: "page_transfer01",
          kind: "link",
          label: "Request recovery review",
          targetUrl: "https://northstar.test/support/recovery",
          method: "GET",
          visible: true,
          enabled: true,
          reversible: true,
          fingerprint: "fingerprintrecover1",
          locators: [{ strategy: "role", role: "link", name: "Request recovery review" }],
        },
      ],
    },
  ],
});

export const demoProcedureModel: ProcedureModel = ProcedureModelSchema.parse({
  schemaVersion: 1,
  id: "procedure_payment01",
  sourceSnapshotId: demoSnapshot.id,
  sourceSnapshotHash: demoSnapshot.contentHash,
  extractedAt,
  goalSummary: "Cancel a transfer or use the safest evidenced recovery route.",
  factDefinitions: [
    {
      key: "payment.status",
      label: "Transfer status",
      type: "string",
      allowedValues: ["scheduled", "completed"],
      sensitive: false,
    },
    {
      key: "payment.method",
      label: "Transfer method",
      type: "string",
      allowedValues: ["standard", "instant"],
      sensitive: false,
    },
    {
      key: "transfer.processingBegun",
      label: "Transfer processing has begun",
      type: "boolean",
      sensitive: false,
    },
    {
      key: "verification.begun",
      label: "Verification begun",
      type: "boolean",
      sensitive: false,
    },
    {
      key: "verification.complete",
      label: "Verification complete",
      type: "boolean",
      sensitive: false,
    },
  ],
  actions: [
    {
      id: "proc_open001",
      kind: "navigate",
      label: "Open transfer details",
      description: "Open the observed transfer details page.",
      websiteActionId: "action_open001",
      prerequisiteActionIds: [],
      terminal: false,
    },
    {
      id: "proc_cancel01",
      kind: "interact",
      label: "Cancel transfer",
      description: "Review the transfer and choose the observed Cancel transfer control.",
      websiteActionId: "action_cancel01",
      prerequisiteActionIds: ["proc_open001"],
      terminal: true,
    },
    {
      id: "proc_recover1",
      kind: "navigate",
      label: "Request recovery review",
      description: "Open the observed recovery review route.",
      websiteActionId: "action_recover1",
      prerequisiteActionIds: ["proc_open001"],
      terminal: true,
    },
    {
      id: "proc_support1",
      kind: "user_task",
      label: "Contact support",
      description: "Contact support and ask for available options; do not submit a transaction automatically.",
      prerequisiteActionIds: [],
      terminal: true,
    },
  ],
  goalActionIds: ["proc_cancel01", "proc_recover1", "proc_support1"],
  rules: [
    {
      id: "rule_openpermit1",
      actionId: "proc_open001",
      effect: "permit",
      appliesWhen: { kind: "always" },
      citations: [
        {
          pageId: "page_policy001",
          pageUrl: "https://northstar.test/help/transfers",
          blockId: "block_procedure1",
          excerpt: policyText.procedure,
          actionIds: ["action_open001"],
        },
      ],
      semanticConfidence: 0.99,
      needsReview: false,
    },
    {
      id: "rule_cancelpermit1",
      actionId: "proc_cancel01",
      effect: "permit",
      appliesWhen: {
        kind: "all",
        conditions: [
          { kind: "fact", fact: "payment.status", op: "eq", value: "scheduled" },
          { kind: "fact", fact: "payment.method", op: "eq", value: "standard" },
          { kind: "fact", fact: "transfer.processingBegun", op: "eq", value: false },
        ],
      },
      citations: [
        {
          pageId: "page_policy001",
          pageUrl: "https://northstar.test/help/transfers",
          blockId: "block_general01",
          excerpt: policyText.cancellation,
          actionIds: [],
        },
      ],
      semanticConfidence: 0.98,
      needsReview: false,
    },
    {
      id: "rule_instantdeny1",
      actionId: "proc_cancel01",
      effect: "prohibit",
      appliesWhen: {
        kind: "all",
        conditions: [
          { kind: "fact", fact: "payment.method", op: "eq", value: "instant" },
          { kind: "fact", fact: "verification.begun", op: "eq", value: true },
        ],
      },
      citations: [
        {
          pageId: "page_policy001",
          pageUrl: "https://northstar.test/help/transfers",
          blockId: "block_instant01",
          excerpt: policyText.instant,
          actionIds: [],
        },
      ],
      semanticConfidence: 0.99,
      needsReview: false,
    },
    {
      id: "rule_verifyreq01",
      actionId: "proc_cancel01",
      effect: "require_condition",
      appliesWhen: { kind: "always" },
      requirement: {
        kind: "fact",
        fact: "verification.complete",
        op: "eq",
        value: true,
      },
      citations: [
        {
          pageId: "page_policy001",
          pageUrl: "https://northstar.test/help/transfers",
          blockId: "block_procedure1",
          excerpt: policyText.procedure,
          actionIds: [],
        },
      ],
      semanticConfidence: 0.9,
      needsReview: false,
    },
    {
      id: "rule_recoverok01",
      actionId: "proc_recover1",
      effect: "permit",
      appliesWhen: {
        kind: "fact",
        fact: "payment.status",
        op: "eq",
        value: "completed",
      },
      citations: [
        {
          pageId: "page_policy001",
          pageUrl: "https://northstar.test/help/transfers",
          blockId: "block_recovery1",
          excerpt: policyText.recovery,
          actionIds: [],
        },
      ],
      semanticConfidence: 0.97,
      needsReview: false,
    },
    {
      id: "rule_supportok01",
      actionId: "proc_support1",
      effect: "permit",
      appliesWhen: {
        kind: "all",
        conditions: [
          { kind: "fact", fact: "payment.method", op: "eq", value: "instant" },
          { kind: "fact", fact: "verification.begun", op: "eq", value: true },
        ],
      },
      citations: [
        {
          pageId: "page_policy001",
          pageUrl: "https://northstar.test/help/transfers",
          blockId: "block_support01",
          excerpt: policyText.support,
          actionIds: [],
        },
      ],
      semanticConfidence: 0.96,
      needsReview: false,
    },
  ],
});

function userState(revision: number, facts: UserState["facts"]): UserState {
  return UserStateSchema.parse({ schemaVersion: 1, revision, facts });
}

export const scheduledStandardState = userState(1, {
  "payment.status": "scheduled",
  "payment.method": "standard",
  "transfer.processingBegun": false,
  "verification.begun": true,
  "verification.complete": true,
});

export const scheduledInstantState = userState(1, {
  "payment.status": "scheduled",
  "payment.method": "instant",
  "transfer.processingBegun": false,
  "verification.begun": true,
  "verification.complete": true,
});

export const unknownMethodState = userState(1, {
  "payment.status": "scheduled",
  "transfer.processingBegun": false,
  "verification.begun": true,
  "verification.complete": true,
});

export const wrongQuoteModel: ProcedureModel = ProcedureModelSchema.parse({
  ...demoProcedureModel,
  id: "procedure_badquote1",
  rules: demoProcedureModel.rules.map((rule) =>
    rule.id === "rule_cancelpermit1"
      ? {
          ...rule,
          citations: rule.citations.map((citation) => ({
            ...citation,
            excerpt: "Scheduled transfers are always cancellable.",
          })),
        }
      : rule,
  ),
});

export const demoScenarios: readonly DemoScenario[] = [
  {
    id: "policy-exception",
    experiment: "Experiment A",
    label: "Policy exception",
    description: "An instant transfer activates a specific prohibition and redirects the safe route to support.",
    defaultUserState: scheduledInstantState,
  },
  {
    id: "dynamic-replanning",
    experiment: "Experiment B",
    label: "Dynamic replanning",
    description: "Change the transfer method from standard to instant and replan without Claude or Playwright.",
    defaultUserState: scheduledStandardState,
  },
  {
    id: "unknown-fact",
    experiment: "Decision question",
    label: "Unknown transfer method",
    description:
      "An unanswered relevant fact triggers a ranked question backed by deterministic what-if outcomes.",
    defaultUserState: unknownMethodState,
  },
  {
    id: "evidence-failure",
    experiment: "Experiment C",
    label: "Evidence failure",
    description: "A mismatched policy quote is rejected, so the planner refuses a confident recommendation.",
    defaultUserState: scheduledStandardState,
  },
];

export const demoGoal =
  "I accidentally sent $850 to the wrong person. Can I cancel the transfer or recover the money?";
