import { currentSession } from "../lib/auth";

export default async function HomePage() {
  const session = await currentSession().catch(() => null);
  return (
    <main className="lara-shell">
      <aside className="lara-nav" aria-label="Primary navigation">
        <img src="/assets/lara/logos/lara-logo-reverse.svg" alt="LARA" width="144" height="40" />
        <p className="demo-badge">Demo · synthetic data</p>
        <nav>
          <a className="active" href="/work">My work</a>
          <a href="/overview">Overview</a>
          <a href="/sales/invoices">Money in</a>
          <a href="/purchases/bills">Money out</a>
          <a href="/close">Close</a>
          <a href="/compliance">Compliance</a>
        <a href="/bank/reconcile">Reconcile</a><a href="/evidence">Evidence</a><a href="/demo/scenarios">Scenarios</a><a href="/feedback">Feedback</a></nav>
      </aside>
      <div className="lara-content">
        <header className="lara-header">
          <div><p className="eyebrow">LARA Demo Finance · HQ</p><strong>18 September 2026 · Synthetic workspace</strong></div>
          <div className="user-actions">{session ? <><span>{session.name || session.email || "Signed-in user"}</span><a href="/auth/logout">Sign out</a></> : <a className="button" href="/api/auth/login">Sign in</a>}</div>
        </header>
        <section className="lara-panel hero-panel" aria-labelledby="welcome-title">
          <p className="eyebrow">Prototype workspace</p>
          <h1 id="welcome-title">A clear place to move work forward.</h1>
          <p>Review assigned tasks, inspect synthetic finance signals, and follow each item back to its source. Every value in this demo is labelled and isolated from production books.</p>
          <div className="action-row"><a className="button" href="/work">Open my work</a><a className="button secondary" href="/overview">View overview</a></div>
        </section>
        <section className="metric-grid" aria-label="Synthetic workspace summary">
          <article className="metric-card"><span>Open tasks</span><strong>8</strong><small>2 due today</small></article>
          <article className="metric-card"><span>Cash position</span><strong>PHP 842,600.00</strong><small>As of 18 Sep · simulated</small></article>
          <article className="metric-card"><span>Items needing review</span><strong>3</strong><small>Owner and evidence shown</small></article>
        </section>
      </div>
    </main>
  );
}
