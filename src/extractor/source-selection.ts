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
  reasons: readonly string[];
  blockIndexes: ReadonlySet<number>;
}>;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "determine", "do", "for", "from", "how", "i", "identify",
  "if", "in", "is", "it", "my", "of", "on", "or", "the", "this", "to", "was", "whether",
  "with", "wrong",
]);

// These are generic policy-document signals, not domain policy. They influence
// recall only; no signal is converted into a rule or treated as authorization.
const POLICY_SIGNAL =
  /\b(?:cannot|must\s+not|not\s+(?:allowed|available|eligible|guaranteed|permitted)|prohibit(?:ed|ion)?|ineligible|only|unless|except|exception|requires?|eligib(?:le|ility)|before|after|until|while|provided|warning|important|alternative|otherwise|appeal|dispute|recover(?:y)?|report|contact\s+support)\b/iu;
const PROCEDURE_SIGNAL =
  /\b(?:click|choose|select|open|submit|request|form|step|procedure|instructions?|how\s+to)\b/iu;
const POLICY_PAGE_SIGNAL =
  /\b(?:policy|policies|rules?|terms|eligib(?:le|ility)|help|faq|support|restriction|limitation|warning|exception)\b/iu;

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
    if (goalTokens.has(token)) count += 1;
  }
  return count;
}

function pageTargetIndex(snapshot: SiteSnapshot): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  snapshot.pages.forEach((page, index) => {
    result.set(page.url, index);
    result.set(page.canonicalUrl, index);
  });
  return result;
}

function distinctiveScopeTokens(
  snapshot: SiteSnapshot,
  scope: ParsedGoalScopedExtraction,
): ReadonlySet<string> {
  const requested = normalizedTokens(
    [scope.primaryActionPurpose, ...scope.alternativeActionPurposes].join(" "),
  );
  const maximumPageFrequency = Math.max(1, Math.ceil(snapshot.pages.length * 0.6));
  const result = new Set<string>();
  for (const token of requested) {
    const frequency = snapshot.pages.filter((page) =>
      normalizedTokens(
        `${page.title} ${page.url} ${page.blocks.map((block) => block.text).join(" ")} ` +
          page.actions.map((action) => action.label).join(" "),
      ).has(token),
    ).length;
    if (frequency <= maximumPageFrequency) result.add(token);
  }
  return result.size > 0 ? result : requested;
}

function rankPages(
  snapshot: SiteSnapshot,
  userGoal: string,
  goalScope?: ParsedGoalScopedExtraction,
): readonly RankedPage[] {
  const scoped = goalScope !== undefined;
  const goalTokens = scoped ? distinctiveScopeTokens(snapshot, goalScope) : normalizedTokens(userGoal);
  const primaryTokens = goalScope === undefined
    ? goalTokens
    : distinctiveScopeTokens(snapshot, { ...goalScope, alternativeActionPurposes: [] });
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
      if (overlap > 0 || (!scoped && policyPage && (policySignal || procedureSignal))) {
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
      ...(policyPage && (!scoped || directRelevant) ? ["policy/help page metadata"] : []),
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
      const sourceMetadata = `${entry.page.title} ${entry.page.url}`;
      const sourceCanIntroduceRestrictions =
        scoped && directIndexes.has(sourceIndex) &&
        POLICY_PAGE_SIGNAL.test(sourceMetadata) && tokenOverlap(sourceMetadata, primaryTokens) > 0;
      const targetMetadata = `${direct[targetIndex]?.page.title ?? ""} ${direct[targetIndex]?.page.url ?? ""}`;
      const scopedLinkIsRelevant =
        directIndexes.has(targetIndex) ||
        (sourceCanIntroduceRestrictions && POLICY_PAGE_SIGNAL.test(targetMetadata));
      if (
        (!scoped && (directIndexes.has(sourceIndex) || directIndexes.has(targetIndex))) ||
        (scoped && directIndexes.has(sourceIndex) && scopedLinkIsRelevant)
      ) {
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
        reasons: linked ? [...entry.reasons, "one-hop internal navigation"] : entry.reasons,
        blockIndexes,
      };
    })
    .filter((entry): entry is RankedPage => entry !== undefined)
    .sort((left, right) => right.score - left.score || left.page.id.localeCompare(right.page.id));
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
  const rankedPages = rankPages(snapshot, userGoal, goalScope);
  const goalTokens = goalScope === undefined
    ? normalizedTokens(userGoal)
    : distinctiveScopeTokens(snapshot, goalScope);
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
    const actions = ranked.page.actions.filter(
      (action) =>
        tokenOverlap(action.label, goalTokens) > 0 ||
        POLICY_SIGNAL.test(action.label) ||
        PROCEDURE_SIGNAL.test(action.label) ||
        (action.targetUrl !== undefined && selectedPageUrls.has(action.targetUrl)),
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
    const primaryTokens = distinctiveScopeTokens(snapshot, {
      ...goalScope,
      alternativeActionPurposes: [],
    });
    const hasPrimaryAction = selectedPages.some((page) =>
      page.actions.some((action) => tokenOverlap(action.label, primaryTokens) > 0),
    );
    const hasPrimaryPolicyEvidence = selectedPages.some((page) =>
      page.blocks.some(
        (block) => tokenOverlap(block.text, primaryTokens) > 0 && POLICY_SIGNAL.test(block.text),
      ),
    );
    if (!hasPrimaryAction) {
      limitations.push("No observed WebsiteAction matched the primary goal-scoped action purpose.");
    }
    if (!hasPrimaryPolicyEvidence) {
      limitations.push("No selected policy evidence matched the primary goal-scoped action purpose.");
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
