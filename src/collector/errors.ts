export const CollectorErrorCode = {
  browserLaunchFailed: "BROWSER_LAUNCH_FAILED",
  invalidOptions: "INVALID_OPTIONS",
  invalidStartUrl: "INVALID_START_URL",
  navigationFailed: "NAVIGATION_FAILED",
  navigationTimeout: "NAVIGATION_TIMEOUT",
  originDisallowed: "ORIGIN_DISALLOWED",
  pageUnavailable: "PAGE_UNAVAILABLE",
  redirectDisallowed: "REDIRECT_DISALLOWED",
  snapshotSchemaInvalid: "SNAPSHOT_SCHEMA_INVALID",
  unsafeRequestBlocked: "UNSAFE_REQUEST_BLOCKED",
} as const;

export type CollectorErrorCode = (typeof CollectorErrorCode)[keyof typeof CollectorErrorCode];

export class CollectorError extends Error {
  readonly code: CollectorErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: CollectorErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "CollectorError";
    this.code = code;
    this.details = details;
  }
}
