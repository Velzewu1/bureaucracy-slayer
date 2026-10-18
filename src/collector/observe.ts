import type { Page } from "playwright";

import { DomObservationSchema, type DomObservation } from "./snapshot.js";

// Kept as browser-side JavaScript because the root Node project intentionally does not
// include DOM globals. The returned untrusted browser value is parsed immediately below.
const OBSERVE_DOM_SCRIPT = String.raw`(() => {
  const normalize = (value) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const visible = (element) => {
    if (!(element instanceof HTMLElement) || element.hidden || element.closest('[aria-hidden="true"]') !== null) {
      return false;
    }
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const cssPath = (element) => {
    if (element.id !== "") return "#" + CSS.escape(element.id);
    const parts = [];
    let current = element;
    while (current !== null && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent === null) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === current.tagName);
      const position = siblings.indexOf(current) + 1;
      parts.unshift(tag + ":nth-of-type(" + String(position) + ")");
      current = parent;
    }
    return "html > " + parts.join(" > ");
  };
  const labelledByText = (element) => {
    const ids = (element.getAttribute("aria-labelledby") || "").split(/\s+/u).filter(Boolean);
    return normalize(ids.map((id) => {
      const source = document.getElementById(id);
      return source === null ? "" : source.textContent || "";
    }).join(" "));
  };
  const associatedLabel = (element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
      return "";
    }
    return normalize(Array.from(element.labels || []).map((label) => label.textContent || "").join(" "));
  };
  const accessibleLabel = (element) => {
    const ariaLabel = normalize(element.getAttribute("aria-label") || "");
    if (ariaLabel !== "") return ariaLabel;
    const labelledBy = labelledByText(element);
    if (labelledBy !== "") return labelledBy;
    const label = associatedLabel(element);
    if (label !== "") return label;
    const text = normalize(element.textContent || "");
    if (text !== "") return text;
    return normalize(element.getAttribute("placeholder") || element.getAttribute("name") || "");
  };
  const locatorCandidates = (element, role, name) => {
    const locators = [];
    const testId = normalize(element.getAttribute("data-testid") || "");
    if (testId !== "") locators.push({ strategy: "testId", value: testId });
    if (role !== "" && name !== "") locators.push({ strategy: "role", role, name });
    locators.push({ strategy: "css", value: cssPath(element) });
    return locators;
  };
  const controlRole = (element) => {
    if (element instanceof HTMLSelectElement) return element.multiple ? "listbox" : "combobox";
    if (element instanceof HTMLTextAreaElement) return "textbox";
    if (!(element instanceof HTMLInputElement)) return element.tagName.toLowerCase();
    if (element.type === "checkbox") return "checkbox";
    if (element.type === "radio") return "radio";
    if (element.type === "range") return "slider";
    if (element.type === "number") return "spinbutton";
    if (element.type === "search") return "searchbox";
    return "textbox";
  };
  const httpTarget = (rawValue) => {
    try {
      const url = new URL(rawValue, document.baseURI);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
        return undefined;
      }
      url.hash = "";
      url.searchParams.sort();
      return url.href;
    } catch {
      return undefined;
    }
  };
  const actions = [];
  for (const element of document.querySelectorAll("a[href],button,input,select,textarea")) {
    if (!visible(element)) continue;
    if (element instanceof HTMLInputElement && ["hidden", "password", "file"].includes(element.type)) continue;
    const label = accessibleLabel(element);
    if (label === "") continue;

    if (element instanceof HTMLAnchorElement) {
      const targetUrl = httpTarget(element.href);
      actions.push({
        kind: "link",
        label,
        ...(targetUrl === undefined ? {} : { targetUrl }),
        method: "GET",
        visible: true,
        enabled: element.getAttribute("aria-disabled") !== "true",
        reversible: targetUrl !== undefined && !element.hasAttribute("download"),
        locators: locatorCandidates(element, "link", label),
      });
      continue;
    }

    const isSubmit =
      (element instanceof HTMLButtonElement && element.type === "submit") ||
      (element instanceof HTMLInputElement && (element.type === "submit" || element.type === "image"));
    const disabled = ("disabled" in element && element.disabled === true) || element.getAttribute("aria-disabled") === "true";
    if (isSubmit) {
      const form = element.form;
      const methodValue = (form === null ? "get" : form.method).toUpperCase();
      const method = methodValue === "POST" ? "POST" : "GET";
      const targetUrl = httpTarget(form === null ? document.URL : form.action);
      actions.push({
        kind: "form_submit",
        label,
        ...(targetUrl === undefined ? {} : { targetUrl }),
        method,
        visible: true,
        enabled: !disabled,
        reversible: false,
        locators: locatorCandidates(element, "button", label),
      });
      continue;
    }

    const isButton = element instanceof HTMLButtonElement || (element instanceof HTMLInputElement && ["button", "reset"].includes(element.type));
    actions.push({
      kind: isButton ? "button" : "form_control",
      label,
      visible: true,
      enabled: !disabled,
      reversible: false,
      locators: locatorCandidates(element, isButton ? "button" : controlRole(element), label),
    });
  }

  const blocks = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,legend,caption"))
    .filter((element) => visible(element) && element.closest("nav,footer,script,style,noscript,template,form") === null)
    .map((element) => normalize(element.textContent || ""))
    .filter((text) => text !== "");
  const canonicalElement = document.querySelector('link[rel~="canonical"][href]');
  const canonicalHref = canonicalElement instanceof HTMLLinkElement ? canonicalElement.href : undefined;
  return {
    title: document.title,
    ...(canonicalHref === undefined ? {} : { canonicalHref }),
    blocks,
    actions,
  };
})()`;

export async function observeDom(page: Page): Promise<DomObservation> {
  const observation: unknown = await page.evaluate(OBSERVE_DOM_SCRIPT);
  return DomObservationSchema.parse(observation);
}
