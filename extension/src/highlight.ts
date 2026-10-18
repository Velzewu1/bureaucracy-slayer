import { normalizeHttpUrl, type HighlightSpec } from "./guidance.js";

/**
 * Pure matching of an observed target against page candidates. The content
 * script only describes DOM elements; deciding whether exactly one element is
 * the expected control happens here so it can be tested without a browser.
 */

export type Candidate = Readonly<{
  /** Opaque position in the content script's element list. */
  index: number;
  role: string | null;
  name: string;
  /** Fully resolved href for anchors, otherwise null. */
  href: string | null;
  visible: boolean;
  disabled: boolean;
}>;

export type MatchFailure =
  | "UNSUPPORTED_ORIGIN"
  | "WRONG_PAGE"
  | "NOT_FOUND"
  | "AMBIGUOUS";

export type MatchResult =
  | Readonly<{ ok: true; index: number }>
  | Readonly<{ ok: false; code: MatchFailure }>;

export function normalizeName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function matchTarget(
  spec: HighlightSpec,
  currentUrl: string,
  candidates: readonly Candidate[],
): MatchResult {
  const current = normalizeHttpUrl(stripHash(currentUrl));
  if (current === undefined || new URL(current).origin !== spec.trustedOrigin) {
    return { ok: false, code: "UNSUPPORTED_ORIGIN" };
  }
  if (current !== spec.sourcePageUrl) return { ok: false, code: "WRONG_PAGE" };

  const expectedName = normalizeName(spec.accessibleName);
  const matches = candidates.filter((candidate) => {
    if (!candidate.visible || candidate.disabled) return false;
    if (spec.role !== undefined && candidate.role !== spec.role) return false;
    if (normalizeName(candidate.name) !== expectedName) return false;
    if (spec.mode === "navigation") {
      if (candidate.href === null) return false;
      return normalizeHttpUrl(candidate.href) === spec.expectedHref;
    }
    return true;
  });
  if (matches.length === 0) return { ok: false, code: "NOT_FOUND" };
  const [only] = matches;
  if (matches.length > 1 || only === undefined) return { ok: false, code: "AMBIGUOUS" };
  return { ok: true, index: only.index };
}

function stripHash(value: string): string {
  const position = value.indexOf("#");
  return position === -1 ? value : value.slice(0, position);
}
