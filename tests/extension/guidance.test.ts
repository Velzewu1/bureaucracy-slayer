import { describe, expect, it } from "vitest";

import {
  GuidanceEnvelopeBodySchema,
  sealEnvelope,
  type GuidanceEnvelope,
  type GuidanceEnvelopeBody,
} from "../../extension/src/envelope.js";
import {
  assessSession,
  buildView,
  checkEnvelope,
  classifyTarget,
  isReplay,
  normalizeHttpUrl,
  resolveOpen,
  resolveShow,
  viewFingerprint,
  type StoredSession,
} from "../../extension/src/guidance.js";
import { PanelCommandSchema } from "../../extension/src/messages.js";
import { FIXTURE_ENVELOPES } from "../../extension/src/generated/fixtureEnvelopes.js";

const ORIGIN = "http://127.0.0.1:5180";

function fixture(id: string): GuidanceEnvelope {
  const found = FIXTURE_ENVELOPES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing fixture ${id}`);
  return found.envelope as GuidanceEnvelope;
}

function body(envelope: GuidanceEnvelope): GuidanceEnvelopeBody {
  const { integrity: _integrity, ...rest } = envelope;
  return rest;
}

async function reseal(envelope: GuidanceEnvelope, change: (draft: GuidanceEnvelopeBody) => GuidanceEnvelopeBody) {
  return sealEnvelope(change(structuredClone(body(envelope))));
}

function session(envelope: unknown, overrides: Partial<StoredSession> = {}): StoredSession {
  return { envelope, acceptedAtMs: 1_000, invalidated: false, doneSteps: [], ...overrides };
}

async function authoritative(envelope: unknown, nowMs = 2_000) {
  return assessSession(session(envelope), {}, nowMs);
}

describe("fixture envelopes come from the deterministic pipeline", () => {
  it("covers ready, blocked, needs-information and two review-required outcomes", () => {
    const statuses = Object.fromEntries(FIXTURE_ENVELOPES.map((entry) => [entry.id, (entry.envelope as GuidanceEnvelope).planStatus]));
    expect(statuses).toEqual({
      "cancel-ready": "ready",
      "cancel-facts-changed": "blocked",
      "needs-information": "needs_information",
      "missing-evidence": "review_required",
      "review-required-recorded": "review_required",
    });
  });

  it("only a ready plan carries steps, and every step is cited", () => {
    for (const entry of FIXTURE_ENVELOPES) {
      const envelope = entry.envelope as GuidanceEnvelope;
      if (envelope.planStatus === "ready") {
        expect(envelope.steps.length).toBeGreaterThan(0);
        for (const step of envelope.steps) expect(step.citationIds.length).toBeGreaterThan(0);
      } else {
        expect(envelope.steps).toEqual([]);
      }
    }
  });

  it("passes every trust check", async () => {
    for (const entry of FIXTURE_ENVELOPES) {
      expect((await checkEnvelope(entry.envelope)).ok).toBe(true);
    }
  });
});

describe("envelope trust checks fail closed", () => {
  it("rejects tampered content without a matching integrity value", async () => {
    const tampered = { ...fixture("cancel-ready"), goal: "Something else" };
    expect(await checkEnvelope(tampered)).toEqual({ ok: false, code: "INTEGRITY_MISMATCH" });
  });

  it("rejects a tampered navigation destination", async () => {
    const envelope = structuredClone(fixture("cancel-ready"));
    const step = envelope.steps[0];
    if (step?.target?.destinationUrl === undefined) throw new Error("fixture shape changed");
    step.target.destinationUrl = `${ORIGIN}/support`;
    expect(await checkEnvelope(envelope)).toEqual({ ok: false, code: "INTEGRITY_MISMATCH" });
  });

  it("rejects malformed and unknown-field data", async () => {
    expect(await checkEnvelope(null)).toEqual({ ok: false, code: "SCHEMA_INVALID" });
    expect(await checkEnvelope({ ...fixture("cancel-ready"), extra: true })).toEqual({ ok: false, code: "SCHEMA_INVALID" });
    expect(await checkEnvelope({ ...fixture("cancel-ready"), integrity: "abc" })).toEqual({ ok: false, code: "SCHEMA_INVALID" });
  });

  it("rejects a ready plan without steps and a non-ready plan with steps", () => {
    const ready = fixture("cancel-ready");
    expect(GuidanceEnvelopeBodySchema.safeParse({ ...body(ready), steps: [] }).success).toBe(true);
    return Promise.all([
      reseal(ready, (draft) => ({ ...draft, steps: [] })).then(
        () => expect.unreachable("sealed an empty ready plan"),
        () => undefined,
      ),
      reseal(ready, (draft) => ({ ...draft, planStatus: "review_required" })).then(
        () => expect.unreachable("sealed a review-required plan with steps"),
        () => undefined,
      ),
    ]);
  });

  it("rejects an unsupported origin even when correctly sealed", async () => {
    const other = await reseal(fixture("cancel-ready"), (draft) => ({
      ...draft,
      trustedOrigin: "http://evil.example",
      observedPages: draft.observedPages.map((page) => page.replace(ORIGIN, "http://evil.example")),
      citations: draft.citations.map((c) => ({ ...c, pageUrl: c.pageUrl.replace(ORIGIN, "http://evil.example") })),
      steps: draft.steps.map((step) => ({
        ...step,
        target:
          step.target === null
            ? null
            : {
                ...step.target,
                sourcePageUrl: step.target.sourcePageUrl.replace(ORIGIN, "http://evil.example"),
                ...(step.target.destinationUrl === undefined
                  ? {}
                  : { destinationUrl: step.target.destinationUrl.replace(ORIGIN, "http://evil.example") }),
              },
      })),
    }));
    expect(await checkEnvelope(other)).toEqual({ ok: false, code: "UNSUPPORTED_ORIGIN" });
  });

  it("rejects a destination that was never observed or is cross-origin", async () => {
    const make = (url: string) =>
      reseal(fixture("cancel-ready"), (draft) => ({
        ...draft,
        steps: draft.steps.map((step, position) =>
          position === 0 && step.target !== null ? { ...step, target: { ...step.target, destinationUrl: url } } : step,
        ),
      }));
    expect(await checkEnvelope(await make(`${ORIGIN}/invented-page`))).toEqual({ ok: false, code: "UNGROUNDED_TARGET" });
    expect(await checkEnvelope(await make("http://evil.example/transfers/tx-001"))).toEqual({ ok: false, code: "UNGROUNDED_TARGET" });
    expect(await checkEnvelope(await make(`${ORIGIN}/support#frag`))).toEqual({ ok: false, code: "UNGROUNDED_TARGET" });
  });

  it("refuses javascript:, data: and credentialed URLs at the schema boundary", async () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "http://user:pw@127.0.0.1:5180/support"]) {
      await expect(
        reseal(fixture("cancel-ready"), (draft) => ({
          ...draft,
          steps: draft.steps.map((step, position) =>
            position === 0 && step.target !== null ? { ...step, target: { ...step.target, destinationUrl: url } } : step,
          ),
        })),
      ).rejects.toThrow();
    }
    expect(normalizeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeHttpUrl("data:text/html,hi")).toBeUndefined();
    expect(normalizeHttpUrl(`${ORIGIN}/a#x`)).toBeUndefined();
  });
});

describe("session freshness", () => {
  it("is authoritative inside the window and expires after it", async () => {
    const envelope = fixture("cancel-ready");
    expect((await authoritative(envelope, 1_000 + envelope.validForMs - 1)).kind).toBe("authoritative");
    expect((await authoritative(envelope, 1_000 + envelope.validForMs)).kind).toBe("expired");
  });

  it("treats an acceptance time in the future as expired (clock tamper)", async () => {
    expect((await authoritative(fixture("cancel-ready"), 500)).kind).toBe("expired");
  });

  it("an invalidated session is never authoritative and offers no route", async () => {
    const assessment = await assessSession(session(fixture("cancel-ready"), { invalidated: true }), {}, 2_000);
    expect(assessment.kind).toBe("invalidated");
    const view = buildView(assessment);
    expect(view.navigable).toBe(false);
    expect(view.steps).toEqual([]);
    expect(view.goal).toBeUndefined();
    expect(resolveOpen(assessment, 1)).toEqual({ ok: false, code: "NOT_AUTHORITATIVE" });
    expect(resolveShow(assessment, 2)).toEqual({ ok: false, code: "NOT_AUTHORITATIVE" });
  });

  it("changed facts (a newer sequence) supersede the older route and block replays", async () => {
    const older = fixture("cancel-ready");
    const newer = fixture("cancel-facts-changed");
    expect(older.sessionId).toBe(newer.sessionId);
    expect(isReplay(older, { [newer.sessionId]: newer.sequence })).toBe(true);
    expect(isReplay(newer, { [older.sessionId]: older.sequence })).toBe(false);
    const stale = await assessSession(session(older), { [newer.sessionId]: newer.sequence }, 2_000);
    expect(stale.kind).toBe("superseded");
    expect(buildView(stale).steps).toEqual([]);
  });

  it("tampered stored data is rejected on read", async () => {
    const assessment = await assessSession(session({ ...fixture("cancel-ready"), planStatus: "ready", goal: "x" }), {}, 2_000);
    expect(assessment).toEqual({ kind: "rejected", code: "INTEGRITY_MISMATCH" });
    expect(buildView(assessment).navigable).toBe(false);
  });

  it("no session means no route", async () => {
    const view = buildView(await assessSession(undefined, {}, 2_000));
    expect(view.availability).toBe("none");
    expect(view.navigable).toBe(false);
  });
});

describe("route presentation", () => {
  it("shows the verified cancellation route with one navigation step and one manual step", async () => {
    const view = buildView(await authoritative(fixture("cancel-ready")));
    expect(view.availability).toBe("ready");
    expect(view.headline).toBe("Verified fixture route");
    expect(view.navigable).toBe(true);
    expect(view.nextStepIndex).toBe(1);
    const [open, cancel] = view.steps;
    expect(open).toMatchObject({ kind: "navigate", canOpen: true, canShow: true });
    expect(cancel).toMatchObject({ kind: "manual", canOpen: false, canShow: true });
    expect(cancel?.manualNote).toMatch(/yourself/);
    expect(cancel?.citations.length).toBeGreaterThan(0);
  });

  it("advances the next step as steps are marked done", async () => {
    const assessment = await assessSession(session(fixture("cancel-ready"), { doneSteps: [1] }), {}, 2_000);
    expect(buildView(assessment).nextStepIndex).toBe(2);
  });

  it.each(["cancel-facts-changed", "needs-information", "missing-evidence", "review-required-recorded"])(
    "%s has no steps, no next step and cannot be opened or shown",
    async (id) => {
      const assessment = await authoritative(fixture(id));
      const view = buildView(assessment);
      expect(view.navigable).toBe(false);
      expect(view.steps).toEqual([]);
      expect(view.nextStepIndex).toBeUndefined();
      expect(resolveOpen(assessment, 1)).toEqual({ ok: false, code: "PLAN_NOT_READY" });
      expect(resolveShow(assessment, 1)).toEqual({ ok: false, code: "PLAN_NOT_READY" });
    },
  );

  it("stale status is never navigable and never lists steps", async () => {
    const stale = await reseal(fixture("cancel-ready"), (draft) => ({ ...draft, planStatus: "stale", steps: [] }));
    const assessment = await authoritative(stale);
    const view = buildView(assessment);
    expect(view.availability).toBe("stale");
    expect(view.headline).toBe("Stale route");
    expect(view.navigable).toBe(false);
    expect(view.steps).toEqual([]);
    expect(resolveOpen(assessment, 1)).toEqual({ ok: false, code: "PLAN_NOT_READY" });
  });

  it("review-required text never reads as ready and keeps the warning", async () => {
    const view = buildView(await authoritative(fixture("review-required-recorded")));
    expect(view.availability).toBe("review_required");
    expect(view.headline).toBe("Human review required");
    expect(view.notices.length).toBeGreaterThan(0);
  });

  it("needs-information lists the missing detail by label, not by fact key", async () => {
    const view = buildView(await authoritative(fixture("needs-information")));
    expect(view.missingFactLabels).toEqual(["Payment method"]);
  });

  it("does not expose internal identifiers, hashes, fact keys or policy ids", async () => {
    for (const entry of FIXTURE_ENVELOPES) {
      const text = JSON.stringify(buildView(await authoritative(entry.envelope)));
      expect(text).not.toMatch(/rule_|plan_|proc_|action_|page_|block_|snapshot_|evidence_/);
      expect(text).not.toMatch(/[0-9a-f]{32,}/);
      expect(text).not.toMatch(/transfer_status|payment_method|processing_started/);
    }
  });

  it("contains no user fact values in the envelope", () => {
    for (const entry of FIXTURE_ENVELOPES) {
      const text = JSON.stringify(entry.envelope);
      expect(text).not.toMatch(/transfer_status|payment_method|processing_started|"facts"|apiKey|cookie|token/i);
    }
  });
});

describe("navigation and highlight resolution", () => {
  it("opens only the observed destination of a GET link", async () => {
    const assessment = await authoritative(fixture("cancel-ready"));
    expect(resolveOpen(assessment, 1)).toEqual({ ok: true, url: `${ORIGIN}/transfers/tx-001` });
  });

  it("never opens a state-changing control, even though it has a WebsiteAction identity", async () => {
    const assessment = await authoritative(fixture("cancel-ready"));
    expect(resolveOpen(assessment, 2)).toEqual({ ok: false, code: "NOT_NAVIGATION" });
  });

  it("can highlight the Cancel button but marks it manual-only", async () => {
    const assessment = await authoritative(fixture("cancel-ready"));
    const shown = resolveShow(assessment, 2);
    expect(shown.ok).toBe(true);
    if (shown.ok) {
      expect(shown.spec.mode).toBe("state_changing");
      expect(shown.spec.expectedHref).toBeUndefined();
      expect(shown.sourcePageUrl).toBe(`${ORIGIN}/transfers/tx-001`);
    }
  });

  it("rejects unknown step indexes", async () => {
    const assessment = await authoritative(fixture("cancel-ready"));
    expect(resolveOpen(assessment, 99)).toEqual({ ok: false, code: "NO_SUCH_STEP" });
  });

  it.each([
    { actionKind: "button", method: undefined, destinationUrl: undefined },
    { actionKind: "form_submit", method: "GET", destinationUrl: `${ORIGIN}/support` },
    { actionKind: "form_control", method: undefined, destinationUrl: undefined },
    { actionKind: "link", method: "POST", destinationUrl: `${ORIGIN}/support` },
    { actionKind: "link", method: "GET", destinationUrl: undefined },
  ] as const)("classifies %o as state-changing", ({ actionKind, method, destinationUrl }) => {
    expect(
      classifyTarget({
        websiteActionId: "action_x",
        actionKind,
        ...(method === undefined ? {} : { method }),
        label: "x",
        sourcePageUrl: `${ORIGIN}/dashboard`,
        ...(destinationUrl === undefined ? {} : { destinationUrl }),
        accessibleName: "x",
      }),
    ).toBe("state_changing");
  });

  it("panel commands cannot carry a URL or selector", () => {
    expect(PanelCommandSchema.safeParse({ type: "OPEN_STEP", index: 1 }).success).toBe(true);
    expect(PanelCommandSchema.safeParse({ type: "OPEN_STEP", index: 1, url: "http://evil.example" }).success).toBe(false);
    expect(PanelCommandSchema.safeParse({ type: "SHOW_STEP", index: 1, selector: "button" }).success).toBe(false);
  });

  it("a ticking freshness clock does not change the rendered view identity", async () => {
    const view = buildView(await authoritative(fixture("cancel-ready"), 2_000));
    const later = { ...view, remainingMs: (view.remainingMs ?? 0) - 1 };
    expect(viewFingerprint(view)).toBe(viewFingerprint(later));
  });

  it("a step without a target is manual-only", async () => {
    const withUserTask = await reseal(fixture("cancel-ready"), (draft) => ({
      ...draft,
      steps: draft.steps.map((step, position) => (position === 0 ? { ...step, target: null } : step)),
    }));
    const assessment = await authoritative(withUserTask);
    expect(resolveOpen(assessment, 1)).toEqual({ ok: false, code: "NO_TARGET" });
    expect(resolveShow(assessment, 1)).toEqual({ ok: false, code: "NO_TARGET" });
    expect(buildView(assessment).steps[0]).toMatchObject({ kind: "manual", canOpen: false, canShow: false });
  });
});
