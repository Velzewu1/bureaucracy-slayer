import type {
  EvidenceResult,
  ProcedureModel,
  SafeActionPlan,
  SiteSnapshot,
  WebsiteAction,
} from "../../src/contracts/index.js";
import {
  sealEnvelope,
  type GuidanceCitation,
  type GuidanceEnvelope,
  type GuidanceStep,
  type GuidanceTarget,
} from "../src/envelope.js";

/**
 * Build-time projection of an already verified analysis into a GuidanceEnvelope.
 * It copies facts from the deterministic pipeline's outputs; it never evaluates
 * policy, and it fails closed (throws) when a step cannot be grounded.
 */

export type EnvelopeInput = Readonly<{
  snapshot: SiteSnapshot;
  model: ProcedureModel;
  evidence: EvidenceResult;
  plan: SafeActionPlan;
  goal: string;
  sessionId: string;
  sequence: number;
  validForMs: number;
  sourceLabel: string;
}>;

function targetFor(action: WebsiteAction, sourcePageUrl: string): GuidanceTarget {
  const role = action.locators.find((locator) => locator.strategy === "role");
  return {
    websiteActionId: action.id,
    actionKind: action.kind,
    ...(action.method === undefined ? {} : { method: action.method }),
    label: action.label,
    sourcePageUrl,
    ...(action.targetUrl === undefined ? {} : { destinationUrl: action.targetUrl }),
    ...(role?.strategy === "role" ? { role: role.role } : {}),
    accessibleName: role?.strategy === "role" ? role.name : action.label,
  };
}

export async function buildGuidanceEnvelope(input: EnvelopeInput): Promise<GuidanceEnvelope> {
  const { snapshot, model, evidence, plan } = input;
  if (plan.snapshotId !== snapshot.id || plan.snapshotHash !== snapshot.contentHash) {
    throw new Error("Plan is not bound to this snapshot.");
  }
  if (plan.evidenceResultId !== evidence.id || plan.procedureModelId !== model.id) {
    throw new Error("Plan is not bound to this evidence/model.");
  }

  const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
  const actions = new Map(
    snapshot.pages.flatMap((page) => page.actions.map((action) => [action.id, { action, page }] as const)),
  );
  const verified = new Set(evidence.verifiedWebsiteActionIds);
  const rules = new Map(model.rules.map((rule) => [rule.id, rule]));
  const procedureActions = new Map(model.actions.map((action) => [action.id, action]));

  const citations: GuidanceCitation[] = [];
  const citationIdByKey = new Map<string, string>();
  const citationIdsFor = (ruleIds: readonly string[]): string[] => {
    const ids: string[] = [];
    for (const ruleId of ruleIds) {
      const rule = rules.get(ruleId);
      if (rule === undefined) throw new Error("Step cites an unknown rule.");
      for (const citation of rule.citations) {
        const page = pages.get(citation.pageId);
        if (page === undefined) throw new Error("Citation references an unobserved page.");
        const key = `${citation.pageId}|${citation.blockId}|${citation.excerpt}`;
        let id = citationIdByKey.get(key);
        if (id === undefined) {
          id = `cite_${citations.length + 1}`;
          citationIdByKey.set(key, id);
          citations.push({ id, pageTitle: page.title, pageUrl: page.url, excerpt: citation.excerpt });
        }
        ids.push(id);
      }
    }
    return [...new Set(ids)];
  };

  const steps: GuidanceStep[] = plan.status === "ready"
    ? plan.steps.map((step) => {
        const procedureAction = procedureActions.get(step.procedureActionId);
        if (procedureAction === undefined) throw new Error("Step references an unknown procedure action.");
        let target: GuidanceTarget | null = null;
        if (step.websiteActionId !== undefined) {
          const bound = actions.get(step.websiteActionId);
          if (bound === undefined || !verified.has(step.websiteActionId)) {
            throw new Error("Step target is not a verified observed website action.");
          }
          target = targetFor(bound.action, bound.page.url);
        }
        return {
          index: step.index,
          title: procedureAction.label,
          instruction: step.instruction,
          citationIds: citationIdsFor(step.citationRuleIds),
          target,
        };
      })
    : [];

  const factLabels = new Map(model.factDefinitions.map((definition) => [definition.key, definition.label]));
  return sealEnvelope({
    schemaVersion: 1,
    source: "fixture_demo",
    sourceLabel: input.sourceLabel,
    sessionId: input.sessionId,
    sequence: input.sequence,
    validForMs: input.validForMs,
    trustedOrigin: new URL(snapshot.rootUrl).origin,
    goal: input.goal,
    planStatus: plan.status,
    notices: plan.status === "ready" ? [] : [...plan.reasonCodes],
    missingFactLabels: plan.missingFacts.map((key) => factLabels.get(key) ?? "Additional detail"),
    steps,
    citations: steps.length === 0 ? [] : citations,
    observedPages: snapshot.pages.map((page) => page.url),
    binding: {
      planId: plan.id,
      snapshotId: plan.snapshotId,
      snapshotHash: plan.snapshotHash,
      userStateRevision: plan.userStateRevision,
      userStateHash: plan.userStateHash,
    },
  });
}
