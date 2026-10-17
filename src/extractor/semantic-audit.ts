import {
  normalizeEvidenceText,
  type PolicyCondition,
  type PolicyRule,
  type ProcedureModel,
  type SiteSnapshot,
} from "../contracts/index.js";

export type SemanticAuditFindingCode =
  | "MISSING_QUALIFIER"
  | "NEGATED_QUALIFIER_MISMATCH"
  | "UNMODELED_EXCEPTION"
  | "AMBIGUOUS_PERMISSION_SCOPE"
  | "QUALIFIER_UNCERTAIN";

export type SemanticAuditFinding = Readonly<{
  ruleId: string;
  code: SemanticAuditFindingCode;
  message: string;
  pageId: string;
  blockId: string;
  excerpt: string;
}>;

export type SemanticAuditResult = Readonly<{
  findings: readonly SemanticAuditFinding[];
  reviewRequiredRuleIds: readonly string[];
}>;

type PermitRule = Extract<PolicyRule, { effect: "permit" }>;
type FactDefinition = ProcedureModel["factDefinitions"][number];
type AtomicBinding = Readonly<{
  condition: Extract<PolicyCondition, { kind: "fact" }>;
  inverted: boolean;
}>;
type Qualifier = Readonly<{
  kind: "literal" | "temporal" | "ownership" | "conditional";
  text: string;
  tokens: readonly string[];
  marker?: string;
  expectedBoolean?: boolean;
}>;
type AnalyzedSentence = Readonly<{
  text: string;
  subjectHeads: readonly string[];
  qualifiers: readonly Qualifier[];
}>;

const STOP_WORDS = new Set([
  "a", "an", "and", "any", "as", "at", "be", "by", "each", "every", "for", "from",
  "guidance", "in", "is", "it", "of", "on", "or", "policy", "rule", "the", "their",
  "this", "to", "under", "with",
]);
const TEMPORAL = new Set(["after", "before", "once", "until", "when", "while", "within"]);
const CONDITIONAL = new Set(["if", "provided", "unless"]);
const AMBIGUOUS =
  /\b(?:generally|in some cases|may be able|normally|sometimes|subject to|typically|usually|where appropriate|where possible|depending on|at (?:our|the) discretion)\b/iu;
const PERMISSION = /\b(?:allowed|can|eligible|may|permitted)\b/iu;
const NEGATIVE_PERMISSION = /\b(?:(?:may|can)\s+not|cannot|can't|not\s+(?:allowed|eligible|permitted))\b/iu;
const RESTRICTION = /\b(?:cannot|can't|does not apply|different rules?|except|exception|may not|must not|not eligible|only|unless)\b/iu;
const SYNONYMS = new Map<string, string>([
  ["cancellation", "cancel"], ["customer", "user"], ["holder", "user"], ["myself", "user"],
  ["owner", "user"], ["self", "user"], ["start", "initiate"], ["you", "user"],
  ["your", "user"], ["yourself", "user"],
]);

function stem(token: string): string {
  let value = token.toLocaleLowerCase("en-US");
  if (value.endsWith("ies") && value.length > 4) value = `${value.slice(0, -3)}y`;
  else if (value.endsWith("ing") && value.length > 5) value = value.slice(0, -3);
  else if (value.endsWith("ied") && value.length > 4) value = `${value.slice(0, -3)}y`;
  else if (value.endsWith("ed") && value.length > 4) {
    value = value.endsWith("ated") || value.endsWith("ited") ? value.slice(0, -1) : value.slice(0, -2);
  } else if (value.endsWith("s") && !value.endsWith("ss") && value.length > 3) value = value.slice(0, -1);
  return SYNONYMS.get(value) ?? value;
}

function words(text: string): readonly string[] {
  const splitCamelCase = text.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
  return normalizeEvidenceText(splitCamelCase).toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)?.map(stem) ?? [];
}

function significant(tokens: readonly string[]): readonly string[] {
  return tokens.filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function sentences(text: string): readonly string[] {
  return normalizeEvidenceText(text).split(/[.!?;]+(?:\s+|$)/u)
    .map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function definitionTokens(definition: FactDefinition): readonly string[] {
  return unique(significant([
    ...words(definition.key), ...words(definition.label),
    ...(definition.allowedValues ?? []).flatMap((value) => words(String(value))),
  ]));
}

function atomTokens(binding: AtomicBinding, definitions: readonly FactDefinition[]): readonly string[] {
  const definition = definitions.find((item) => item.key === binding.condition.fact);
  return unique(significant([
    ...words(binding.condition.fact),
    ...(definition === undefined ? [] : significant([...words(definition.key), ...words(definition.label)])),
    ...words(String(binding.condition.value)),
  ]));
}

function atomicGuaranteesValue(binding: AtomicBinding, expected: boolean | string): boolean {
  const values = Array.isArray(binding.condition.value) ? binding.condition.value : [binding.condition.value];
  const contains = values.some((value) =>
    typeof expected === "string"
      ? words(String(value)).includes(expected)
      : typeof value === "boolean" && value === expected,
  );
  switch (binding.condition.op) {
    case "eq": return !binding.inverted && contains;
    case "neq": return binding.inverted && contains;
    case "in": return !binding.inverted && values.length === 1 && contains;
    case "not_in": return binding.inverted && values.length === 1 && contains;
    case "lt": case "lte": case "gt": case "gte": return false;
  }
}

function conditionGuarantees(
  condition: PolicyCondition,
  predicate: (binding: AtomicBinding) => boolean,
  inverted = false,
): boolean {
  switch (condition.kind) {
    case "always": return false;
    case "fact": return predicate({ condition, inverted });
    case "not": return conditionGuarantees(condition.condition, predicate, !inverted);
    case "all":
      return inverted
        ? condition.conditions.every((child) => conditionGuarantees(child, predicate, true))
        : condition.conditions.some((child) => conditionGuarantees(child, predicate, false));
    case "any":
      return inverted
        ? condition.conditions.some((child) => conditionGuarantees(child, predicate, true))
        : condition.conditions.every((child) => conditionGuarantees(child, predicate, false));
  }
}

function subjectQualifiers(prefix: string): Readonly<{ heads: readonly string[]; qualifiers: readonly Qualifier[] }> {
  let tokens = [...words(prefix.slice(prefix.lastIndexOf(",") + 1))];
  const determiner = tokens.reduce(
    (last, token, index) => (["a", "an", "any", "each", "every", "the"].includes(token) ? index : last), -1,
  );
  if (determiner >= 0) tokens = tokens.slice(determiner + 1);
  const boundary = tokens.findIndex((token) => ["not", "that", "which", "who"].includes(token));
  const subject = boundary >= 0 ? tokens.slice(0, boundary) : tokens;
  const head = subject.at(-1);
  if (head === undefined || subject.length < 2 || ["i", "we", "you"].includes(head)) {
    return { heads: head === undefined ? [] : [head], qualifiers: [] };
  }
  return {
    heads: [head],
    qualifiers: subject.slice(0, -1).filter((token) => !STOP_WORDS.has(token))
      .map((token) => ({ kind: "literal", text: token, tokens: [token] })),
  };
}

function analyzeSentence(text: string): AnalyzedSentence | undefined {
  if (!PERMISSION.test(text)) return undefined;
  const cue = /\b(?:allowed|can|eligible|may|permitted)\b/iu.exec(text);
  if (cue === null) return undefined;
  const tokens = words(text);
  const cueIndex = tokens.findIndex((token) => ["allow", "can", "eligible", "may", "permit"].includes(token));
  if (cueIndex < 0) return undefined;
  const subject = subjectQualifiers(text.slice(0, cue.index));
  const qualifiers: Qualifier[] = [...subject.qualifiers];
  for (let index = cueIndex + 1; index < tokens.length; index += 1) {
    const marker = tokens[index];
    if (marker === undefined || (!TEMPORAL.has(marker) && !CONDITIONAL.has(marker))) continue;
    const clause = tokens.slice(index, Math.min(tokens.length, index + (TEMPORAL.has(marker) ? 7 : 9)));
    qualifiers.push({
      kind: TEMPORAL.has(marker) ? "temporal" : "conditional",
      text: clause.join(" "), tokens: clause, marker,
      ...(marker === "unless" ? { expectedBoolean: false } : {}),
    });
  }
  const actor = tokens.some((token) => ["you", "your", "user"].includes(token));
  const ownership = tokens.some((token) => ["initiate", "own", "submit"].includes(token));
  if (actor && ownership) {
    qualifiers.push({
      kind: "ownership", text: tokens.join(" "), tokens,
      expectedBoolean: !tokens.some((token) => ["didnt", "no", "not", "without"].includes(token)),
    });
  }
  const deduplicated = new Map(qualifiers.map((item) => [`${item.kind}:${item.text}`, item] as const));
  return { text, subjectHeads: subject.heads, qualifiers: [...deduplicated.values()] };
}

function qualifierResult(
  qualifier: Qualifier,
  condition: PolicyCondition,
  definitions: readonly FactDefinition[],
): Readonly<{ represented: boolean; polarityMismatch: boolean; known: boolean }> {
  const candidate = new Set(significant(qualifier.tokens));
  const definitionKnown = definitions.some((definition) =>
    definitionTokens(definition).some((token) => candidate.has(token)),
  );
  const meaningMatches = (binding: AtomicBinding): boolean => {
    const descriptor = atomTokens(binding, definitions);
    const overlap = descriptor.filter((token) => candidate.has(token)).length;
    if (qualifier.kind === "literal") return descriptor.includes(qualifier.tokens[0] ?? "");
    if (qualifier.kind === "temporal") return qualifier.marker !== undefined && descriptor.includes(qualifier.marker);
    if (qualifier.kind === "ownership") return overlap >= 2;
    return overlap >= 2;
  };
  const represents = (binding: AtomicBinding): boolean => {
    if (!meaningMatches(binding)) return false;
    if (qualifier.kind === "literal") {
      const literal = qualifier.tokens[0];
      if (literal !== undefined && words(String(binding.condition.value)).includes(literal)) {
        return atomicGuaranteesValue(binding, literal);
      }
    }
    if (qualifier.expectedBoolean !== undefined) {
      return atomicGuaranteesValue(binding, qualifier.expectedBoolean);
    }
    if (typeof binding.condition.value === "boolean") return atomicGuaranteesValue(binding, true);
    return true;
  };
  const represented = conditionGuarantees(condition, represents);
  const opposite = qualifier.expectedBoolean === undefined ? undefined : !qualifier.expectedBoolean;
  const polarityMismatch = opposite !== undefined && !represented && conditionGuarantees(
    condition,
    (binding) => meaningMatches(binding) && atomicGuaranteesValue(binding, opposite),
  );
  return { represented, polarityMismatch, known: definitionKnown };
}

function makeFinding(
  rule: PermitRule,
  citation: PolicyRule["citations"][number],
  code: SemanticAuditFindingCode,
  message: string,
): SemanticAuditFinding {
  return {
    ruleId: rule.id, code, message: `Independent semantic audit: ${message}`,
    pageId: citation.pageId, blockId: citation.blockId, excerpt: citation.excerpt,
  };
}

function sourceSentences(
  citation: PolicyRule["citations"][number],
  blocks: ReadonlyMap<string, SiteSnapshot["pages"][number]["blocks"][number]>,
): readonly string[] {
  const block = blocks.get(citation.blockId);
  if (block === undefined) return sentences(citation.excerpt);
  const excerpt = normalizeEvidenceText(citation.excerpt);
  const related = sentences(block.text).filter((sentence) => {
    const normalized = normalizeEvidenceText(sentence);
    return normalized.includes(excerpt) || excerpt.includes(normalized);
  });
  return related.length > 0 ? related : sentences(citation.excerpt);
}

function auditExternalExceptions(
  snapshot: SiteSnapshot,
  model: ProcedureModel,
  rule: PermitRule,
  analyzed: readonly AnalyzedSentence[],
): readonly SemanticAuditFinding[] {
  const action = model.actions.find((item) => item.id === rule.actionId);
  const citation = rule.citations[0];
  if (action === undefined || citation === undefined) return [];
  const actionTokens = new Set(significant(words(`${action.label} ${action.description}`)));
  const subjects = new Set(analyzed.flatMap((sentence) => sentence.subjectHeads));
  const citedBlocks = new Set(rule.citations.map((item) => item.blockId));
  if (subjects.size === 0) return [];

  return snapshot.pages.flatMap((page) => page.blocks.flatMap((block) => {
    if (citedBlocks.has(block.id) || !RESTRICTION.test(block.text)) return [];
    if (/^\s*if\b/iu.test(block.text) && !/\b(?:does not apply|except|exception|unless)\b/iu.test(block.text)) return [];
    const blockTokens = new Set(words(block.text));
    const relatedSubject = [...subjects].some((token) => blockTokens.has(token));
    const relatedAction = [...actionTokens].some((token) => blockTokens.has(token));
    const scopeStatement = /\b(?:does not apply|different rules?|except|exception|unless)\b/iu.test(block.text);
    if (!relatedSubject || (!relatedAction && !scopeStatement)) return [];
    const modeled = model.rules.some((candidate) =>
      candidate.actionId === rule.actionId && candidate.effect !== "permit" &&
      candidate.citations.some((item) => item.blockId === block.id),
    );
    return modeled ? [] : [makeFinding(
      rule, citation, "UNMODELED_EXCEPTION",
      `a related restrictive or exception block (${block.id}) is not represented by a non-permission rule for the same action.`,
    )];
  }));
}

/** Narrow deterministic screening only; a clean result is not proof of semantic completeness. */
export function auditSemanticQualifiers(snapshot: SiteSnapshot, model: ProcedureModel): SemanticAuditResult {
  const blocks = new Map(snapshot.pages.flatMap((page) =>
    page.blocks.map((block) => [block.id, block] as const),
  ));
  const findings: SemanticAuditFinding[] = [];
  for (const candidateRule of model.rules) {
    if (candidateRule.effect !== "permit") continue;
    const rule = candidateRule;
    const analyzed: AnalyzedSentence[] = [];
    for (const citation of rule.citations) {
      for (const text of sourceSentences(citation, blocks)) {
        const sentence = analyzeSentence(text);
        if (sentence === undefined) continue;
        analyzed.push(sentence);
        if (NEGATIVE_PERMISSION.test(sentence.text)) findings.push(makeFinding(
          rule, citation, "NEGATED_QUALIFIER_MISMATCH",
          "the cited sentence is phrased as a negative permission or ineligibility statement.",
        ));
        if (AMBIGUOUS.test(sentence.text)) findings.push(makeFinding(
          rule, citation, "AMBIGUOUS_PERMISSION_SCOPE",
          "the cited permission uses unresolved hedging or discretionary scope.",
        ));
        for (const qualifier of sentence.qualifiers) {
          const result = qualifierResult(qualifier, rule.appliesWhen, model.factDefinitions);
          if (result.represented) continue;
          if (result.polarityMismatch) findings.push(makeFinding(
            rule, citation, "NEGATED_QUALIFIER_MISMATCH",
            `the structured condition appears to reverse the source qualifier "${qualifier.text}".`,
          ));
          else findings.push(makeFinding(
            rule, citation,
            result.known || qualifier.kind !== "conditional" ? "MISSING_QUALIFIER" : "QUALIFIER_UNCERTAIN",
            result.known || qualifier.kind !== "conditional"
              ? `the permission may omit the operative source qualifier "${qualifier.text}".`
              : `the conditional scope "${qualifier.text}" could not be matched to a mandatory structured condition.`,
          ));
        }
      }
    }
    findings.push(...auditExternalExceptions(snapshot, model, rule, analyzed));
  }
  const deduplicated = new Map(findings.map((item) =>
    [`${item.ruleId}:${item.code}:${item.blockId}:${item.message}`, item] as const,
  ));
  const stable = [...deduplicated.values()].sort((left, right) =>
    `${left.ruleId}:${left.code}:${left.blockId}:${left.message}`.localeCompare(
      `${right.ruleId}:${right.code}:${right.blockId}:${right.message}`,
    ),
  );
  return {
    findings: stable,
    reviewRequiredRuleIds: [...unique(stable.map((item) => item.ruleId))].sort(),
  };
}
