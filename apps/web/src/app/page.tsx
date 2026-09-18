import { currentSession } from "../lib/auth";

export default async function HomePage() {
  const session = await currentSession().catch(() => null);
  return (
    <main className="lara-shell">
      <header className="lara-header">
        <img src="/assets/lara/logos/lara-logo-primary.svg" alt="LARA" width="144" height="40" />
      </header>
      <section className="lara-panel" aria-labelledby="welcome-title">
        <p className="eyebrow">Engineering baseline</p>
        <h1 id="welcome-title">LARA workspace is ready to build.</h1>
        {session ? <p>Signed in as {session.name || session.email || session.sub}. <a href="/auth/logout">Sign out</a></p> : <p>Phase 0 is establishing the authenticated application shell, database boundary, and repeatable delivery checks. <a href="/api/auth/login">Sign in with Supabase</a></p>}
      </section>
    </main>
  );
}
