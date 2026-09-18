export default function HomePage() {
  return (
    <main className="lara-shell">
      <header className="lara-header">
        <img src="/assets/lara/logos/lara-logo-primary.svg" alt="LARA" width="144" height="40" />
      </header>
      <section className="lara-panel" aria-labelledby="welcome-title">
        <p className="eyebrow">Engineering baseline</p>
        <h1 id="welcome-title">LARA workspace is ready to build.</h1>
        <p>Phase 0 is establishing the authenticated application shell, database boundary, and repeatable delivery checks.</p>
      </section>
    </main>
  );
}
