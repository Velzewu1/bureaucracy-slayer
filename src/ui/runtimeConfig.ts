import type { DemoMode } from "./types.js";

export type UiExecutionPolicy =
  | "live"
  | "offline_mock"
  | "recorded_replay"
  | "verified_fixture";

declare const __BUREAUCRACY_SLAYER_EXECUTION_POLICY__: UiExecutionPolicy;

export const UI_EXECUTION_POLICY: UiExecutionPolicy =
  typeof __BUREAUCRACY_SLAYER_EXECUTION_POLICY__ === "undefined"
    ? "live"
    : __BUREAUCRACY_SLAYER_EXECUTION_POLICY__;

export function uiModeForExecutionPolicy(policy: UiExecutionPolicy): DemoMode {
  switch (policy) {
    case "live":
    case "offline_mock":
      return "live_sonnet";
    case "recorded_replay":
      return "recorded_sonnet";
    case "verified_fixture":
      return "verified_fixture";
  }
}
