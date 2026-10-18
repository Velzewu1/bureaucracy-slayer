import { z } from "zod";

import type { SiteSnapshot } from "../contracts/index.js";
import {
  hashEvidenceBlockText,
  hashPageSnapshotContent,
  hashSiteSnapshotContent,
  hashWebsiteActionFingerprint,
} from "../shared/index.js";

export const SourceSelectionBudgetSchema = z
  .object({
    maxPages: z.number().int().positive().optional(),
    maxBlocks: z.number().int().positive().optional(),
    maxActions: z.number().int().positive().optional(),
  })
  .strict();

export type SourceSelectionBudget = z.input<typeof SourceSelectionBudgetSchema>;

export const GoalScopedExtractionSchema = z
  .object({
    primaryActionPurpose: z.string().trim().min(1).max(200),
    alternativeActionPurposes: z.array(z.string().trim().min(1).max(200)).max(2).default([]),
  })
  .strict();

export type GoalScopedExtraction = Readonly<{
  primaryActionPurpose: string;
  alternativeActionPurposes?: readonly string[];
}>;
type ParsedGoalScopedExtraction = z.output<typeof GoalScopedExtractionSchema>;

const SourceCountsSchema = z
  .object({
    pages: z.number().int().nonnegative(),
    blocks: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
  })
  .strict();

export const FocusedSourceCatalogSchema = z
  .object({
    sourceSnapshotId: z.string(),
    sourceSnapshotHash: z.string(),
    userGoal: z.string(),
    selectionMode: z.enum(["general", "goal_scoped"]).optional(),
    semanticCoverage: z.literal("not_verified").optional(),
    goalScope: GoalScopedExtractionSchema.optional(),
    coverage: z.enum(["complete", "incomplete"]),
    limitations: z.array(z.string()),
    originalCounts: SourceCountsSchema,
    selectedCounts: SourceCountsSchema,
    pages: z.array(
      z
        .object({
          pageId: z.string(),
          url: z.string(),
          canonicalUrl: z.string(),
          title: z.string(),
          blocks: z.array(z.object({ blockId: z.string(), text: z.string() }).strict()),
          actions: z.array(
            z
              .object({
                websiteActionId: z.string(),
                pageId: z.string(),
                kind: z.enum(["link", "button", "form_control", "form_submit"]),
                label: z.string(),
                targetUrl: z.string().optional(),
                method: z.enum(["GET", "POST"]).optional(),
                visible: z.boolean(),
                enabled: z.boolean(),
                reversible: z.boolean(),
              })
              .strict(),
          ),
          selectionReasons: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

export type FocusedSourceCatalog = Readonly<z.output<typeof FocusedSourceCatalogSchema>>;

export type FocusedSourceBindingOutcome =
  | Readonly<{ ok: true; value: FocusedSourceCatalog }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

function sourceCounts(snapshot: SiteSnapshot): FocusedSourceCatalog["originalCounts"] {
  return {
    pages: snapshot.pages.length,
    blocks: snapshot.pages.reduce((count, page) => count + page.blocks.length, 0),
    actions: snapshot.pages.reduce((count, page) => count + page.actions.length, 0),
  };
}

/** Validates an externally saved focused catalog against its exact source snapshot. */
export function validateFocusedSourceCatalogBindings(
  snapshot: SiteSnapshot,
  input: unknown,
): FocusedSourceBindingOutcome {
  const parsed = FocusedSourceCatalogSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "root"}: ${issue.message}`,
      ),
    };
  }

  const catalog = parsed.data;
  const issues = new Set<string>();
  if (catalog.sourceSnapshotId !== snapshot.id) issues.add("Focused catalog sourceSnapshotId does not match the saved snapshot.");
  if (catalog.sourceSnapshotHash !== snapshot.contentHash) issues.add("Focused catalog sourceSnapshotHash does not match the saved snapshot.");
  snapshot.pages.forEach((page) => {
    page.blocks.forEach((block) => {
      if (block.textHash !== hashEvidenceBlockText(block.text)) {
        issues.add(`Saved EvidenceBlock ${block.id} textHash does not match its text.`);
      }
    });
    page.actions.forEach((action) => {
      if (action.fingerprint !== hashWebsiteActionFingerprint(action)) {
        issues.add(`Saved WebsiteAction ${action.id} fingerprint does not match its binding fields.`);
      }
    });
    if (page.contentHash !== hashPageSnapshotContent(page)) {
      issues.add(`Saved page ${page.id} contentHash does not match its content.`);
    }
  });
  if (snapshot.contentHash !== hashSiteSnapshotContent(snapshot)) {
    issues.add("Saved SiteSnapshot contentHash does not match its content.");
  }

  const actualOriginalCounts = sourceCounts(snapshot);
  if (JSON.stringify(catalog.originalCounts) !== JSON.stringify(actualOriginalCounts)) {
    issues.add("Focused catalog originalCounts do not match the saved snapshot.");
  }
  const actualSelectedCounts = {
    pages: catalog.pages.length,
    blocks: catalog.pages.reduce((count, page) => count + page.blocks.length, 0),
    actions: catalog.pages.reduce((count, page) => count + page.actions.length, 0),
  };
  if (JSON.stringify(catalog.selectedCounts) !== JSON.stringify(actualSelectedCounts)) {
    issues.add("Focused catalog selectedCounts do not match its selected sources.");
  }

  const snapshotPages = new Map(snapshot.pages.map((page) => [page.id, page]));
  const selectedPageIds = new Set<string>();
  const selectedBlockIds = new Set<string>();
  const selectedActionIds = new Set<string>();
  for (const selectedPage of catalog.pages) {
    if (selectedPageIds.has(selectedPage.pageId)) issues.add(`Focused catalog repeats page ${selectedPage.pageId}.`);
    selectedPageIds.add(selectedPage.pageId);
    const page = snapshotPages.get(selectedPage.pageId);
    if (page === undefined) {
      issues.add(`Focused catalog page ${selectedPage.pageId} is absent from the saved snapshot.`);
      continue;
    }
    if (
      selectedPage.url !== page.url ||
      selectedPage.canonicalUrl !== page.canonicalUrl ||
      selectedPage.title !== page.title
    ) {
      issues.add(`Focused catalog metadata for page ${selectedPage.pageId} does not match the saved snapshot.`);
    }
    const blocks = new Map(page.blocks.map((block) => [block.id, block]));
    for (const selectedBlock of selectedPage.blocks) {
      if (selectedBlockIds.has(selectedBlock.blockId)) issues.add(`Focused catalog repeats block ${selectedBlock.blockId}.`);
      selectedBlockIds.add(selectedBlock.blockId);
      const block = blocks.get(selectedBlock.blockId);
      if (block === undefined || block.text !== selectedBlock.text) {
        issues.add(`Focused catalog block ${selectedBlock.blockId} does not match page ${selectedPage.pageId}.`);
      }
    }
    const actions = new Map(page.actions.map((action) => [action.id, action]));
    for (const selectedAction of selectedPage.actions) {
      if (selectedActionIds.has(selectedAction.websiteActionId)) issues.add(`Focused catalog repeats WebsiteAction ${selectedAction.websiteActionId}.`);
      selectedActionIds.add(selectedAction.websiteActionId);
      const action = actions.get(selectedAction.websiteActionId);
      if (
        action === undefined ||
        selectedAction.pageId !== action.pageId ||
        selectedAction.kind !== action.kind ||
        selectedAction.label !== action.label ||
        selectedAction.targetUrl !== action.targetUrl ||
        selectedAction.method !== action.method ||
        selectedAction.visible !== action.visible ||
        selectedAction.enabled !== action.enabled ||
        selectedAction.reversible !== action.reversible
      ) {
        issues.add(`Focused catalog WebsiteAction ${selectedAction.websiteActionId} does not match page ${selectedPage.pageId}.`);
      }
    }
  }

  return issues.size === 0 ? { ok: true, value: catalog } : { ok: false, issues: [...issues] };
}

type RankedPage = Readonly<{
  page: SiteSnapshot["pages"][number];
  score: number;
  priority: number;
  reasons: readonly string[];
  blockIndexes: ReadonlySet<number>;
  actionIds: ReadonlySet<string>;
}>;

type IntentProfile = Readonly<{
  purpose: string;
  tokens: ReadonlySet<string>;
  anchorTokens: ReadonlySet<string>;
  primary: boolean;
}>;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "determine", "do", "for", "from", "how", "i", "identify",
  "if", "in", "is", "it", "my", "of", "on", "or", "the", "this", "to", "was", "whether",
  "with", "wrong",
]);

// These are generic policy-document signals, not domain policy. They influence
// recall only; no signal is converted into a rule or treated as authorization.
const POLICY_SIGNAL =
  /\b(?:may|can|allowed|available|permitted|cannot|can't|must\s+not|not\s+(?:allowed|available|eligible|guaranteed|permitted)|prohibit(?:ed|ion)?|ineligible|only|unless|except|exception|requires?|eligib(?:le|ility)|before|after|until|while|provided|warning|important|alternative|otherwise|appeal|dispute|recover(?:y)?|report|contact\s+support)\b/iu;
const PROCEDURE_SIGNAL =
  /\b(?:click|choose|select|open|submit|request|form|step|procedure|instructions?|how\s+to)\b/iu;
const POLICY_PAGE_SIGNAL =
  /\b(?:policy|policies|rules?|terms|eligib(?:le|ility)|help|faq|support|restriction|limitation|warning|exception)\b/iu;
const REFERENCED_POLICY_LINK_SIGNAL =
  /\b(?:exceptions?|restrictions?|limitations?|eligib(?:le|ility)|special\s+cases|rules?)\b/iu;

function canonicalToken(token: string): string {
  if (token.endsWith("ing") && token.length > 6) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 5) return token.slice(0, -2);
  if (token.endsWith("ies") && token.length > 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function normalizedTokens(value: string): ReadonlySet<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
      .map(canonicalToken) ?? [],
  );
}

function tokenOverlap(value: string, goalTokens: ReadonlySet<string>): number {
  let count = 0;
  for (const token of normalizedTokens(value)) {
    if ([...goalTokens].some((goalToken) => {
      if (token === goalToken) return true;
      const shorter = token.length <= goalToken.length ? token : goalToken;
      const longer = token.length <= goalToken.length ? goalToken : token;
      return shorter.length >= 5 && longer.startsWith(shorter);
    })) count += 1;
  }
  return count;
}

/**
 * Derives a narrow retrieval intent only from labels of actions observed in
 * the trusted snapshot. The user goal can rank those labels, but cannot
 * introduce an action purpose that the collector did not observe.
 */
export function deriveObservedGoalScope(
  snapshot: SiteSnapshot,
  userGoal: string,
): GoalScopedExtraction | undefined {
  const goalTokens = normalizedTokens(userGoal);
  if (goalTokens.size === 0) return undefined;

  const candidates = snapshot.pages.flatMap((page) =>
    page.actions
      .filter((action) => {
        const length = action.label.trim().length;
        return action.visible && length > 0 && length <= 200;
      })
      .map((action) => {
        const overlap = tokenOverlap(action.label, goalTokens);
        const actionTokens = normalizedTokens(action.label);
        return {
          action,
          overlap,
          specificity: actionTokens.size,
          coverage: actionTokens.size === 0 ? 0 : overlap / actionTokens.size,
          operational: action.kind === "link" ? 0 : 1,
          enabled: action.enabled ? 1 : 0,
        };
      })
      .filter((candidate) => candidate.overlap > 0),
  );

  candidates.sort(
    (left, right) =>
      right.coverage - left.coverage ||
      right.overlap - left.overlap ||
      right.operational - left.operational ||
      right.specificity - left.specificity ||
      right.enabled - left.enabled ||
      left.action.label.localeCompare(right.action.label) ||
      left.action.id.localeCompare(right.action.id),
  );
  const best = candidates[0];
  return best === undefined
    ? undefined
    : { primaryActionPurpose: best.action.label };
}

function pageTargetIndex(snapshot: SiteSnapshot): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  snapshot.pages.forEach((page, index) => {
    result.set(page.url, index);
    result.set(page.canonicalUrl, index);
  });
  return result;
}

function pageSearchText(page: SiteSnapshot["pages"][number]): string {
  return `${page.title} ${page.url} ${page.blocks.map((block) => block.text).join(" ")} ` +
    page.actions.map((action) => action.label).join(" ");
}

function anchorTokens(snapshot: SiteSnapshot, tokens: ReadonlySet<string>): ReadonlySet<string> {
  let minimumFrequency = Number.POSITIVE_INFINITY;
  const frequencies = new Map<string, number>();
  for (const token of tokens) {
    const frequency = snapshot.pages.filter(
      (page) => tokenOverlap(pageSearchText(page), new Set([token])) > 0,
    ).length;
    frequencies.set(token, frequency);
    minimumFrequency = Math.min(minimumFrequency, frequency);
  }
  if (!Number.isFinite(minimumFrequency)) return tokens;
  // Frequency only chooses anchors within one intent. Even a site-wide action
  // term survives when it is the intent's best available anchor.
  return new Set(
    [...tokens].filter((token) => frequencies.get(token) === minimumFrequency),
  );
}

function intentProfiles(
  snapshot: SiteSnapshot,
  scope: ParsedGoalScopedExtraction,
): readonly IntentProfile[] {
  return [scope.primaryActionPurpose, ...scope.alternativeActionPurposes].map(
    (purpose, index) => {
      const tokens = normalizedTokens(purpose);
      return {
        purpose,
        tokens,
        anchorTokens: anchorTokens(snapshot, tokens),
        primary: index === 0,
      };
    },
  );
}

function matchesIntent(value: string, intent: IntentProfile): boolean {
  return tokenOverlap(value, intent.anchorTokens) > 0;
}

function isLikelyHeading(text: string): boolean {
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length <= 12 && !/[.!?]["')\]]?$/u.test(text.trim());
}

function contextualBlockIndexes(
  page: SiteSnapshot["pages"][number],
  directIndexes: ReadonlySet<number>,
): ReadonlySet<number> {
  const result = new Set<number>();
  for (const index of directIndexes) {
    for (let candidate = index - 1; candidate <= index + 1; candidate += 1) {
      if (candidate >= 0 && candidate < page.blocks.length) result.add(candidate);
    }
  }
  for (const index of [...result]) {
    const block = page.blocks[index];
    if (block !== undefined && isLikelyHeading(block.text) && index + 1 < page.blocks.length) {
      result.add(index + 1);
    }
  }
  return result;
}

function isOperativePolicyText(text: string, intent: IntentProfile): boolean {
  if (tokenOverlap(text, intent.tokens) === 0 || !POLICY_SIGNAL.test(text)) return false;
  const words = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  const trimmed = text.trim();
  const sentenceLike = /[.!?]["')\]]?$/u.test(trimmed) || words.length >= 14;
  const teaser = /^(?:learn|overview|guide|how|when|where|why|what|which)\b/iu.test(trimmed) &&
    words.length < 20;
  // This is a structural coverage floor, never semantic validation. It keeps
  // headings and directory teasers from making source coverage look complete.
  return sentenceLike && !teaser;
}

function rankGeneralPages(
  snapshot: SiteSnapshot,
  userGoal: string,
): readonly RankedPage[] {
  const goalTokens = normalizedTokens(userGoal);
  const targetIndexes = pageTargetIndex(snapshot);
  const direct = snapshot.pages.map((page) => {
    const metadata = `${page.title} ${page.url}`;
    const metadataOverlap = tokenOverlap(metadata, goalTokens);
    const policyPage = POLICY_PAGE_SIGNAL.test(metadata);
    const relevantBlocks = new Set<number>();
    let blockScore = 0;
    page.blocks.forEach((block, index) => {
      const overlap = tokenOverlap(block.text, goalTokens);
      const policySignal = POLICY_SIGNAL.test(block.text);
      const procedureSignal = PROCEDURE_SIGNAL.test(block.text);
      if (overlap > 0 || (policyPage && (policySignal || procedureSignal))) {
        relevantBlocks.add(index);
        if (index > 0) relevantBlocks.add(index - 1);
        if (index + 1 < page.blocks.length) relevantBlocks.add(index + 1);
      }
      blockScore += overlap * 5 + (overlap > 0 && policySignal ? 4 : 0) +
        (overlap > 0 && procedureSignal ? 2 : 0);
    });
    const actionOverlap = page.actions.reduce(
      (score, action) => score + tokenOverlap(action.label, goalTokens) * 4,
      0,
    );
    const directRelevant = metadataOverlap > 0 || actionOverlap > 0 || relevantBlocks.size > 0;
    const reasons = [
      ...(metadataOverlap > 0 ? ["goal-matching page metadata"] : []),
      ...(relevantBlocks.size > 0 ? ["goal or policy-signaled evidence"] : []),
      ...(actionOverlap > 0 ? ["goal-matching observed action"] : []),
      ...(policyPage ? ["policy/help page metadata"] : []),
    ];
    return {
      page,
      score: metadataOverlap * 8 + blockScore + actionOverlap + (policyPage && directRelevant ? 3 : 0),
      directRelevant,
      reasons,
      blockIndexes: relevantBlocks,
    };
  });

  const selectedIndexes = new Set<number>();
  direct.forEach((entry, index) => {
    if (entry.directRelevant) selectedIndexes.add(index);
  });
  const directIndexes = new Set(selectedIndexes);

  // Follow one observed navigation hop in either direction. This retains a
  // procedure page linked from policy text and a policy/help page linked from a
  // procedure page without recursively pulling in the whole site.
  direct.forEach((entry, sourceIndex) => {
    for (const action of entry.page.actions) {
      if (action.targetUrl === undefined) continue;
      const targetIndex = targetIndexes.get(action.targetUrl);
      if (targetIndex === undefined) continue;
      if (directIndexes.has(sourceIndex) || directIndexes.has(targetIndex)) {
        selectedIndexes.add(sourceIndex);
        selectedIndexes.add(targetIndex);
      }
    }
  });

  if (selectedIndexes.size === 0) {
    snapshot.pages.forEach((_page, index) => selectedIndexes.add(index));
  }

  return direct
    .map((entry, index): RankedPage | undefined => {
      if (!selectedIndexes.has(index)) return undefined;
      const linked = !entry.directRelevant;
      const blockIndexes = new Set(entry.blockIndexes);
      if (blockIndexes.size === 0) {
        entry.page.blocks.forEach((_block, blockIndex) => blockIndexes.add(blockIndex));
      }
      return {
        page: entry.page,
        score: entry.score + (linked ? 1 : 0),
        priority: 0,
        reasons: linked ? [...entry.reasons, "one-hop internal navigation"] : entry.reasons,
        blockIndexes,
        actionIds: new Set<string>(),
      };
    })
    .filter((entry): entry is RankedPage => entry !== undefined)
    .sort((left, right) => right.score - left.score || left.page.id.localeCompare(right.page.id));
}

function rankGoalScopedPages(
  snapshot: SiteSnapshot,
  scope: ParsedGoalScopedExtraction,
): readonly RankedPage[] {
  const intents = intentProfiles(snapshot, scope);
  const targetIndexes = pageTargetIndex(snapshot);
  const candidates = snapshot.pages.map((page) => {
    const directBlockIndexes = new Set<number>();
    const actionIds = new Set<string>();
    let score = 0;
    let priority = Number.POSITIVE_INFINITY;
    const reasons = new Set<string>();

    intents.forEach((intent, intentIndex) => {
      const intentPriority = intent.primary ? 0 : 1;
      const weight = intent.primary ? 10 : 4;
      const metadata = `${page.title} ${page.url}`;
      if (matchesIntent(metadata, intent)) {
        score += weight * 3;
        priority = Math.min(priority, intentPriority);
        reasons.add(intent.primary ? "primary-intent page metadata" : "fallback-intent page metadata");
      }
      page.blocks.forEach((block, blockIndex) => {
        if (!matchesIntent(block.text, intent)) return;
        directBlockIndexes.add(blockIndex);
        score += weight + (POLICY_SIGNAL.test(block.text) ? weight : 0);
        priority = Math.min(priority, intentPriority);
        reasons.add(intent.primary ? "primary-intent evidence" : "fallback-intent evidence");
      });
      page.actions.forEach((action) => {
        if (!matchesIntent(action.label, intent)) return;
        actionIds.add(action.id);
        score += weight * (action.kind === "link" ? 2 : 4);
        priority = Math.min(priority, intentPriority);
        reasons.add(
          action.kind === "link"
            ? "intent-matching informational navigation"
            : "intent-matching operational control",
        );
      });
      if (intentIndex === 0 && priority === 0) reasons.add("primary intent preserved");
    });

    return {
      page,
      score,
      priority,
      reasons,
      blockIndexes: new Set(contextualBlockIndexes(page, directBlockIndexes)),
      actionIds,
      directRelevant: Number.isFinite(priority),
    };
  });

  const directIndexes = new Set<number>();
  candidates.forEach((candidate, index) => {
    if (candidate.directRelevant) directIndexes.add(index);
  });
  const selectedIndexes = new Set(directIndexes);

  // Follow one explicit, observed cross-page reference from a directly relevant
  // page. The link label must itself match an intent or be named in selected
  // context, preventing global Help/Support navigation from sweeping the site.
  for (const sourceIndex of directIndexes) {
    const source = candidates[sourceIndex];
    if (source === undefined) continue;
    const selectedText = [...source.blockIndexes]
      .map((blockIndex) => source.page.blocks[blockIndex]?.text ?? "")
      .join(" ");
    for (const action of source.page.actions) {
      if (action.kind !== "link" || action.targetUrl === undefined) continue;
      const targetIndex = targetIndexes.get(action.targetUrl);
      if (targetIndex === undefined || targetIndex === sourceIndex) continue;
      const labelTokens = normalizedTokens(action.label);
      const labelIsReferenced = labelTokens.size > 0 &&
        tokenOverlap(selectedText, labelTokens) >= Math.min(2, labelTokens.size);
      const matchesScopedIntent = intents.some((intent) => matchesIntent(action.label, intent));
      const explicitlyNamesPolicyContext = REFERENCED_POLICY_LINK_SIGNAL.test(action.label);
      if (!labelIsReferenced && !matchesScopedIntent && !explicitlyNamesPolicyContext) continue;
      selectedIndexes.add(targetIndex);
      source.actionIds.add(action.id);
      source.reasons.add("observed link to relevant policy context");
      const target = candidates[targetIndex];
      if (target !== undefined) {
        if (!target.directRelevant) {
          target.priority = source.priority;
          target.score = Math.max(target.score, source.score - 1);
        }
        target.reasons.add("one-hop referenced policy context");
        if (target.blockIndexes.size === 0) {
          target.page.blocks.forEach((_block, blockIndex) => target.blockIndexes.add(blockIndex));
        }
      }
    }
  }

  return candidates
    .map((candidate, index): RankedPage | undefined => {
      if (!selectedIndexes.has(index)) return undefined;
      return {
        page: candidate.page,
        score: candidate.score,
        priority: candidate.priority,
        reasons: [...candidate.reasons],
        blockIndexes: candidate.blockIndexes,
        actionIds: candidate.actionIds,
      };
    })
    .filter((candidate): candidate is RankedPage => candidate !== undefined)
    .sort((left, right) =>
      left.priority - right.priority || right.score - left.score ||
      left.page.id.localeCompare(right.page.id),
    );
}

function originalCounts(snapshot: SiteSnapshot): FocusedSourceCatalog["originalCounts"] {
  return sourceCounts(snapshot);
}

export function selectFocusedSources(
  snapshot: SiteSnapshot,
  userGoal: string,
  budgetInput?: SourceSelectionBudget,
  goalScopeInput?: GoalScopedExtraction,
): FocusedSourceCatalog {
  const budget = SourceSelectionBudgetSchema.parse(budgetInput ?? {});
  const goalScope = goalScopeInput === undefined
    ? undefined
    : GoalScopedExtractionSchema.parse(goalScopeInput);
  const rankedPages = goalScope === undefined
    ? rankGeneralPages(snapshot, userGoal)
    : rankGoalScopedPages(snapshot, goalScope);
  const goalTokens = normalizedTokens(userGoal);
  const selectedPageUrls = new Set(
    rankedPages.flatMap((entry) => [entry.page.url, entry.page.canonicalUrl]),
  );
  const limitations: string[] = [];
  const pageLimit = budget.maxPages ?? Number.POSITIVE_INFINITY;
  const blockLimit = budget.maxBlocks ?? Number.POSITIVE_INFINITY;
  const actionLimit = budget.maxActions ?? Number.POSITIVE_INFINITY;
  const selectedPages: Array<FocusedSourceCatalog["pages"][number]> = [];
  let selectedBlocks = 0;
  let selectedActions = 0;

  for (const ranked of rankedPages) {
    const blocks = [...ranked.blockIndexes]
      .sort((left, right) => left - right)
      .map((index) => ranked.page.blocks[index])
      .filter((block): block is SiteSnapshot["pages"][number]["blocks"][number] => block !== undefined);
    const actions = ranked.page.actions.filter((action) =>
      goalScope === undefined
        ? tokenOverlap(action.label, goalTokens) > 0 ||
          POLICY_SIGNAL.test(action.label) ||
          PROCEDURE_SIGNAL.test(action.label) ||
          (action.targetUrl !== undefined && selectedPageUrls.has(action.targetUrl))
        : ranked.actionIds.has(action.id),
    );
    const pageFits = selectedPages.length < pageLimit;
    const blocksFit = selectedBlocks + blocks.length <= blockLimit;
    const actionsFit = selectedActions + actions.length <= actionLimit;
    if (!pageFits || !blocksFit || !actionsFit) {
      limitations.push(
        `Required focused page ${ranked.page.id} did not fit the configured source-selection budget.`,
      );
      continue;
    }
    selectedPages.push({
      pageId: ranked.page.id,
      url: ranked.page.url,
      canonicalUrl: ranked.page.canonicalUrl,
      title: ranked.page.title,
      blocks: blocks.map((block) => ({ blockId: block.id, text: block.text })),
      actions: actions.map((action) => ({
        websiteActionId: action.id,
        pageId: action.pageId,
        kind: action.kind,
        label: action.label,
        ...(action.targetUrl === undefined ? {} : { targetUrl: action.targetUrl }),
        ...(action.method === undefined ? {} : { method: action.method }),
        visible: action.visible,
        enabled: action.enabled,
        reversible: action.reversible,
      })),
      selectionReasons: [...ranked.reasons],
    });
    selectedBlocks += blocks.length;
    selectedActions += actions.length;
  }

  if (selectedPages.length === 0) {
    limitations.push("No required focused page fit the configured source-selection budget.");
  }
  if (goalScope !== undefined) {
    const intents = intentProfiles(snapshot, goalScope);
    for (const intent of intents) {
      const hasAction = selectedPages.some((page) =>
        page.actions.some((action) => matchesIntent(action.label, intent)),
      );
      const hasOperativePolicyEvidence = selectedPages.some((page) =>
        page.blocks.some((block) => isOperativePolicyText(block.text, intent)),
      );
      const scopeLabel = intent.primary
        ? "the primary goal-scoped action purpose"
        : `the alternative goal-scoped action purpose: ${intent.purpose}`;
      if (!hasAction) {
        limitations.push(`No observed WebsiteAction matched ${scopeLabel}.`);
      }
      if (!hasOperativePolicyEvidence) {
        limitations.push(`No selected operative policy evidence matched ${scopeLabel}.`);
      }
    }
  }

  return {
    sourceSnapshotId: snapshot.id,
    sourceSnapshotHash: snapshot.contentHash,
    userGoal,
    selectionMode: goalScope === undefined ? "general" : "goal_scoped",
    semanticCoverage: "not_verified",
    ...(goalScope === undefined ? {} : { goalScope }),
    coverage: limitations.length === 0 ? "complete" : "incomplete",
    limitations: [...new Set(limitations)],
    originalCounts: originalCounts(snapshot),
    selectedCounts: {
      pages: selectedPages.length,
      blocks: selectedBlocks,
      actions: selectedActions,
    },
    pages: selectedPages,
  };
}
