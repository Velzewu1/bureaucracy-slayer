import { z } from "zod";

import {
  EvidenceResultSchema,
  ProcedureModelSchema,
  SiteSnapshotSchema,
  normalizeEvidenceText,
  type EvidenceIssue,
  type EvidenceResult,
  type PolicyCondition,
  type ProcedureModel,
  type SiteSnapshot,
} from "../contracts/index.js";
import { hashEvidenceBlockText } from "../shared/index.js";

export type EvidenceValidationFailure = Readonly<{
  ok: false;
  stage: "snapshot_schema" | "procedure_schema";
  issues: readonly string[];
}>;

export type EvidenceValidationSuccess = Readonly<{
  ok: true;
  snapshot: SiteSnapshot;
  model: ProcedureModel;
  evidence: EvidenceResult;
}>;

export type EvidenceValidationOutcome = EvidenceValidationFailure | EvidenceValidationSuccess;

export type EvidenceValidationContext = Readonly<{
  evidenceResultId: string;
  checkedAt: string;
}>;

export type AdditionalSemanticReview = Readonly<{
  ruleId: string;
  message: string;
}>;

function formatZodIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function findDependencyCycles(model: ProcedureModel): readonly string[] {
  const actions = new Map(model.actions.map((action) => [action.id, action]));
  const state = new Map<string, "visiting" | "visited">();
  const cycles = new Set<string>();

  function visit(actionId: string, path: readonly string[]): void {
    const currentState = state.get(actionId);
    if (currentState === "visiting") {
      const cycleStart = path.indexOf(actionId);
      const cycleMembers = cycleStart >= 0 ? path.slice(cycleStart) : [actionId];
      for (const member of cycleMembers) cycles.add(member);
      return;
    }
    if (currentState === "visited") return;

    state.set(actionId, "visiting");
    const action = actions.get(actionId);
    if (action !== undefined) {
      const ruleDependencies = model.rules.flatMap((rule) =>
        rule.actionId === actionId && rule.effect === "require_action" ? [rule.requiredActionId] : [],
      );
      const dependencies = [...action.prerequisiteActionIds, ...ruleDependencies].sort();
      for (const dependencyId of dependencies) visit(dependencyId, [...path, actionId]);
    }
    state.set(actionId, "visited");
  }

  for (const action of [...model.actions].sort((left, right) => left.id.localeCompare(right.id))) {
    visit(action.id, []);
  }
  return [...cycles].sort();
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

function pageIsAllowed(rootUrl: string, page: SiteSnapshot["pages"][number]): boolean {
  return sameOrigin(rootUrl, page.url) && sameOrigin(rootUrl, page.canonicalUrl);
}

function conditionFactReferenceIssues(
  condition: PolicyCondition,
  factDefinitions: ReadonlyMap<string, ProcedureModel["factDefinitions"][number]>,
): readonly string[] {
  switch (condition.kind) {
    case "always":
      return [];
    case "fact": {
      const definition = factDefinitions.get(condition.fact);
      if (definition === undefined) return [`Rule references undeclared fact ${condition.fact}.`];

      const expectedValues = Array.isArray(condition.value) ? condition.value : [condition.value];
      if (expectedValues.some((value) => typeof value !== definition.type)) {
        return [`Rule comparison type does not match the definition of ${condition.fact}.`];
      }
      if (
        definition.allowedValues !== undefined &&
        definition.allowedValues.some((value) => typeof value !== definition.type)
      ) {
        return [`Allowed values do not match the definition type of ${condition.fact}.`];
      }
      return [];
    }
    case "not":
      return conditionFactReferenceIssues(condition.condition, factDefinitions);
    case "all":
    case "any":
      return condition.conditions.flatMap((child) => conditionFactReferenceIssues(child, factDefinitions));
  }
}

export function validateEvidence(
  snapshotInput: unknown,
  modelInput: unknown,
  context: EvidenceValidationContext,
  additionalSemanticReviews: readonly AdditionalSemanticReview[] = [],
): EvidenceValidationOutcome {
  const snapshotResult = SiteSnapshotSchema.safeParse(snapshotInput);
  if (!snapshotResult.success) {
    return { ok: false, stage: "snapshot_schema", issues: formatZodIssues(snapshotResult.error) };
  }

  const modelResult = ProcedureModelSchema.safeParse(modelInput);
  if (!modelResult.success) {
    return { ok: false, stage: "procedure_schema", issues: formatZodIssues(modelResult.error) };
  }

  const snapshot = snapshotResult.data;
  const model = modelResult.data;
  const issues: EvidenceIssue[] = [];
  const addIssue = (issue: EvidenceIssue): void => {
    issues.push(issue);
  };

  const snapshotMatches =
    model.sourceSnapshotId === snapshot.id && model.sourceSnapshotHash === snapshot.contentHash;
  if (!snapshotMatches) {
    addIssue({
      severity: "error",
      code: "SNAPSHOT_MISMATCH",
      message: "Procedure model is not bound to this snapshot id and hash.",
    });
  }

  const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
  const blocks = new Map(
    snapshot.pages.flatMap((page) => page.blocks.map((block) => [block.id, { block, page }] as const)),
  );
  const websiteActions = new Map(
    snapshot.pages.flatMap((page) => page.actions.map((action) => [action.id, { action, page }] as const)),
  );

  const verifiedWebsiteActionIds = new Set<string>();
  for (const { action, page } of websiteActions.values()) {
    if (!action.visible || !action.enabled) continue;
    if (!pageIsAllowed(snapshot.rootUrl, page)) continue;
    if (action.targetUrl !== undefined && !sameOrigin(snapshot.rootUrl, action.targetUrl)) continue;
    verifiedWebsiteActionIds.add(action.id);
  }

  const executableProcedureActionIds = new Set<string>();
  for (const procedureAction of model.actions) {
    if (procedureAction.kind === "user_task") {
      executableProcedureActionIds.add(procedureAction.id);
      continue;
    }

    const websiteActionId = procedureAction.websiteActionId;
    const binding = websiteActionId === undefined ? undefined : websiteActions.get(websiteActionId);
    if (binding === undefined) {
      addIssue({
        severity: "error",
        code: "ACTION_MISSING",
        message: `Procedure action ${procedureAction.id} references an unobserved website action.`,
        procedureActionId: procedureAction.id,
      });
      continue;
    }
    if (!pageIsAllowed(snapshot.rootUrl, binding.page)) {
      addIssue({
        severity: "error",
        code: "CROSS_ORIGIN_BLOCKED",
        message: `Website action ${binding.action.id} was observed outside the allowed origin.`,
        procedureActionId: procedureAction.id,
      });
      continue;
    }
    if (!binding.action.visible || !binding.action.enabled) {
      addIssue({
        severity: "error",
        code: "ACTION_UNAVAILABLE",
        message: `Website action ${binding.action.id} was not visible and enabled at capture time.`,
        procedureActionId: procedureAction.id,
      });
      continue;
    }
    if (binding.action.targetUrl !== undefined && !sameOrigin(snapshot.rootUrl, binding.action.targetUrl)) {
      addIssue({
        severity: "error",
        code: "CROSS_ORIGIN_BLOCKED",
        message: `Website action ${binding.action.id} leaves the allowed origin.`,
        procedureActionId: procedureAction.id,
      });
      continue;
    }
    executableProcedureActionIds.add(procedureAction.id);
  }

  const cycleActionIds = findDependencyCycles(model);
  for (const actionId of cycleActionIds) {
    addIssue({
      severity: "error",
      code: "DEPENDENCY_CYCLE",
      message: `Dependency cycle includes ${actionId}.`,
      procedureActionId: actionId,
    });
    executableProcedureActionIds.delete(actionId);
  }

  const validRuleIds = new Set<string>();
  const rejectedRuleIds = new Set<string>();
  const factDefinitions = new Map(model.factDefinitions.map((definition) => [definition.key, definition]));
  for (const rule of model.rules) {
    // This audit is a closed-world permission gate. It must never suppress a
    // prohibition or requirement, even if a caller supplies an unexpected id.
    const auditReviews = rule.effect === "permit"
      ? additionalSemanticReviews.filter((review) => review.ruleId === rule.id)
      : [];
    let citationIsValid = false;
    const factReferenceIssues = [
      ...conditionFactReferenceIssues(rule.appliesWhen, factDefinitions),
      ...(rule.effect === "require_condition"
        ? conditionFactReferenceIssues(rule.requirement, factDefinitions)
        : []),
    ];
    for (const message of uniqueSorted(factReferenceIssues)) {
      addIssue({ severity: "error", code: "REFERENCE_INVALID", message, ruleId: rule.id });
    }

    for (const citation of rule.citations) {
      const page = pages.get(citation.pageId);
      if (page === undefined) {
        addIssue({ severity: "error", code: "PAGE_MISSING", message: `Citation page ${citation.pageId} is absent.`, ruleId: rule.id });
        continue;
      }
      if (!pageIsAllowed(snapshot.rootUrl, page)) {
        addIssue({ severity: "error", code: "CROSS_ORIGIN_BLOCKED", message: `Citation page ${page.id} is outside the allowed origin.`, ruleId: rule.id });
        continue;
      }
      if (page.url !== citation.pageUrl) {
        addIssue({ severity: "error", code: "REFERENCE_INVALID", message: `Citation URL does not match page ${page.id}.`, ruleId: rule.id });
        continue;
      }
      const blockBinding = blocks.get(citation.blockId);
      if (blockBinding === undefined || blockBinding.page.id !== page.id) {
        addIssue({ severity: "error", code: "BLOCK_MISSING", message: `Citation block ${citation.blockId} is absent from page ${page.id}.`, ruleId: rule.id });
        continue;
      }
      if (blockBinding.block.textHash !== hashEvidenceBlockText(blockBinding.block.text)) {
        addIssue({ severity: "error", code: "REFERENCE_INVALID", message: `Source identity for block ${citation.blockId} does not match its text.`, ruleId: rule.id });
        continue;
      }
      const excerpt = normalizeEvidenceText(citation.excerpt);
      if (excerpt.length === 0 || !normalizeEvidenceText(blockBinding.block.text).includes(excerpt)) {
        addIssue({ severity: "error", code: "EXCERPT_MISMATCH", message: `Citation excerpt does not exactly match block ${citation.blockId}.`, ruleId: rule.id });
        continue;
      }
      const citationActionsValid = citation.actionIds.every((actionId) => {
        const actionBinding = websiteActions.get(actionId);
        return actionBinding !== undefined && actionBinding.page.id === page.id;
      });
      if (!citationActionsValid) {
        addIssue({ severity: "error", code: "ACTION_MISSING", message: `Citation ${citation.blockId} references an unobserved action.`, ruleId: rule.id });
        continue;
      }
      citationIsValid = true;
    }

    if (rule.needsReview) {
      addIssue({
        severity: "error",
        code: "SEMANTIC_REVIEW_REQUIRED",
        message: rule.reviewReason ?? `Rule ${rule.id} is semantically insufficient.`,
        ruleId: rule.id,
      });
    }
    for (const review of auditReviews) {
      addIssue({
        severity: "error",
        code: "SEMANTIC_REVIEW_REQUIRED",
        message: review.message,
        ruleId: rule.id,
      });
    }

    const actionBindingIsValid = executableProcedureActionIds.has(rule.actionId);
    if (
      snapshotMatches &&
      citationIsValid &&
      actionBindingIsValid &&
      factReferenceIssues.length === 0 &&
      !rule.needsReview &&
      auditReviews.length === 0
    ) {
      validRuleIds.add(rule.id);
    } else {
      rejectedRuleIds.add(rule.id);
    }
  }

  const status = !snapshotMatches || cycleActionIds.length > 0 ? "invalid" : issues.length > 0 ? "degraded" : "valid";
  const evidence = EvidenceResultSchema.parse({
    schemaVersion: 1,
    id: context.evidenceResultId,
    snapshotId: snapshot.id,
    snapshotHash: snapshot.contentHash,
    procedureModelId: model.id,
    checkedAt: context.checkedAt,
    status,
    validRuleIds: [...validRuleIds].sort(),
    rejectedRuleIds: [...rejectedRuleIds].sort(),
    verifiedWebsiteActionIds: [...verifiedWebsiteActionIds].sort(),
    executableProcedureActionIds: [...executableProcedureActionIds].sort(),
    issues,
  });

  return { ok: true, snapshot, model, evidence };
}
