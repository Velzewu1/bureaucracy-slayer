import { z } from "zod";

import type { GuidanceView } from "./guidance.js";
import type { GoalQuestionView } from "./goals.js";

/** Panel -> background. Commands name a goal, an answer id, or a step index. Never a URL or selector. */
export const PanelCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("GET_VIEW") }).strict(),
  z.object({ type: z.literal("ANALYZE"), goal: z.string().max(2_000) }).strict(),
  z.object({ type: z.literal("GOAL_EDITED"), goal: z.string().max(2_000) }).strict(),
  z
    .object({
      type: z.literal("ANSWER"),
      questionId: z.string().min(1),
      optionId: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal("SET_FACT_MODE"), mode: z.enum(["guided", "all"]) }).strict(),
  z.object({ type: z.literal("LOAD_FIXTURE"), fixtureId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("INVALIDATE") }).strict(),
  z.object({ type: z.literal("RESET") }).strict(),
  z.object({ type: z.literal("OPEN_STEP"), index: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("SHOW_STEP"), index: z.number().int().positive() }).strict(),
  z
    .object({ type: z.literal("MARK_DONE"), index: z.number().int().positive(), done: z.boolean() })
    .strict(),
  z.object({ type: z.literal("CLEAR_HIGHLIGHT") }).strict(),
]);
export type PanelCommand = z.infer<typeof PanelCommandSchema>;

export type ActionOutcome =
  | "none"
  | "opened"
  | "highlighted"
  | "find_manually"
  | "denied"
  | "rejected_fixture"
  | "no_portal_tab"
  | "unsupported_goal"
  | "goal_required";

export type PanelResponse = Readonly<{
  view: GuidanceView;
  fixtures: readonly Readonly<{ id: string; label: string }>[];
  questions: readonly GoalQuestionView[];
  factMode: "guided" | "all";
  canPersonalize: boolean;
  outcome: ActionOutcome;
  /** Present only for highlighted, denied, or rejected outcomes. */
  detail?: string;
  /** Persistent operational or unsupported-goal message. */
  notice?: string;
}>;

/** Background -> content script (sent only to a verified portal tab). */
export const ContentCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("HIGHLIGHT"),
      spec: z
        .object({
          trustedOrigin: z.string().min(1),
          sourcePageUrl: z.string().min(1),
          mode: z.enum(["navigation", "state_changing"]),
          role: z.string().min(1).optional(),
          accessibleName: z.string().min(1),
          actionKind: z.enum(["link", "button", "form_control", "form_submit"]),
          expectedHref: z.string().min(1).optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal("CLEAR") }).strict(),
]);
export type ContentCommand = z.infer<typeof ContentCommandSchema>;

export type ContentResult = Readonly<{ ok: boolean; code: string }>;
