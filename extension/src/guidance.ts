import {
  GuidanceEnvelopeSchema,
  canonicalJson,
  sha256Hex,
  type GuidanceEnvelope,
  type GuidanceStep,
  type GuidanceTarget,
  type PlanStatus,
} from "./envelope.js";

/**
 * Pure, DOM-free and chrome-free trust checks. Everything that can enable
 * navigation or highlighting goes through this module so it is unit-testable.
 */

/** Origins this build is permitted to guide. Must match manifest host_permissions. */
export const TRUSTED_ORIGINS: readonly string[] = ["http://127.0.0.1:5180"];

export type RejectionCode =
  | "SCHEMA_INVALID"
  | "INTEGRITY_MISMATCH"
  | "UNSUPPORTED_ORIGIN"
  | "UNGROUNDED_TARGET";

export type EnvelopeCheck =
  | Readonly<{ ok: true; envelope: GuidanceEnvelope }>
  | Readonly<{ ok: false; code: RejectionCode }>;

/** Normalizes a URL for exact comparison. Returns undefined for anything unsafe or unparsable. */
export function normalizeHttpUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
  return url.href;
}

export function isTrustedUrl(value: string, trustedOrigin: string): boolean {
  const normalized = normalizeHttpUrl(value);
  return normalized !== undefined && new URL(normalized).origin === trustedOrigin;
}

function targetUrls(target: GuidanceTarget): readonly string[] {
  return target.destinationUrl === undefined
    ? [target.sourcePageUrl]
    : [target.sourcePageUrl, target.destinationUrl];
}

function targetsAreGrounded(envelope: GuidanceEnvelope): boolean {
  const observed = new Set<string>();
  for (const page of envelope.observedPages) {
    const normalized = normalizeHttpUrl(page);
    if (normalized === undefined || new URL(normalized).origin !== envelope.trustedOrigin) return false;
    observed.add(normalized);
  }
  for (const citation of envelope.citations) {
    if (!isTrustedUrl(citation.pageUrl, envelope.trustedOrigin)) return false;
  }
  for (const step of envelope.steps) {
    if (step.target === null) continue;
    for (const url of targetUrls(step.target)) {
      const normalized = normalizeHttpUrl(url);
      if (normalized === undefined || !observed.has(normalized)) return false;
    }
  }
  return true;
}

export async function checkEnvelope(
  raw: unknown,
  trustedOrigins: readonly string[] = TRUSTED_ORIGINS,
): Promise<EnvelopeCheck> {
  const parsed = GuidanceEnvelopeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "SCHEMA_INVALID" };
  const envelope = parsed.data;
  const { integrity, ...body } = envelope;
  if ((await sha256Hex(canonicalJson(body))) !== integrity) return { ok: false, code: "INTEGRITY_MISMATCH" };
  if (!trustedOrigins.includes(envelope.trustedOrigin)) return { ok: false, code: "UNSUPPORTED_ORIGIN" };
  if (!targetsAreGrounded(envelope)) return { ok: false, code: "UNGROUNDED_TARGET" };
  return { ok: true, envelope };
}

/**
 * WebsiteAction identity is provenance, not proof of safety. Only an observed
 * GET link with a recorded destination is a safe navigation; everything else
 * (buttons, form controls, submits, POST) is state-changing or unknown and is
 * left for the user to perform by hand.
 */
export type TargetClass = "navigation" | "state_changing";

export function classifyTarget(target: GuidanceTarget): TargetClass {
  const isGetLink =
    target.actionKind === "link" &&
    (target.method === undefined || target.method === "GET") &&
    target.destinationUrl !== undefined;
  return isGetLink ? "navigation" : "state_changing";
}

// ---------------------------------------------------------------------------
// Session assessment (freshness, invalidation, replay)

export type StoredSession = Readonly<{
  envelope: unknown;
  acceptedAtMs: number;
  invalidated: boolean;
  doneSteps: readonly number[];
}>;

export type SessionAssessment =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "rejected"; code: RejectionCode }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "invalidated" }>
  | Readonly<{ kind: "superseded" }>
  | Readonly<{
      kind: "authoritative";
      envelope: GuidanceEnvelope;
      doneSteps: readonly number[];
      remainingMs: number;
    }>;

export async function assessSession(
  stored: StoredSession | undefined,
  highestSequence: Readonly<Record<string, number>>,
  nowMs: number,
  trustedOrigins: readonly string[] = TRUSTED_ORIGINS,
): Promise<SessionAssessment> {
  if (stored === undefined) return { kind: "none" };
  const check = await checkEnvelope(stored.envelope, trustedOrigins);
  if (!check.ok) return { kind: "rejected", code: check.code };
  const { envelope } = check;
  if (stored.invalidated) return { kind: "invalidated" };
  if (envelope.sequence < (highestSequence[envelope.sessionId] ?? 0)) return { kind: "superseded" };
  const remainingMs = stored.acceptedAtMs + envelope.validForMs - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0 || stored.acceptedAtMs > nowMs) {
    return { kind: "expired" };
  }
  return { kind: "authoritative", envelope, doneSteps: stored.doneSteps, remainingMs };
}

/** Rejects an incoming envelope that would roll a session back. */
export function isReplay(
  envelope: GuidanceEnvelope,
  highestSequence: Readonly<Record<string, number>>,
): boolean {
  return envelope.sequence <= (highestSequence[envelope.sessionId] ?? 0);
}

// ---------------------------------------------------------------------------
// Step action resolution (the background resolves targets itself; the panel
// can only name a step index, never supply a URL or selector).

export type StepActionDenial =
  | "NOT_AUTHORITATIVE"
  | "PLAN_NOT_READY"
  | "NO_SUCH_STEP"
  | "NO_TARGET"
  | "NOT_NAVIGATION"
  | "UNTRUSTED_URL";

export type ResolvedOpen = Readonly<{ ok: true; url: string }>;
export type ResolvedShow = Readonly<{
  ok: true;
  sourcePageUrl: string;
  spec: HighlightSpec;
}>;
export type Denied = Readonly<{ ok: false; code: StepActionDenial }>;

export type HighlightSpec = Readonly<{
  trustedOrigin: string;
  sourcePageUrl: string;
  mode: TargetClass;
  role: string | undefined;
  accessibleName: string;
  actionKind: GuidanceTarget["actionKind"];
  expectedHref: string | undefined;
}>;

function findStep(
  assessment: SessionAssessment,
  stepIndex: number,
): Readonly<{ envelope: GuidanceEnvelope; step: GuidanceStep }> | Denied {
  if (assessment.kind !== "authoritative") return { ok: false, code: "NOT_AUTHORITATIVE" };
  if (assessment.envelope.planStatus !== "ready") return { ok: false, code: "PLAN_NOT_READY" };
  const step = assessment.envelope.steps.find((candidate) => candidate.index === stepIndex);
  if (step === undefined) return { ok: false, code: "NO_SUCH_STEP" };
  return { envelope: assessment.envelope, step };
}

export function resolveOpen(assessment: SessionAssessment, stepIndex: number): ResolvedOpen | Denied {
  const found = findStep(assessment, stepIndex);
  if ("ok" in found) return found;
  const { envelope, step } = found;
  if (step.target === null) return { ok: false, code: "NO_TARGET" };
  if (classifyTarget(step.target) !== "navigation") return { ok: false, code: "NOT_NAVIGATION" };
  const destination = step.target.destinationUrl;
  if (destination === undefined) return { ok: false, code: "NOT_NAVIGATION" };
  if (!isTrustedUrl(destination, envelope.trustedOrigin)) return { ok: false, code: "UNTRUSTED_URL" };
  const normalized = normalizeHttpUrl(destination);
  return normalized === undefined ? { ok: false, code: "UNTRUSTED_URL" } : { ok: true, url: normalized };
}

export function resolveShow(assessment: SessionAssessment, stepIndex: number): ResolvedShow | Denied {
  const found = findStep(assessment, stepIndex);
  if ("ok" in found) return found;
  const { envelope, step } = found;
  const { target } = step;
  if (target === null) return { ok: false, code: "NO_TARGET" };
  if (!isTrustedUrl(target.sourcePageUrl, envelope.trustedOrigin)) return { ok: false, code: "UNTRUSTED_URL" };
  const normalizedSource = normalizeHttpUrl(target.sourcePageUrl);
  if (normalizedSource === undefined) return { ok: false, code: "UNTRUSTED_URL" };
  const mode = classifyTarget(target);
  return {
    ok: true,
    sourcePageUrl: normalizedSource,
    spec: {
      trustedOrigin: envelope.trustedOrigin,
      sourcePageUrl: normalizedSource,
      mode,
      role: target.role,
      accessibleName: target.accessibleName,
      actionKind: target.actionKind,
      expectedHref:
        mode === "navigation" && target.destinationUrl !== undefined
          ? normalizeHttpUrl(target.destinationUrl)
          : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// View model for the side panel

export type Availability =
  | "none"
  | "rejected"
  | "expired"
  | "invalidated"
  | "superseded"
  | PlanStatus;

export type StepView = Readonly<{
  index: number;
  title: string;
  instruction: string;
  done: boolean;
  /** "navigate": the extension may open the page after an explicit click. "manual": user acts by hand. */
  kind: "navigate" | "manual";
  canOpen: boolean;
  canShow: boolean;
  manualNote: string | undefined;
  citations: readonly Readonly<{ pageTitle: string; pageUrl: string; excerpt: string }>[];
}>;

export type GuidanceView = Readonly<{
  availability: Availability;
  /** True only when the displayed guidance is current, verified, and ready. */
  navigable: boolean;
  headline: string;
  message: string;
  goal: string | undefined;
  sourceLabel: string | undefined;
  steps: readonly StepView[];
  nextStepIndex: number | undefined;
  missingFactLabels: readonly string[];
  notices: readonly string[];
  remainingMs: number | undefined;
}>;

const NOTICE_TEXT: Readonly<Record<string, string>> = {
  EVIDENCE_REJECTED: "Some supporting policy evidence could not be verified against the website.",
  EVIDENCE_INVALID: "Some supporting policy evidence could not be verified against the website.",
  ACTION_UNVERIFIED: "A required website control could not be verified.",
  MISSING_STEP_PROVENANCE: "A step is missing its supporting policy citation.",
  MISSING_PREREQUISITE: "A required earlier step is missing.",
  DEPENDENCY_CYCLE: "The route contains a circular dependency.",
  ARTIFACT_MISMATCH: "The analysis no longer matches the website snapshot.",
  USER_STATE_HASH_MISMATCH: "The analysis no longer matches your latest answers.",
  NO_ROUTE: "No route toward your goal is available.",
};

const GENERIC_NOTICE = "Additional policy conditions apply. Check the cited source pages.";

function friendlyNotices(codes: readonly string[]): readonly string[] {
  const texts = codes
    .filter((code) => code !== "ROUTE_READY")
    .map((code) => NOTICE_TEXT[code] ?? GENERIC_NOTICE);
  return [...new Set(texts)];
}

const EMPTY_VIEW: Omit<GuidanceView, "availability" | "headline" | "message"> = {
  navigable: false,
  goal: undefined,
  sourceLabel: undefined,
  steps: [],
  nextStepIndex: undefined,
  missingFactLabels: [],
  notices: [],
  remainingMs: undefined,
};

const NON_AUTHORITATIVE: Readonly<Record<"none" | "rejected" | "expired" | "invalidated" | "superseded", Readonly<{ headline: string; message: string }>>> = {
  none: {
    headline: "No guidance loaded",
    message: "Load a demo scenario to follow a verified fixture route on Northstar.",
  },
  rejected: {
    headline: "Guidance rejected",
    message: "This route failed validation, so nothing here can navigate or highlight the site.",
  },
  expired: {
    headline: "Guidance expired",
    message: "This route is out of date. Load a fresh scenario before continuing.",
  },
  invalidated: {
    headline: "Session invalidated",
    message: "Your goal or answers changed, so this route is no longer authoritative.",
  },
  superseded: {
    headline: "Newer route available",
    message: "A newer analysis replaced this route. It is no longer authoritative.",
  },
};

const STATUS_COPY: Readonly<Record<PlanStatus, Readonly<{ headline: string; message: string }>>> = {
  ready: {
    headline: "Verified fixture route",
    message: "Follow the next step. You complete every action yourself.",
  },
  needs_information: {
    headline: "More information needed",
    message: "A route cannot be confirmed until these details are answered in Bureaucracy Slayer.",
  },
  blocked: {
    headline: "No permitted route",
    message: "Cited policy prohibits this for the current situation. Do not attempt it.",
  },
  review_required: {
    headline: "Human review required",
    message: "Policy evidence could not be fully verified, so no route is authorized.",
  },
  stale: {
    headline: "Stale route",
    message: "This analysis no longer matches the latest data, so no route is authorized.",
  },
};

/** Stable identity of a view for UI refresh. Omits the ticking freshness clock. */
export function viewFingerprint(view: GuidanceView): string {
  const { remainingMs: _remainingMs, ...rest } = view;
  return JSON.stringify(rest);
}

export function buildView(assessment: SessionAssessment): GuidanceView {
  if (assessment.kind !== "authoritative") {
    const copy = NON_AUTHORITATIVE[assessment.kind];
    return { ...EMPTY_VIEW, availability: assessment.kind, ...copy };
  }
  const { envelope, doneSteps, remainingMs } = assessment;
  const copy = STATUS_COPY[envelope.planStatus];
  const ready = envelope.planStatus === "ready";
  const citationsById = new Map(envelope.citations.map((citation) => [citation.id, citation]));
  const steps: StepView[] = ready
    ? envelope.steps.map((step) => {
        const target = step.target;
        const kind = target !== null && classifyTarget(target) === "navigation" ? "navigate" : "manual";
        return {
          index: step.index,
          title: step.title,
          instruction: step.instruction,
          done: doneSteps.includes(step.index),
          kind,
          canOpen: kind === "navigate",
          canShow: target !== null,
          manualNote:
            kind === "manual"
              ? target === null
                ? "Do this yourself; it is not tied to a page control."
                : "This changes your account. Do it yourself on the website; the extension will never click it."
              : undefined,
          citations: step.citationIds.flatMap((id) => {
            const citation = citationsById.get(id);
            return citation === undefined
              ? []
              : [{ pageTitle: citation.pageTitle, pageUrl: citation.pageUrl, excerpt: citation.excerpt }];
          }),
        };
      })
    : [];
  const next = steps.find((step) => !step.done);
  return {
    availability: envelope.planStatus,
    navigable: ready,
    headline: copy.headline,
    message: copy.message,
    goal: envelope.goal,
    sourceLabel: envelope.sourceLabel,
    steps,
    nextStepIndex: next?.index,
    missingFactLabels: envelope.missingFactLabels,
    notices: friendlyNotices(envelope.notices),
    remainingMs,
  };
}
