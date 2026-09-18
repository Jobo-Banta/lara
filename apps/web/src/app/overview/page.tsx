import { scopedFetch } from '../../lib/api';
export default async function OverviewPage() {
  let overview = { tasks: 3, amount: "120000.00", asOf: "2026-09-18" };
  try {
    const response = await scopedFetch("/demo/overview", { cache: "no-store" });
    if (!response.ok) return <main className="workspace-page"><h1>Workspace unavailable</h1><p>Sign in with an assigned demo account to continue.</p><a href="/api/auth/login">Sign in</a></main>;
    if (response.ok) overview = await response.json();
  } catch { return <main className="workspace-page"><h1>Service unavailable</h1><p>Retry shortly.</p></main>; }
  return <main className="workspace-page"><p className="eyebrow">Overview · Demo</p><h1>Finance signals at a glance</h1><p className="page-intro">All totals are synthetic, with an as-of date and simulation label.</p><div className="overview-grid"><article><span>Open synthetic tasks</span><strong>{overview.tasks}</strong><small>As of {overview.asOf}</small></article><article><span>Tracked task amounts</span><strong>PHP {Number(overview.amount).toLocaleString("en-PH", { minimumFractionDigits: 2 })}</strong><small>Demo data only</small></article><article><span>Next obligation</span><strong>Payroll review</strong><small>Due 20 September · simulated</small></article></div><a className="back-link" href="/">← Back to workspace</a></main>;
}
