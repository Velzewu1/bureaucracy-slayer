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
type FindingProvenance = Readonly<{
  pageId: string;
  blockId: string;
  excerpt: string;
}>;
type RestrictionDimension = Readonly<{
  factKey: string;
  valueTokens: readonly string[];
}>;

const STOP_WORDS = new Set([
  "a", "an", "and", "any", "as", "at", "be", "by", "each", "every", "for", "from",
  "guidance", "in", "is", "it", "of", "on", "or", "permit", "policy", "rule", "the", "their",
  "this", "to", "under", "with", "only",
]);
const WEAK_ACTION_WORDS = new Set([
  "action", "ask", "check", "detail", "form", "go", "guide", "guidance", "information",
  "online", "open", "page", "provide", "request", "review", "submit", "support", "task",
  "transfer", "user", "whether",
]);
const RESTRICTION_WORDS = new Set([
  "allow", "can", "cannot", "eligible", "must", "need", "not", "only", "permit", "require",
  "unless", "without",
]);
const TEMPORAL = new Set(["after", "before", "once", "until", "when", "while", "within"]);
const CONDITIONAL = new Set(["if", "provided", "unless"]);
const AMBIGUOUS =
  /\b(?:generally|in some cases|may be able|may be eligible|normally|sometimes|subject to|typically|usually|where appropriate|where possible|depending on|at (?:our|the) discretion)\b/iu;
const PERMISSION = /\b(?:allowed|can|eligible|may|permitted)\b/iu;
const NEGATIVE_PERMISSION = /\b(?:(?:may|can)\s+not|cannot|can't|not\s+(?:allowed|eligible|permitted))\b/iu;
const OPERATIVE_RESTRICTION =
  /\b(?:cannot|can't|can\s+(?:no\s+longer|only)|may\s+not|must\s+not|not\s+(?:allowed|eligible|permitted)|does\s+not\s+apply|except(?:ion)?\s+(?:for|to)|only\s+if|unless|without|requires?|required|must|needs?\s+to)\b/iu;
const OUTCOME_WARNING =
  /\b(?:not guaranteed|no guarantee|outcome depends|may fail|does not ensure|doesn't ensure|not necessarily|doesn't by itself|does not by itself)\b/iu;
const NONEXCLUSIVE_ALTERNATIVE =
  /\b(?:alternatively|another option|available options?|contact support|if you prefer|instead|you can also)\b/iu;
const SYNONYMS = new Map<string, string>([
  ["application", "apply"], ["cancellation", "cancel"], ["closure", "close"],
  ["clos", "close"], ["customer", "user"], ["holder", "user"], ["myself", "user"],
  ["recovery", "recover"],
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
    if (qualifier.kind === "temporal") {
      return qualifier.marker !== undefined && (descriptor.includes(qualifier.marker) || overlap >= 1);
    }
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
    if (typeof binding.condition.value === "boolean") {
      const descriptor = atomTokens(binding, definitions);
      const beforeNamedState = qualifier.kind === "temporal" && qualifier.marker === "before" &&
        !descriptor.includes("before") && descriptor.some((token) =>
          ["begin", "initiate", "process", "start"].includes(token),
        );
      return atomicGuaranteesValue(binding, beforeNamedState ? false : true);
    }
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
  provenance: FindingProvenance,
  code: SemanticAuditFindingCode,
  message: string,
): SemanticAuditFinding {
  return {
    ruleId: rule.id, code, message: `Independent semantic audit: ${message}`,
    pageId: provenance.pageId, blockId: provenance.blockId, excerpt: provenance.excerpt,
  };
}

function actionIntentTokens(action: ProcedureModel["actions"][number]): readonly string[] {
  return unique(significant(words(action.label))).filter((token) => !WEAK_ACTION_WORDS.has(token));
}

function relatesToAction(
  text: string,
  intentTokens: ReadonlySet<string>,
  subjectHeads: ReadonlySet<string>,
): boolean {
  const sourceTokens = new Set(words(text));
  return [...intentTokens].some((token) => sourceTokens.has(token)) &&
    [...subjectHeads].some((token) => sourceTokens.has(token));
}

function permissionExpressesAction(text: string, intentTokens: ReadonlySet<string>): boolean {
  if (NEGATIVE_PERMISSION.test(text)) return false;
  const cue = /\b(?:allowed|can|eligible|may|permitted)\b/iu.exec(text);
  if (cue === null) return false;
  const predicateTokens = new Set(words(text.slice(cue.index + cue[0].length)));
  return [...intentTokens].some((token) => predicateTokens.has(token));
}

function qualifierFactDimension(
  qualifier: Qualifier,
  sentence: AnalyzedSentence,
  definitions: readonly FactDefinition[],
): string | undefined {
  const qualifierTokens = new Set(significant(qualifier.tokens));
  const direct = definitions.find((definition) =>
    definitionTokens(definition).some((token) => qualifierTokens.has(token)),
  );
  if (direct !== undefined) return direct.key;

  if (qualifier.kind !== "literal") return undefined;
  return definitions.find((definition) => {
    const tokens = definitionTokens(definition);
    return tokens.some((token) => sentence.subjectHeads.includes(token)) &&
      tokens.some((token) => ["category", "class", "kind", "method", "type"].includes(token));
  })?.key;
}

function conditionSemanticTokens(
  condition: PolicyCondition,
  definitions: readonly FactDefinition[],
): readonly string[] {
  switch (condition.kind) {
    case "always": return [];
    case "fact": return atomTokens({ condition, inverted: false }, definitions);
    case "not": return conditionSemanticTokens(condition.condition, definitions);
    case "all":
    case "any": return unique(condition.conditions.flatMap((child) =>
      conditionSemanticTokens(child, definitions),
    ));
  }
}

function conditionFactKeys(condition: PolicyCondition): readonly string[] {
  switch (condition.kind) {
    case "always": return [];
    case "fact": return [condition.fact];
    case "not": return conditionFactKeys(condition.condition);
    case "all":
    case "any": return unique(condition.conditions.flatMap(conditionFactKeys));
  }
}

function ruleFactKeys(rule: Exclude<PolicyRule, PermitRule>): readonly string[] {
  return unique([
    ...conditionFactKeys(rule.appliesWhen),
    ...(rule.effect === "require_condition" ? conditionFactKeys(rule.requirement) : []),
  ]);
}

function ruleSemanticTokens(
  rule: Exclude<PolicyRule, PermitRule>,
  model: ProcedureModel,
): readonly string[] {
  const tokens = [...conditionSemanticTokens(rule.appliesWhen, model.factDefinitions)];
  if (rule.effect === "require_condition") {
    tokens.push(...conditionSemanticTokens(rule.requirement, model.factDefinitions));
  }
  if (rule.effect === "require_action") {
    const requiredAction = model.actions.find((action) => action.id === rule.requiredActionId);
    if (requiredAction !== undefined) {
      tokens.push(...significant(words(`${requiredAction.label} ${requiredAction.description}`)));
    }
  }
  return unique(tokens).filter((token) =>
    !WEAK_ACTION_WORDS.has(token) && !RESTRICTION_WORDS.has(token) && token !== "true" && token !== "false",
  );
}

function restrictionScopeTokens(
  text: string,
  intentTokens: ReadonlySet<string>,
  subjectHeads: ReadonlySet<string>,
): readonly string[] {
  return unique(significant(words(text))).filter((token) =>
    !intentTokens.has(token) && !subjectHeads.has(token) &&
    !WEAK_ACTION_WORDS.has(token) && !RESTRICTION_WORDS.has(token) &&
    !["direct", "longer", "no", "online"].includes(token),
  );
}

function restrictionIsRepresented(
  text: string,
  rule: PermitRule,
  model: ProcedureModel,
  intentTokens: ReadonlySet<string>,
  subjectHeads: ReadonlySet<string>,
): boolean {
  const scopeTokens = new Set(restrictionScopeTokens(text, intentTokens, subjectHeads));
  const dimensions = restrictionDimensions(text, model.factDefinitions);
  return model.rules.some((candidate) => {
    if (candidate.actionId !== rule.actionId || candidate.effect === "permit") return false;
    if (candidate.effect === "prohibit" && candidate.appliesWhen.kind === "always") return true;
    if (dimensions.length > 0) {
      const factKeys = ruleFactKeys(candidate);
      const semanticTokens = new Set(ruleSemanticTokens(candidate, model));
      return dimensions.every((dimension) =>
        factKeys.includes(dimension.factKey) &&
        (dimension.valueTokens.length === 0 ||
          dimension.valueTokens.some((token) => semanticTokens.has(token))),
      );
    }
    return ruleSemanticTokens(candidate, model).some((token) => scopeTokens.has(token));
  });
}

function restrictionDimensions(
  text: string,
  definitions: readonly FactDefinition[],
): readonly RestrictionDimension[] {
  const sourceTokens = new Set(significant(words(text)));
  return definitions.flatMap((definition): readonly RestrictionDimension[] => {
    if (definition.allowedValues !== undefined) {
      const matchedValueTokens = unique(definition.allowedValues.flatMap((value) =>
        words(String(value)).filter((token) => sourceTokens.has(token)),
      ));
      return matchedValueTokens.length === 0 ? [] : [{
        factKey: definition.key,
        valueTokens: matchedValueTokens,
      }];
    }
    const descriptor = definitionTokens(definition).filter((token) =>
      !WEAK_ACTION_WORDS.has(token) && !["true", "false"].includes(token),
    );
    return descriptor.filter((token) => sourceTokens.has(token)).length >= 2
      ? [{ factKey: definition.key, valueTokens: [] }]
      : [];
  });
}

function definitionForKey(
  definitions: readonly FactDefinition[],
  factKey: string,
): FactDefinition | undefined {
  return definitions.find((definition) => definition.key === factKey);
}

function binaryComplementIsRepresented(
  qualifierTokens: ReadonlySet<string>,
  definition: FactDefinition,
  candidateTokens: ReadonlySet<string>,
): boolean {
  if (definition.allowedValues?.length !== 2) return false;
  const values = definition.allowedValues.map((value) => words(String(value)));
  const qualifierIndex = values.findIndex((valueTokens) =>
    valueTokens.some((token) => qualifierTokens.has(token)),
  );
  if (qualifierIndex < 0) return false;
  const complement = values[qualifierIndex === 0 ? 1 : 0];
  return complement?.some((token) => candidateTokens.has(token)) === true;
}

function qualifierIsRepresentedByNonPermit(
  qualifier: Qualifier,
  dimension: string | undefined,
  rule: PermitRule,
  model: ProcedureModel,
): boolean {
  const qualifierTokens = new Set(significant(qualifier.tokens));
  return model.rules.some((candidate) => {
    if (candidate.actionId !== rule.actionId || candidate.effect === "permit") return false;
    const semanticTokens = new Set(ruleSemanticTokens(candidate, model));
    if ([...qualifierTokens].some((token) => semanticTokens.has(token))) return true;
    if (dimension === undefined || candidate.effect !== "prohibit" ||
        !ruleFactKeys(candidate).includes(dimension)) return false;
    const definition = definitionForKey(model.factDefinitions, dimension);
    return definition !== undefined && binaryComplementIsRepresented(
      qualifierTokens,
      definition,
      semanticTokens,
    );
  });
}

function isOperativeRestriction(text: string): boolean {
  if (OUTCOME_WARNING.test(text)) return false;
  if (!OPERATIVE_RESTRICTION.test(text)) return false;
  if (/^\s*if\b/iu.test(text) && NONEXCLUSIVE_ALTERNATIVE.test(text) &&
      !/\b(?:must|required|only|unless|without)\b/iu.test(text)) return false;
  if (!NONEXCLUSIVE_ALTERNATIVE.test(text)) return true;
  return /\b(?:cannot|can't|must|required|only|unless|without)\b/iu.test(text);
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
  if (action === undefined) return [];
  const subjects = new Set(analyzed.flatMap((sentence) => sentence.subjectHeads));
  const rawIntent = actionIntentTokens(action);
  const intent = new Set(rawIntent.filter((token) => !subjects.has(token)));
  if (intent.size === 0) rawIntent.forEach((token) => intent.add(token));
  const citedBlocks = new Set(rule.citations.map((item) => item.blockId));
  if (subjects.size === 0 || intent.size === 0) return [];

  const concerns = new Map<string, SemanticAuditFinding>();
  const missingDimensions = new Set<string>();
  const relatedStatements: Array<Readonly<{
    text: string;
    blockId: string;
    provenance: FindingProvenance;
  }>> = [];
  for (const page of snapshot.pages) {
    for (const block of page.blocks) {
      if (citedBlocks.has(block.id)) continue;
      const provenance = { pageId: page.id, blockId: block.id, excerpt: block.text };
      for (const text of sentences(block.text)) {
        if (relatesToAction(text, intent, subjects)) {
          relatedStatements.push({ text, blockId: block.id, provenance });
        }
      }
    }
  }

  for (const statement of relatedStatements) {
    const permission = analyzeSentence(statement.text);
    if (permission === undefined || !permissionExpressesAction(statement.text, intent)) continue;
    for (const qualifier of permission.qualifiers) {
      if (qualifier.tokens.some((token) => intent.has(token))) continue;
      const result = qualifierResult(qualifier, rule.appliesWhen, model.factDefinitions);
      if (result.represented) continue;
      const dimension = qualifierFactDimension(qualifier, permission, model.factDefinitions);
      if (qualifierIsRepresentedByNonPermit(qualifier, dimension, rule, model)) continue;
      const key = dimension === undefined
        ? `qualifier:${qualifier.kind}:${qualifier.text}`
        : `fact:${dimension}`;
      if (dimension !== undefined) missingDimensions.add(dimension);
      if (!concerns.has(key)) concerns.set(key, makeFinding(
        rule,
        statement.provenance,
        result.polarityMismatch ? "NEGATED_QUALIFIER_MISMATCH" :
          result.known || qualifier.kind !== "conditional" ? "MISSING_QUALIFIER" : "QUALIFIER_UNCERTAIN",
        result.polarityMismatch
          ? `the structured condition appears to reverse the source qualifier "${qualifier.text}".`
          : `the permission may omit the operative source qualifier "${qualifier.text}".`,
      ));
    }
  }

  for (const statement of relatedStatements) {
    if (!isOperativeRestriction(statement.text)) continue;
    if (restrictionIsRepresented(statement.text, rule, model, intent, subjects)) continue;
    const dimensions = restrictionDimensions(statement.text, model.factDefinitions);
    if (dimensions.some((dimension) => missingDimensions.has(dimension.factKey))) continue;
    const scope = restrictionScopeTokens(statement.text, intent, subjects);
    const key = dimensions.length === 0
      ? `restriction:${scope.slice().sort().slice(0, 4).join(":")}`
      : `facts:${dimensions.map((dimension) => dimension.factKey).sort().join(":")}`;
    if (!concerns.has(key)) concerns.set(key, makeFinding(
      rule,
      statement.provenance,
      "UNMODELED_EXCEPTION",
      `the action-specific restriction in source block ${statement.blockId} is not represented by an equivalent prohibition or prerequisite.`,
    ));
  }
  return [...concerns.values()];
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
