import { Link } from "react-router-dom";
import { Card, linkClass, usePageTitle } from "../components/ui";

const ARTICLES = [
  { to: "/help/transfers", title: "Canceling a transfer", blurb: "When a scheduled transfer can be canceled and how we check it." },
  { to: "/help/instant-transfers", title: "Instant transfers", blurb: "How instant transfers work and the rules that are specific to them." },
  { to: "/help/recovery", title: "Recovering a completed transfer", blurb: "What to do when money has already been delivered, including what you'll need." },
  { to: "/help/unauthorized-transfers", title: "Unauthorized transfers", blurb: "What to do if you didn't start a transfer." },
  { to: "/help/faq", title: "Frequently asked questions", blurb: "Quick answers to common questions about transfers." },
] as const;

export function HelpIndex() {
  usePageTitle("Help center");
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Help center</h1>
        <p className="text-slate-600">Guides for sending, canceling and recovering transfers.</p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2">
        {ARTICLES.map((article) => (
          <li key={article.to}>
            <Card className="h-full">
              <h2 className="text-lg font-semibold">
                <Link className={linkClass} to={article.to}>{article.title}</Link>
              </h2>
              <p className="mt-1 text-sm text-slate-600">{article.blurb}</p>
            </Card>
          </li>
        ))}
      </ul>
      <p className="text-sm text-slate-600">
        Can't find what you need? <Link className={linkClass} to="/support">Contact support</Link>.
      </p>
    </div>
  );
}
