import { z } from "zod";

import { FIXTURE_ENVELOPES } from "./generated/fixtureEnvelopes.js";
import {
  TRUSTED_ORIGINS,
  assessSession,
  buildView,
  checkEnvelope,
  isReplay,
  normalizeHttpUrl,
  resolveOpen,
  resolveShow,
  type GuidanceView,
  type SessionAssessment,
  type StoredSession,
} from "./guidance.js";
import {
  PanelCommandSchema,
  type ActionOutcome,
  type ContentResult,
  type PanelCommand,
  type PanelResponse,
} from "./messages.js";

/**
 * Service worker. It is the only place that stores the guidance session and the
 * only place that decides whether navigation or highlighting may happen. The
 * side panel can name a step index; it can never supply a URL or a selector.
 */

const SESSION_KEY = "slayerSession";
const HIGHEST_KEY = "slayerHighestSequence";
const HIGHLIGHT_TAB_KEY = "slayerHighlightTab";
const PANEL_PAGE = "sidepanel.html";

const StoredSessionSchema = z
  .object({
    envelope: z.unknown(),
    acceptedAtMs: z.number(),
    invalidated: z.boolean(),
    doneSteps: z.array(z.number().int().positive()),
  })
  .strict();
const HighestSchema = z.record(z.string(), z.number().int().nonnegative());

type Loaded = Readonly<{
  stored: StoredSession | undefined;
  highest: Readonly<Record<string, number>>;
}>;

async function load(): Promise<Loaded> {
  const raw = await chrome.storage.session.get([SESSION_KEY, HIGHEST_KEY]);
  const stored = StoredSessionSchema.safeParse(raw[SESSION_KEY]);
  const highest = HighestSchema.safeParse(raw[HIGHEST_KEY]);
  return {
    stored: stored.success ? stored.data : undefined,
    highest: highest.success ? highest.data : {},
  };
}

async function saveSession(session: StoredSession | undefined, highest: Readonly<Record<string, number>>) {
  if (session === undefined) await chrome.storage.session.remove(SESSION_KEY);
  else await chrome.storage.session.set({ [SESSION_KEY]: session });
  await chrome.storage.session.set({ [HIGHEST_KEY]: highest });
}

async function assess(loaded: Loaded): Promise<SessionAssessment> {
  return assessSession(loaded.stored, loaded.highest, Date.now(), TRUSTED_ORIGINS);
}

// --- tabs -------------------------------------------------------------------

async function findPortalTab(origin: string): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  const usable = tabs.filter((tab) => tab.id !== undefined && tab.url !== undefined);
  return (
    usable.find((tab) => tab.active === true) ??
    [...usable].sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0]
  );
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);
    function listener(updatedId: number, change: { status?: string }): void {
      if (updatedId !== tabId || change.status !== "complete") return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(true);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendToContent(tabId: number, message: unknown): Promise<ContentResult | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = (await chrome.tabs.sendMessage(tabId, message)) as ContentResult | undefined;
      if (result !== undefined) return result;
    } catch {
      // Content script not ready yet (page still loading); retry briefly, never loop unbounded.
    }
    await delay(200);
  }
  return undefined;
}

async function clearHighlights(): Promise<void> {
  const raw = await chrome.storage.session.get(HIGHLIGHT_TAB_KEY);
  const tabId = raw[HIGHLIGHT_TAB_KEY];
  if (typeof tabId === "number") {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "CLEAR" });
    } catch {
      // Tab gone or navigated; its highlight is already gone.
    }
  }
  await chrome.storage.session.remove(HIGHLIGHT_TAB_KEY);
}

// --- command handling ---------------------------------------------------------

function fixtureList(): PanelResponse["fixtures"] {
  return FIXTURE_ENVELOPES.map((fixture) => ({ id: fixture.id, label: fixture.label }));
}

async function respond(outcome: ActionOutcome, detail?: string): Promise<PanelResponse> {
  const loaded = await load();
  const assessment = await assess(loaded);
  // A highlight must never outlive authoritative guidance.
  if (assessment.kind !== "authoritative") await clearHighlights();
  const view: GuidanceView = buildView(assessment);
  return { view, fixtures: fixtureList(), outcome, ...(detail === undefined ? {} : { detail }) };
}

async function loadFixture(fixtureId: string): Promise<PanelResponse> {
  const fixture = FIXTURE_ENVELOPES.find((candidate) => candidate.id === fixtureId);
  if (fixture === undefined) return respond("rejected_fixture", "UNKNOWN_FIXTURE");
  const check = await checkEnvelope(fixture.envelope, TRUSTED_ORIGINS);
  if (!check.ok) return respond("rejected_fixture", check.code);
  const loaded = await load();
  if (isReplay(check.envelope, loaded.highest)) return respond("rejected_fixture", "REPLAYED_SEQUENCE");
  await clearHighlights();
  await saveSession(
    { envelope: fixture.envelope, acceptedAtMs: Date.now(), invalidated: false, doneSteps: [] },
    { ...loaded.highest, [check.envelope.sessionId]: check.envelope.sequence },
  );
  return respond("none");
}

async function openStep(index: number): Promise<PanelResponse> {
  const assessment = await assess(await load());
  const resolved = resolveOpen(assessment, index);
  if (!resolved.ok || assessment.kind !== "authoritative") return respond("denied", resolved.ok ? undefined : resolved.code);
  await clearHighlights();
  const portal = await findPortalTab(assessment.envelope.trustedOrigin);
  if (portal?.id === undefined) await chrome.tabs.create({ url: resolved.url, active: true });
  else await chrome.tabs.update(portal.id, { url: resolved.url, active: true });
  return respond("opened");
}

async function showStep(index: number): Promise<PanelResponse> {
  const assessment = await assess(await load());
  const resolved = resolveShow(assessment, index);
  if (!resolved.ok || assessment.kind !== "authoritative") return respond("denied", resolved.ok ? undefined : resolved.code);
  await clearHighlights();

  let portal = await findPortalTab(assessment.envelope.trustedOrigin);
  if (portal?.id === undefined) {
    portal = await chrome.tabs.create({ url: resolved.sourcePageUrl, active: true });
    if (portal.id !== undefined) await waitForTabComplete(portal.id, 8000);
  } else if (normalizeHttpUrl(stripHash(portal.url ?? "")) !== resolved.sourcePageUrl) {
    const loading = waitForTabComplete(portal.id, 8000);
    await chrome.tabs.update(portal.id, { url: resolved.sourcePageUrl, active: true });
    await loading;
  }
  const tabId = portal.id;
  if (tabId === undefined) return respond("find_manually", "NO_TAB");

  // Re-assess after the (possibly slow) navigation: guidance may have gone stale meanwhile.
  const again = await assess(await load());
  if (resolveShow(again, index).ok !== true) return respond("denied", "NOT_AUTHORITATIVE");

  const result = await sendToContent(tabId, { type: "HIGHLIGHT", spec: stripUndefined(resolved.spec) });
  if (result?.ok === true) {
    await chrome.storage.session.set({ [HIGHLIGHT_TAB_KEY]: tabId });
    return respond("highlighted");
  }
  return respond("find_manually", result?.code ?? "NO_RESPONSE");
}

function stripUndefined<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined));
}

function stripHash(value: string): string {
  const position = value.indexOf("#");
  return position === -1 ? value : value.slice(0, position);
}

async function markDone(index: number, done: boolean): Promise<PanelResponse> {
  const loaded = await load();
  const assessment = await assess(loaded);
  if (assessment.kind === "authoritative" && loaded.stored !== undefined) {
    const doneSteps = new Set(loaded.stored.doneSteps);
    if (done) doneSteps.add(index);
    else doneSteps.delete(index);
    await saveSession({ ...loaded.stored, doneSteps: [...doneSteps].sort((a, b) => a - b) }, loaded.highest);
  }
  return respond("none");
}

async function handle(command: PanelCommand): Promise<PanelResponse> {
  switch (command.type) {
    case "GET_VIEW":
      return respond("none");
    case "LOAD_FIXTURE":
      return loadFixture(command.fixtureId);
    case "INVALIDATE": {
      const loaded = await load();
      await clearHighlights();
      if (loaded.stored !== undefined) await saveSession({ ...loaded.stored, invalidated: true }, loaded.highest);
      return respond("none");
    }
    case "RESET":
      await clearHighlights();
      await saveSession(undefined, {});
      return respond("none");
    case "OPEN_STEP":
      return openStep(command.index);
    case "SHOW_STEP":
      return showStep(command.index);
    case "MARK_DONE":
      return markDone(command.index, command.done);
    case "CLEAR_HIGHLIGHT":
      await clearHighlights();
      return respond("none");
  }
}

function isFromSidePanel(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL(PANEL_PAGE);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Page content scripts (and anything else) can never command the background.
  if (!isFromSidePanel(sender)) return false;
  const parsed = PanelCommandSchema.safeParse(message);
  if (!parsed.success) {
    void respond("denied", "BAD_COMMAND").then(sendResponse);
    return true;
  }
  handle(parsed.data).then(sendResponse, () => {
    void respond("denied", "INTERNAL_ERROR").then(sendResponse);
  });
  return true;
});

// Any in-tab navigation invalidates the visual highlight.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "loading" && change.url === undefined) return;
  void chrome.storage.session.get(HIGHLIGHT_TAB_KEY).then((raw) => {
    if (raw[HIGHLIGHT_TAB_KEY] === tabId) return chrome.storage.session.remove(HIGHLIGHT_TAB_KEY);
    return undefined;
  });
});

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
