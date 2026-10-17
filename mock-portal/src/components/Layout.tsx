import { NavLink, Outlet } from "react-router-dom";
import { formatDateTime } from "../domain/format";
import { usePortalState } from "../domain/store";

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/help", label: "Help" },
  { to: "/support", label: "Support" },
] as const;

function navClass({ isActive }: { readonly isActive: boolean }): string {
  return `rounded-md px-3 py-2 text-sm font-medium ${
    isActive ? "bg-white/15 text-white" : "text-slate-200 hover:bg-white/10 hover:text-white"
  }`;
}

export function Layout() {
  const state = usePortalState();

  return (
    <div className="flex min-h-screen flex-col">
      <div role="note" className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">
        <strong>Simulated environment.</strong> Northstar Mock Bank is a fictional bank built for software testing. It
        is not a real financial institution. No real money moves here; do not enter real personal or banking
        information.
      </div>

      <header className="bg-slate-900">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <NavLink to="/dashboard" className="flex items-center gap-2 text-white" aria-label="Northstar Mock Bank home">
            <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true" className="text-teal-300">
              <path fill="currentColor" d="m12 2 2.6 7.4H22l-6 4.6 2.3 7.4L12 16.9 5.7 21.4 8 14 2 9.4h7.4z" />
            </svg>
            <span className="text-lg font-semibold tracking-tight">Northstar Mock Bank</span>
          </NavLink>
          <nav aria-label="Primary" className="flex gap-1">
            {NAV_ITEMS.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === "/help"} className={navClass}>
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <Outlet />
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl space-y-1 px-4 py-6 text-sm text-slate-600">
          <p>
            Northstar Mock Bank is a simulation for software testing only. It is not a bank, is not insured, and does
            not hold real money.
          </p>
          <p>Portal time: {formatDateTime(state.nowMs)}</p>
        </div>
      </footer>
    </div>
  );
}
