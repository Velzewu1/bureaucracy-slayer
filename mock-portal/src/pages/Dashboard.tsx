import { Link } from "react-router-dom";
import { Card, StatusBadge, linkClass, usePageTitle } from "../components/ui";
import { formatDate, formatMoney } from "../domain/format";
import { effectiveStatus, listTransfers } from "../domain/rules";
import { usePortalState } from "../domain/store";
import type { EffectiveStatus } from "../domain/types";

interface ActivityRow {
  readonly key: string;
  readonly dateMs: number;
  readonly description: string;
  readonly type: string;
  readonly status: EffectiveStatus;
  readonly amountCents: number;
  readonly detailsHref: string | null;
}

const HOUR = 60 * 60 * 1000;

export function Dashboard() {
  usePageTitle("Dashboard");
  const state = usePortalState();

  const transferRows: ActivityRow[] = listTransfers(state).map((transfer) => ({
    key: transfer.id,
    dateMs: transfer.createdAtMs,
    description: `Transfer to ${transfer.recipientName}`,
    type: transfer.methodDisclosed ? (transfer.method === "instant" ? "Instant transfer" : "Standard transfer") : "Transfer (type not shown)",
    status: effectiveStatus(transfer, state.nowMs),
    amountCents: -transfer.amountCents,
    detailsHref: `/transfers/${transfer.id}`,
  }));

  // Static background activity. These rows are not transfers and have no detail pages in this simulation.
  const otherRows: readonly ActivityRow[] = [
    { key: "act-1", dateMs: Date.parse("2026-10-15T16:20:00Z"), description: "Cedar Market", type: "Card purchase", status: "completed", amountCents: -6412, detailsHref: null },
    { key: "act-2", dateMs: Date.parse("2026-10-14T12:00:00Z"), description: "Brightwave LLC payroll", type: "Direct deposit", status: "completed", amountCents: 215000, detailsHref: null },
    { key: "act-3", dateMs: Date.parse("2026-10-13T13:45:00Z"), description: "Metro Transit", type: "Card purchase", status: "completed", amountCents: -3300, detailsHref: null },
    { key: "act-4", dateMs: Date.parse("2026-10-11T22:05:00Z") - 3 * HOUR, description: "Greenleaf Pharmacy", type: "Card purchase", status: "completed", amountCents: -2189, detailsHref: null },
  ];

  const rows = [...transferRows, ...otherRows].sort((a, b) => b.dateMs - a.dateMs);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-slate-600">Welcome back, Jamie Rivera.</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <h2 className="text-sm font-medium text-slate-500">Everyday Checking ending 3307</h2>
          <p className="mt-1 text-3xl font-semibold text-slate-900">$4,218.62</p>
          <p className="text-sm text-slate-500">Available balance</p>
        </Card>
        <Card>
          <h2 className="text-sm font-medium text-slate-500">Rainy Day Savings ending 9910</h2>
          <p className="mt-1 text-3xl font-semibold text-slate-900">$12,075.00</p>
          <p className="text-sm text-slate-500">Available balance</p>
        </Card>
      </div>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Sent money by mistake?</h2>
        <p className="mt-1 text-sm text-slate-600">
          What you can do depends on the type and status of the transfer. Open the transfer to see your options, or read
          how <Link className={linkClass} to="/help/transfers">canceling a transfer</Link> works. You can also{" "}
          <Link className={linkClass} to="/support">contact support</Link>.
        </p>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Recent activity</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <caption className="sr-only">Recent account activity</caption>
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th scope="col" className="py-2 pr-3 font-medium">Date</th>
                <th scope="col" className="py-2 pr-3 font-medium">Description</th>
                <th scope="col" className="py-2 pr-3 font-medium">Type</th>
                <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Amount</th>
                <th scope="col" className="py-2 font-medium"><span className="sr-only">Details</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-b border-slate-100 last:border-0" data-testid={`activity-${row.key}`}>
                  <td className="py-3 pr-3 whitespace-nowrap">{formatDate(row.dateMs)}</td>
                  <td className="py-3 pr-3 font-medium text-slate-900">{row.description}</td>
                  <td className="py-3 pr-3">{row.type}</td>
                  <td className="py-3 pr-3"><StatusBadge status={row.status} /></td>
                  <td className={`py-3 pr-3 text-right tabular-nums ${row.amountCents > 0 ? "text-emerald-700" : ""}`}>
                    {row.amountCents > 0 ? "+" : "-"}
                    {formatMoney(Math.abs(row.amountCents))}
                  </td>
                  <td className="py-3 text-right">
                    {row.detailsHref === null ? null : (
                      <Link className={linkClass} to={row.detailsHref} aria-label={`View details for ${row.description}`}>
                        View details
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
