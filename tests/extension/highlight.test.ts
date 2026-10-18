import { describe, expect, it } from "vitest";

import type { HighlightSpec } from "../../extension/src/guidance.js";
import { matchTarget, type Candidate } from "../../extension/src/highlight.js";

const ORIGIN = "http://127.0.0.1:5180";

const linkSpec: HighlightSpec = {
  trustedOrigin: ORIGIN,
  sourcePageUrl: `${ORIGIN}/dashboard`,
  mode: "navigation",
  role: "link",
  accessibleName: "View details for Transfer to Alex Morgan",
  actionKind: "link",
  expectedHref: `${ORIGIN}/transfers/tx-001`,
};

const cancelSpec: HighlightSpec = {
  trustedOrigin: ORIGIN,
  sourcePageUrl: `${ORIGIN}/transfers/tx-001`,
  mode: "state_changing",
  role: "button",
  accessibleName: "Cancel transfer",
  actionKind: "button",
  expectedHref: undefined,
};

function candidate(index: number, overrides: Partial<Candidate> = {}): Candidate {
  return { index, role: "link", name: "View details for Transfer to Alex Morgan", href: `${ORIGIN}/transfers/tx-001`, visible: true, disabled: false, ...overrides };
}

describe("matchTarget", () => {
  it("highlights exactly one grounded match", () => {
    const result = matchTarget(linkSpec, `${ORIGIN}/dashboard`, [candidate(0, { name: "Dashboard", href: `${ORIGIN}/dashboard` }), candidate(1)]);
    expect(result).toEqual({ ok: true, index: 1 });
  });

  it("refuses ambiguous matches instead of guessing", () => {
    expect(matchTarget(linkSpec, `${ORIGIN}/dashboard`, [candidate(0), candidate(1)])).toEqual({ ok: false, code: "AMBIGUOUS" });
  });

  it("reports not-found when the name or destination differs", () => {
    expect(matchTarget(linkSpec, `${ORIGIN}/dashboard`, [candidate(0, { name: "Something else" })])).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(matchTarget(linkSpec, `${ORIGIN}/dashboard`, [candidate(0, { href: `${ORIGIN}/transfers/tx-002` })])).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(matchTarget(linkSpec, `${ORIGIN}/dashboard`, [candidate(0, { href: "javascript:alert(1)" })])).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("ignores hidden and disabled candidates", () => {
    expect(matchTarget(linkSpec, `${ORIGIN}/dashboard`, [candidate(0, { visible: false })])).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(matchTarget(linkSpec, `${ORIGIN}/dashboard`, [candidate(0, { disabled: true })])).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("requires the exact observed page and trusted origin", () => {
    expect(matchTarget(linkSpec, `${ORIGIN}/support`, [candidate(0)])).toEqual({ ok: false, code: "WRONG_PAGE" });
    expect(matchTarget(linkSpec, "http://evil.example/dashboard", [candidate(0)])).toEqual({ ok: false, code: "UNSUPPORTED_ORIGIN" });
    expect(matchTarget(linkSpec, "javascript:void(0)", [candidate(0)])).toEqual({ ok: false, code: "UNSUPPORTED_ORIGIN" });
  });

  it("ignores a URL fragment on the current page", () => {
    expect(matchTarget(linkSpec, `${ORIGIN}/dashboard#top`, [candidate(0)])).toEqual({ ok: true, index: 0 });
  });

  it("matches a state-changing button by role and visible name, never by href", () => {
    const button: Candidate = { index: 0, role: "button", name: " Cancel   transfer ", href: null, visible: true, disabled: false };
    expect(matchTarget(cancelSpec, `${ORIGIN}/transfers/tx-001`, [button])).toEqual({ ok: true, index: 0 });
    const lookalike: Candidate = { ...button, index: 1, role: "link" };
    expect(matchTarget(cancelSpec, `${ORIGIN}/transfers/tx-001`, [lookalike])).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(matchTarget(cancelSpec, `${ORIGIN}/transfers/tx-001`, [button, { ...button, index: 2 }])).toEqual({ ok: false, code: "AMBIGUOUS" });
  });
});
