import { z } from "zod";

/**
 * Exact-match lookup over precomputed fixture envelopes.
 * This module does not evaluate policy. An unmatched goal never selects another fixture.
 */

export const UNSUPPORTED_GOAL_MESSAGE = "This goal is not available in the offline demonstration.";
export const OFFLINE_PROVENANCE = "Offline fixture — not a live analysis.";

const OptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

const QuestionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    options: z.array(OptionSchema).min(1),
  })
  .strict();

const OutcomeSchema = z
  .object({
    answers: z.record(z.string().min(1), z.string().min(1)),
    envelope: z.unknown(),
  })
  .strict();

const EntrySchema = z
  .object({
    goal: z.string().min(1),
    sessionId: z.string().min(1),
    questions: z.array(QuestionSchema),
    outcomes: z.array(OutcomeSchema).min(1),
  })
  .strict()
  .superRefine((entry, context) => {
    const questionIds = new Set<string>();
    const optionIds = new Map<string, Set<string>>();
    for (const question of entry.questions) {
      if (questionIds.has(question.id)) {
        context.addIssue({ code: "custom", message: "Duplicate question id." });
      }
      questionIds.add(question.id);
      const options = new Set<string>();
      for (const option of question.options) {
        if (options.has(option.id)) context.addIssue({ code: "custom", message: "Duplicate option id." });
        options.add(option.id);
      }
      optionIds.set(question.id, options);
    }
    const seen = new Set<string>();
    for (const outcome of entry.outcomes) {
      const key = answerKey(outcome.answers);
      if (seen.has(key)) context.addIssue({ code: "custom", message: "Duplicate answer combination." });
      seen.add(key);
      for (const [questionId, optionId] of Object.entries(outcome.answers)) {
        const options = optionIds.get(questionId);
        if (options === undefined || !options.has(optionId)) {
          context.addIssue({ code: "custom", message: "Outcome cites an unknown answer." });
        }
      }
    }
  });

export type GoalQuestion = z.infer<typeof QuestionSchema>;
export type GoalEntry = z.infer<typeof EntrySchema>;

export type GoalQuestionView = Readonly<{
  id: string;
  label: string;
  options: readonly Readonly<{ id: string; label: string }>[];
  selectedOptionId?: string;
}>;

export function parseGoalCatalog(input: unknown): readonly GoalEntry[] {
  const parsed = z.array(EntrySchema).safeParse(input);
  return parsed.success ? parsed.data : [];
}

/** Trim only. A different sentence is a different goal. */
export function matchGoal(catalog: readonly GoalEntry[], goal: string): GoalEntry | undefined {
  const trimmed = goal.trim();
  if (trimmed.length === 0) return undefined;
  return catalog.find((entry) => entry.goal === trimmed);
}

export type LookupResult =
  | Readonly<{ ok: true; envelope: unknown }>
  | Readonly<{ ok: false; code: "unknown_answer" }>;

export function lookupOutcome(entry: GoalEntry, answers: Readonly<Record<string, string>>): LookupResult {
  for (const [questionId, optionId] of Object.entries(answers)) {
    const question = entry.questions.find((candidate) => candidate.id === questionId);
    if (question === undefined || !question.options.some((option) => option.id === optionId)) {
      return { ok: false, code: "unknown_answer" };
    }
  }
  const key = answerKey(answers);
  const outcome = entry.outcomes.find((candidate) => answerKey(candidate.answers) === key);
  if (outcome === undefined) return { ok: false, code: "unknown_answer" };
  return { ok: true, envelope: outcome.envelope };
}

export function visibleQuestions(
  entry: GoalEntry,
  mode: "guided" | "all",
  missingLabels: readonly string[],
  answers: Readonly<Record<string, string>>,
): readonly GoalQuestionView[] {
  const missing = new Set(missingLabels);
  const questions = mode === "all" ? entry.questions : entry.questions.filter((question) => missing.has(question.label));
  return questions.map((question) => {
    const selected = answers[question.id];
    return {
      id: question.id,
      label: question.label,
      options: question.options.map((option) => ({ id: option.id, label: option.label })),
      ...(selected === undefined ? {} : { selectedOptionId: selected }),
    };
  });
}

function answerKey(answers: Readonly<Record<string, string>>): string {
  return Object.keys(answers)
    .sort()
    .map((key) => `${key}=${answers[key] ?? ""}`)
    .join("&");
}
