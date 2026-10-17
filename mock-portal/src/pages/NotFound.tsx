import { Link } from "react-router-dom";
import { Card, linkClass, usePageTitle } from "../components/ui";

export function NotFound() {
  usePageTitle("Page not found");
  return (
    <Card>
      <h1 className="text-xl font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 text-slate-600">
        We couldn't find that page. Try the <Link className={linkClass} to="/dashboard">dashboard</Link> or the{" "}
        <Link className={linkClass} to="/help">help center</Link>.
      </p>
    </Card>
  );
}
