import type {
  JsonScalar,
  ProcedureModel,
  SafeActionPlan,
  UserState,
} from "../contracts/index.js";
import type { AdaptiveQuestion } from "../decision/index.js";
import type { DemoAnalysis } from "./types.js";
import { readableReason, type Tone } from "./viewModel.js";

export type PersonalizationView = "guided" | "all_facts";

export type GuidedQuestion = Readonly<{
  definition: ProcedureModel["factDefinitions"][number];
  source: "adaptive" | "canonical_fallback" | "editing";
  adaptiveQuestion?: AdaptiveQuestion;
}>;

export type GuidedDecisionPresentation = Readonly<{
  label:
    | "More information needed"
    | "Ready to proceed with verified guidance"
    | "Prohibited by verified policy"
    | "Requires review"
    | "No verified route available";
  tone: Tone;
  summary: string;
}>;

export function factOptions(
  definition: ProcedureModel["factDefinitions"][number],
): readonly JsonScalar[] | undefined {
  if (definition.allowedValues !== undefined) return definition.allowedValues;
  return definition.type === "boolean" ? ([true, false] as const) : undefined;
}

export function selectGuidedQuestion(
  analysis: DemoAnalysis,
  editingFactKey?: string,
  userState: UserState = analysis.userState,
): GuidedQuestion | undefined {
  if (editingFactKey !== undefined) {
    const definition = analysis.model.factDefinitions.find(
      (candidate) => candidate.key === editingFactKey,
    );
    if (definition !== undefined) return { definition, source: "editing" };
  }

  const unresolved = new Set(analysis.plan.missingFacts);
  for (const question of analysis.decisionIntelligence.questions) {
    if (!unresolved.has(question.factKey)) continue;
    if (userState.facts[question.factKey] !== undefined) continue;
    const definition = analysis.model.factDefinitions.find(
      (candidate) => candidate.key === question.factKey,
    );
    if (definition !== undefined) {
      return {
        definition,
        source: "adaptive",
        adaptiveQuestion: question,
      };
    }
  }

  const definition = analysis.model.factDefinitions.find(
    (candidate) =>
      unresolved.has(candidate.key) &&
      userState.facts[candidate.key] === undefined,
  );
  return definition === undefined
    ? undefined
    : { definition, source: "canonical_fallback" };
}

function blockedByVerifiedPolicy(plan: SafeActionPlan): boolean {
  return plan.reasonCodes.some(
    (code) => code === "PROHIBITED" || code === "POLICY_CONFLICT",
  );
}

export function guidedDecisionPresentation(
  analysis: DemoAnalysis,
): GuidedDecisionPresentation {
  switch (analysis.plan.status) {
    case "ready":
      return {
        label: "Ready to proceed with verified guidance",
        tone: "positive",
        summary: "Verified next steps are available below. No action is executed automatically.",
      };
    case "needs_information":
      return {
        label: "More information needed",
        tone: "warning",
        summary: "A mandatory policy fact is still unknown.",
      };
    case "review_required":
      return {
        label: "Requires review",
        tone: "warning",
        summary: "Answering facts cannot clear an evidence or semantic-review gate.",
      };
    case "stale":
      return {
        label: "No verified route available",
        tone: "neutral",
        summary: "The source or user-state binding is stale, so prior guidance is withheld.",
      };
    case "blocked":
      return blockedByVerifiedPolicy(analysis.plan)
        ? {
            label: "Prohibited by verified policy",
            tone: "danger",
            summary: analysis.plan.reasonCodes.map(readableReason).join(" "),
          }
        : {
            label: "No verified route available",
            tone: "danger",
            summary:
              analysis.plan.reasonCodes.length === 0
                ? "The deterministic planner found no supported route."
                : analysis.plan.reasonCodes.map(readableReason).join(" "),
          };
  }
}

export function questionCitations(analysis: DemoAnalysis, factKey: string) {
  return analysis.decisionIntelligence.trace.rules
    .filter((rule) => rule.facts.some((fact) => fact.key === factKey))
    .flatMap((rule) =>
      rule.citations.map((citation) => ({
        ruleId: rule.ruleId,
        pageUrl: citation.pageUrl,
        blockId: citation.blockId,
        excerpt: citation.excerpt,
      })),
    );
}
