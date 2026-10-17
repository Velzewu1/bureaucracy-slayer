type AppHeaderProps = Readonly<{
  portalName: string;
  modeLabel: string;
  analyzeLabel: string;
  reanalyzeLabel: string;
  busyLabel: string;
  isBusy: boolean;
  hasAnalysis: boolean;
  onAnalyze: () => void;
}>;

export function AppHeader({
  portalName,
  modeLabel,
  analyzeLabel,
  reanalyzeLabel,
  busyLabel,
  isBusy,
  hasAnalysis,
  onAnalyze,
}: AppHeaderProps) {
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          BS
        </div>
        <div>
          <a className="brand-name" href="#top" aria-label="Bureaucracy Slayer home">
            Bureaucracy Slayer
          </a>
          <p className="brand-tagline">Evidence-first action planning</p>
        </div>
      </div>

      <div className="header-actions">
        <div className="portal-identity" aria-label={`Selected portal: ${portalName}`}>
          <span className="connection-dot" aria-hidden="true" />
          <span>
            <span className="eyebrow">Selected website</span>
            <strong>{portalName}</strong>
          </span>
        </div>
        <span className="mode-pill">
          <span className="mode-pill__dot" aria-hidden="true" />
          {modeLabel}
        </span>
        <button className="button button--primary" type="button" onClick={onAnalyze} disabled={isBusy}>
          {isBusy ? (
            <>
              <span className="spinner" aria-hidden="true" />
              {busyLabel}
            </>
          ) : hasAnalysis ? (
            reanalyzeLabel
          ) : (
            analyzeLabel
          )}
        </button>
      </div>
    </header>
  );
}
