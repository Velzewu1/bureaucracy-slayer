import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePageTitle } from "./ui";

export function Article({
  title,
  lead,
  reviewed,
  children,
}: {
  readonly title: string;
  readonly lead: string;
  readonly reviewed?: string;
  readonly children: ReactNode;
}) {
  usePageTitle(title);
  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link className="text-teal-700 underline underline-offset-2" to="/help">Help</Link>
        <span className="mx-1 text-slate-400">/</span>
        <span className="text-slate-600">{title}</span>
      </nav>
      <article className="prose-help rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-3xl font-semibold text-slate-900">{title}</h1>
        <p className="mt-2 text-lg text-slate-600">{lead}</p>
        {reviewed === undefined ? null : <p className="text-sm text-slate-500">{reviewed}</p>}
        {children}
      </article>
    </div>
  );
}
