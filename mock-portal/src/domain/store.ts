// Client-side "backend" for the simulation.
//
// - Persisted state lives in localStorage (falls back to memory if storage is unavailable).
// - The React UI renders from a cached copy loaded at page load, exactly like a real page would.
//   Other tabs can change the persisted state; this tab does not notice until it reloads or acts.
// - Every mutation re-reads the persisted state first, so rules are always applied to current
//   state, not to what the page last displayed (policy P7).

import { useSyncExternalStore } from "react";
import { BASE_NOW_MS, DEFAULT_SCENARIO_ID } from "./scenarios";
import { isScenarioId } from "./types";
import type { PortalState, ScenarioId, SupportCase } from "./types";

const STORAGE_KEY = "northstar-mock-bank:state:v1";

let memoryFallback: string | null = null;
let cached: PortalState | null = null;
const listeners = new Set<() => void>();

function seed(scenarioId: ScenarioId): PortalState {
  return { schemaVersion: 1, scenarioId, nowMs: BASE_NOW_MS, canceledAtMs: {}, cases: [] };
}

function readRaw(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return memoryFallback;
  }
}

function writeRaw(raw: string): void {
  memoryFallback = raw;
  try {
    window.localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // Storage unavailable (for example blocked in a private context): memory fallback is enough.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCase(value: unknown): SupportCase | null {
  if (!isRecord(value)) return null;
  const { id, kind, transferId, createdAtMs, handling } = value;
  if (typeof id !== "string" || typeof transferId !== "string" || typeof createdAtMs !== "number") return null;
  if (kind !== "payment_recovery" && kind !== "mistaken_transfer" && kind !== "unauthorized_transfer") return null;
  if (handling !== "review" && handling !== "outreach_only") return null;
  return { id, kind, transferId, createdAtMs, handling };
}

/** Parses persisted JSON. Anything malformed returns null so the caller reseeds. */
function parsePersisted(raw: string | null): PortalState | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data["schemaVersion"] !== 1) return null;
  const { scenarioId, nowMs, canceledAtMs, cases } = data;
  if (!isScenarioId(scenarioId) || typeof nowMs !== "number" || !Number.isFinite(nowMs)) return null;
  if (!isRecord(canceledAtMs) || !Array.isArray(cases)) return null;

  const canceled: Record<string, number> = {};
  for (const [key, value] of Object.entries(canceledAtMs)) {
    if (typeof value !== "number") return null;
    canceled[key] = value;
  }
  const parsedCases: SupportCase[] = [];
  for (const entry of cases) {
    const parsed = parseCase(entry);
    if (parsed === null) return null;
    parsedCases.push(parsed);
  }
  return { schemaVersion: 1, scenarioId, nowMs, canceledAtMs: canceled, cases: parsedCases };
}

function loadFresh(): PortalState {
  return parsePersisted(readRaw()) ?? seed(DEFAULT_SCENARIO_ID);
}

function persist(state: PortalState): void {
  writeRaw(JSON.stringify(state));
}

function publish(state: PortalState): void {
  cached = state;
  for (const listener of listeners) listener();
}

/**
 * Call once before rendering. A `?scenario=<id>` query parameter (re)seeds that scenario and is then
 * removed from the address bar so recorded page URLs stay clean.
 */
export function initPortal(): void {
  const url = new URL(window.location.href);
  const requested = url.searchParams.get("scenario");
  if (requested !== null) {
    if (isScenarioId(requested)) {
      const state = seed(requested);
      persist(state);
      cached = state;
    } else {
      cached = loadFresh();
    }
    url.searchParams.delete("scenario");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    return;
  }
  const existing = parsePersisted(readRaw());
  cached = existing ?? seed(DEFAULT_SCENARIO_ID);
  if (existing === null) persist(cached);
}

export function getCachedState(): PortalState {
  if (cached === null) {
    cached = loadFresh();
  }
  return cached;
}

export function usePortalState(): PortalState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getCachedState,
    getCachedState,
  );
}

/**
 * Applies `action` to the freshly persisted state, saves any change, and refreshes this tab's view.
 * `nextState` extracts the new state from the result, or returns null when nothing changed.
 * Returns the action's result so callers can show the outcome.
 */
export function mutate<T>(
  action: (current: PortalState) => T,
  nextState: (result: T) => PortalState | null,
): T {
  const current = loadFresh();
  const result = action(current);
  const next = nextState(result) ?? current;
  persist(next);
  publish(next);
  return result;
}

/** Test-harness control: replace everything with a freshly seeded scenario. */
export function resetScenario(scenarioId: ScenarioId): void {
  const state = seed(scenarioId);
  persist(state);
  publish(state);
}

/** Reload this tab's view from persisted state (what pressing refresh would do). */
export function refreshView(): void {
  publish(loadFresh());
}
