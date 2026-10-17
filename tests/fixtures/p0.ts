import { hashText } from "../../src/contracts/index.js";

const CAPTURED_AT = "2026-10-16T18:00:00.000Z";
const EXTRACTED_AT = "2026-10-16T18:01:00.000Z";

const generalPolicy = "Scheduled transfers may be canceled before processing begins.";
const instantPolicy = "Instant transfers cannot be canceled after verification has begun.";
const recoveryPolicy = "Completed transfers may be submitted for recovery review.";
const supportPolicy = "If a transfer cannot be canceled, contact support for available options.";
const procedurePolicy = "Open the transfer details and choose Cancel transfer to cancel an eligible transfer.";
const conflictingPolicy = "Instant transfers may be canceled while their status is Scheduled.";

export const evidenceContextFixture = {
  evidenceResultId: "evidence_result001",
  checkedAt: "2026-10-16T18:02:00.000Z",
} as const;

export const plannerContextFixture = {
  planId: "plan_result0001",
  generatedAt: "2026-10-16T18:03:00.000Z",
  userStateHash: "userstatehash0001",
} as const;

export const baseSnapshotFixture = {
  schemaVersion: 1,
  id: "snapshot_primary01",
  siteId: "site_northstar1",
  rootUrl: "https://northstar.test/",
  capturedAt: CAPTURED_AT,
  contentHash: "snapshotcontenthash0001",
  pages: [
    {
      id: "page_policy001",
      url: "https://northstar.test/help/transfers",
      canonicalUrl: "https://northstar.test/help/transfers",
      title: "Transfer policies",
      capturedAt: CAPTURED_AT,
      contentHash: "pagepolicyhash0001",
      blocks: [
        { id: "block_general01", text: generalPolicy, textHash: hashText(generalPolicy) },
        { id: "block_instant01", text: instantPolicy, textHash: hashText(instantPolicy) },
        { id: "block_recovery1", text: recoveryPolicy, textHash: hashText(recoveryPolicy) },
        { id: "block_support01", text: supportPolicy, textHash: hashText(supportPolicy) },
        { id: "block_procedure1", text: procedurePolicy, textHash: hashText(procedurePolicy) },
        { id: "block_conflict01", text: conflictingPolicy, textHash: hashText(conflictingPolicy) },
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
      capturedAt: CAPTURED_AT,
      contentHash: "pagetransferhash01",
      blocks: [{ id: "block_transfer01", text: "Transfer controls", textHash: hashText("Transfer controls") }],
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
} as const;

const openPermitRule = {
  id: "rule_openpermit1",
  actionId: "proc_open001",
  effect: "permit",
  appliesWhen: { kind: "always" },
  citations: [
    {
      pageId: "page_policy001",
      pageUrl: "https://northstar.test/help/transfers",
      blockId: "block_procedure1",
      excerpt: procedurePolicy,
      actionIds: ["action_open001"],
    },
  ],
  semanticConfidence: 0.99,
  needsReview: false,
} as const;

const cancelPermitRule = {
  id: "rule_cancelpermit1",
  actionId: "proc_cancel01",
  effect: "permit",
  appliesWhen: {
    kind: "all",
    conditions: [
      { kind: "fact", fact: "payment.status", op: "eq", value: "scheduled" },
      { kind: "fact", fact: "payment.beforeDeadline", op: "eq", value: true },
    ],
  },
  citations: [
    {
      pageId: "page_policy001",
      pageUrl: "https://northstar.test/help/transfers",
      blockId: "block_general01",
      excerpt: generalPolicy,
      actionIds: [],
    },
  ],
  semanticConfidence: 0.98,
  needsReview: false,
} as const;

const instantProhibitionRule = {
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
      excerpt: instantPolicy,
      actionIds: [],
    },
  ],
  semanticConfidence: 0.99,
  needsReview: false,
} as const;

const verificationRequirementRule = {
  id: "rule_verifyreq01",
  actionId: "proc_cancel01",
  effect: "require_condition",
  appliesWhen: { kind: "always" },
  requirement: { kind: "fact", fact: "verification.complete", op: "eq", value: true },
  citations: [
    {
      pageId: "page_policy001",
      pageUrl: "https://northstar.test/help/transfers",
      blockId: "block_procedure1",
      excerpt: procedurePolicy,
      actionIds: [],
    },
  ],
  semanticConfidence: 0.9,
  needsReview: false,
} as const;

const recoveryPermitRule = {
  id: "rule_recoverok01",
  actionId: "proc_recover1",
  effect: "permit",
  appliesWhen: { kind: "fact", fact: "payment.status", op: "eq", value: "completed" },
  citations: [
    {
      pageId: "page_policy001",
      pageUrl: "https://northstar.test/help/transfers",
      blockId: "block_recovery1",
      excerpt: recoveryPolicy,
      actionIds: [],
    },
  ],
  semanticConfidence: 0.97,
  needsReview: false,
} as const;

const supportPermitRule = {
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
      excerpt: supportPolicy,
      actionIds: [],
    },
  ],
  semanticConfidence: 0.96,
  needsReview: false,
} as const;

export const baseProcedureModelFixture = {
  schemaVersion: 1,
  id: "procedure_payment01",
  sourceSnapshotId: "snapshot_primary01",
  sourceSnapshotHash: "snapshotcontenthash0001",
  extractedAt: EXTRACTED_AT,
  goalSummary: "Cancel a transfer or use the safest evidenced recovery route.",
  factDefinitions: [
    { key: "payment.status", label: "Payment status", type: "string", allowedValues: ["scheduled", "completed"], sensitive: false },
    { key: "payment.method", label: "Payment method", type: "string", allowedValues: ["standard", "instant"], sensitive: false },
    { key: "payment.beforeDeadline", label: "Before cancellation deadline", type: "boolean", sensitive: false },
    { key: "verification.begun", label: "Verification begun", type: "boolean", sensitive: false },
    { key: "verification.complete", label: "Verification complete", type: "boolean", sensitive: false },
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
      description: "Ask the user to review and choose the observed Cancel transfer control.",
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
      description: "Contact support and ask for the available options; do not submit a transaction automatically.",
      prerequisiteActionIds: [],
      terminal: true,
    },
  ],
  goalActionIds: ["proc_cancel01", "proc_recover1", "proc_support1"],
  rules: [openPermitRule, cancelPermitRule, instantProhibitionRule, verificationRequirementRule, recoveryPermitRule, supportPermitRule],
} as const;

export const scheduledStandardStateFixture = {
  schemaVersion: 1,
  revision: 1,
  facts: {
    "payment.status": "scheduled",
    "payment.method": "standard",
    "payment.beforeDeadline": true,
    "verification.begun": false,
    "verification.complete": true,
  },
} as const;

export const scheduledInstantStateFixture = {
  schemaVersion: 1,
  revision: 1,
  facts: {
    "payment.status": "scheduled",
    "payment.method": "instant",
    "payment.beforeDeadline": true,
    "verification.begun": true,
    "verification.complete": true,
  },
} as const;

export const completedStateFixture = {
  schemaVersion: 1,
  revision: 2,
  facts: {
    "payment.status": "completed",
    "payment.method": "standard",
    "payment.beforeDeadline": false,
    "verification.begun": true,
    "verification.complete": true,
  },
} as const;

export const unknownMethodStateFixture = {
  schemaVersion: 1,
  revision: 1,
  facts: {
    "payment.status": "scheduled",
    "payment.beforeDeadline": true,
    "verification.begun": true,
    "verification.complete": true,
  },
} as const;

export const wrongQuoteModelFixture = {
  ...baseProcedureModelFixture,
  id: "procedure_badquote1",
  rules: baseProcedureModelFixture.rules.map((rule) =>
    rule.id === "rule_cancelpermit1"
      ? { ...rule, citations: rule.citations.map((citation) => ({ ...citation, excerpt: "Scheduled transfers are always cancellable." })) }
      : rule,
  ),
} as const;

export const invalidSourceModelFixture = {
  ...baseProcedureModelFixture,
  id: "procedure_badsource1",
  rules: baseProcedureModelFixture.rules.map((rule) =>
    rule.id === "rule_cancelpermit1"
      ? { ...rule, citations: rule.citations.map((citation) => ({ ...citation, blockId: "block_missing01" })) }
      : rule,
  ),
} as const;

export const semanticReviewModelFixture = {
  ...baseProcedureModelFixture,
  id: "procedure_semantic1",
  rules: baseProcedureModelFixture.rules.map((rule) =>
    rule.id === "rule_cancelpermit1"
      ? { ...rule, needsReview: true, reviewReason: "The quotation does not establish whether this user's transfer type is in scope." }
      : rule,
  ),
} as const;

const conflictingPermitRule = {
  id: "rule_oldfaqok01",
  actionId: "proc_cancel01",
  effect: "permit",
  appliesWhen: {
    kind: "all",
    conditions: [
      { kind: "fact", fact: "payment.status", op: "eq", value: "scheduled" },
      { kind: "fact", fact: "payment.method", op: "eq", value: "instant" },
    ],
  },
  citations: [
    {
      pageId: "page_policy001",
      pageUrl: "https://northstar.test/help/transfers",
      blockId: "block_conflict01",
      excerpt: conflictingPolicy,
      actionIds: [],
    },
  ],
  semanticConfidence: 0.7,
  needsReview: false,
} as const;

export const conflictingEvidenceModelFixture = {
  ...baseProcedureModelFixture,
  id: "procedure_conflict1",
  goalActionIds: ["proc_cancel01"],
  rules: [...baseProcedureModelFixture.rules, conflictingPermitRule],
} as const;

export const cycleModelFixture = {
  ...baseProcedureModelFixture,
  id: "procedure_cycle001",
  actions: baseProcedureModelFixture.actions.map((action) =>
    action.id === "proc_open001" ? { ...action, prerequisiteActionIds: ["proc_cancel01"] } : action,
  ),
} as const;

export const brokenReferenceModelFixture = {
  ...baseProcedureModelFixture,
  id: "procedure_broken01",
  actions: baseProcedureModelFixture.actions.map((action) =>
    action.id === "proc_cancel01" ? { ...action, prerequisiteActionIds: ["proc_missing01"] } : action,
  ),
} as const;

export const missingEvidenceModelFixture = {
  ...baseProcedureModelFixture,
  id: "procedure_noevidence1",
  rules: baseProcedureModelFixture.rules.map((rule) =>
    rule.id === "rule_cancelpermit1" ? { ...rule, citations: [] } : rule,
  ),
} as const;

export const malformedExtractionFixture = {
  schemaVersion: 1,
  id: "procedure_malformed1",
  sourceSnapshotId: "snapshot_primary01",
  actions: "not-an-array",
} as const;

