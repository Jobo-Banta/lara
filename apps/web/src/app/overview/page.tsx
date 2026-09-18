export default async function OverviewPage() {
  let overview = { tasks: 3, amount: "120000.00", asOf: "2026-09-18" };
  try {
    const response = await fetch("http://127.0.0.1:4000/demo/overview", { cache: "no-store" });
    if (response.ok) overview = await response.json();
  } catch {}
  return <main className="workspace-page"><p className="eyebrow">Overview · Demo</p><h1>Finance signals at a glance</h1><p className="page-intro">All totals are synthetic, with an as-of date and simulation label.</p><div className="overview-grid"><article><span>Open synthetic tasks</span><strong>{overview.tasks}</strong><small>As of {overview.asOf}</small></article><article><span>Tracked task amounts</span><strong>PHP {Number(overview.amount).toLocaleString("en-PH", { minimumFractionDigits: 2 })}</strong><small>Demo data only</small></article><article><span>Next obligation</span><strong>Payroll review</strong><small>Due 20 September · simulated</small></article></div><a className="back-link" href="/">← Back to workspace</a></main>;
}
