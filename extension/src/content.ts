import { normalizeName, matchTarget, type Candidate } from "./highlight.js";
import { ContentCommandSchema, type ContentCommand, type ContentResult } from "./messages.js";

/**
 * Highlight-only content script, injected solely on the trusted Northstar origin.
 *
 * Invariants (enforced by tests/extension/package-safety.test.ts):
 * - It never clicks, submits, focuses, types into, or dispatches events on page elements.
 * - It only reads the DOM, scrolls, and adds a removable outline/badge.
 * - It acts only on messages from this extension's own runtime.
 */

const BADGE_ID = "slayer-guidance-badge";
const OUTLINE_ATTRIBUTE = "data-slayer-highlight";

type ActiveHighlight = {
  element: Element;
  href: string;
  previousOutline: string;
  previousOutlineOffset: string;
  badge: HTMLElement;
  timer: number;
};

let active: ActiveHighlight | undefined;

function implicitRole(element: Element): string | null {
  const explicit = element.getAttribute("role");
  if (explicit !== null && explicit !== "") return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return element.hasAttribute("href") ? "link" : null;
  if (tag === "button") return "button";
  if (tag === "select") return "combobox";
  if (tag === "textarea") return "textbox";
  if (tag === "input") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "reset") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "hidden") return null;
    return "textbox";
  }
  return null;
}

function accessibleName(element: Element): string {
  const aria = element.getAttribute("aria-label");
  if (aria !== null && aria.trim() !== "") return aria;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    if (text.trim() !== "") return text;
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    const labels = element.labels;
    if (labels !== null && labels.length > 0) return [...labels].map((label) => label.textContent ?? "").join(" ");
    if (element instanceof HTMLInputElement && (element.type === "submit" || element.type === "button")) return element.value;
  }
  return element.textContent ?? "";
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function describe(elements: readonly Element[]): Candidate[] {
  return elements.map((element, index) => ({
    index,
    role: implicitRole(element),
    name: normalizeName(accessibleName(element)),
    href: element instanceof HTMLAnchorElement ? element.href : null,
    visible: isVisible(element),
    disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
  }));
}

function clearHighlight(): void {
  if (active === undefined) return;
  window.clearInterval(active.timer);
  if (active.element instanceof HTMLElement) {
    active.element.style.outline = active.previousOutline;
    active.element.style.outlineOffset = active.previousOutlineOffset;
  }
  active.element.removeAttribute(OUTLINE_ATTRIBUTE);
  active.badge.remove();
  active = undefined;
}

function positionBadge(badge: HTMLElement, element: Element): void {
  const rect = element.getBoundingClientRect();
  badge.style.top = `${Math.max(4, rect.top - 28)}px`;
  badge.style.left = `${Math.max(4, rect.left)}px`;
}

function applyHighlight(element: Element, manualOnly: boolean): void {
  clearHighlight();
  const badge = document.createElement("div");
  badge.id = BADGE_ID;
  badge.textContent = manualOnly ? "Bureaucracy Slayer: do this yourself" : "Bureaucracy Slayer: this step";
  badge.setAttribute("style", [
    "position:fixed", "z-index:2147483647", "pointer-events:none", "font:600 12px/1 system-ui,sans-serif",
    "background:#f59e0b", "color:#111", "padding:6px 8px", "border-radius:4px", "box-shadow:0 1px 4px rgba(0,0,0,.35)",
  ].join(";"));
  document.documentElement.append(badge);

  const html = element as HTMLElement;
  const previousOutline = html.style.outline;
  const previousOutlineOffset = html.style.outlineOffset;
  html.style.outline = "3px solid #f59e0b";
  html.style.outlineOffset = "3px";
  element.setAttribute(OUTLINE_ATTRIBUTE, "true");
  element.scrollIntoView({ block: "center", inline: "nearest" });
  positionBadge(badge, element);

  const href = location.href;
  const timer = window.setInterval(() => {
    // Stale-highlight guard: SPA navigation or removed element clears it.
    if (active === undefined) return;
    if (location.href !== active.href || !active.element.isConnected) {
      clearHighlight();
      return;
    }
    positionBadge(active.badge, active.element);
  }, 250);
  active = { element, href, previousOutline, previousOutlineOffset, badge, timer };
}

function handleHighlight(command: Extract<ContentCommand, { type: "HIGHLIGHT" }>): ContentResult {
  const spec = { ...command.spec, role: command.spec.role, expectedHref: command.spec.expectedHref };
  const elements = [
    ...document.querySelectorAll("a[href], button, input, select, textarea, [role]"),
  ];
  const result = matchTarget(spec, location.href, describe(elements));
  if (!result.ok) {
    clearHighlight();
    return { ok: false, code: result.code };
  }
  const element = elements[result.index];
  if (element === undefined) return { ok: false, code: "NOT_FOUND" };
  applyHighlight(element, spec.mode === "state_changing");
  return { ok: true, code: "HIGHLIGHTED" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const parsed = ContentCommandSchema.safeParse(message);
  if (!parsed.success) {
    sendResponse({ ok: false, code: "BAD_COMMAND" } satisfies ContentResult);
    return false;
  }
  if (parsed.data.type === "CLEAR") {
    clearHighlight();
    sendResponse({ ok: true, code: "CLEARED" } satisfies ContentResult);
    return false;
  }
  sendResponse(handleHighlight(parsed.data));
  return false;
});

window.addEventListener("pagehide", clearHighlight);
