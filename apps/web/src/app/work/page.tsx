import { scopedFetch } from '../../lib/api';
const fallback = [
  { id: "task-bill-001", title: "Review uncertain supplier bill", area: "Money out", status: "Needs review", owner: "Clerk", source: "Supplier bill · synthetic" },
  { id: "task-invoice-001", title: "Approve direct invoice draft", area: "Money in", status: "Due today", owner: "Reviewer", source: "Invoice · synthetic" },
  { id: "task-close-001", title: "Attach evidence to close task", area: "Close", status: "Open", owner: "Controller", source: "Period close · synthetic" },
];

export default async function WorkPage() {
  let tasks = fallback;
  try {
    const response = await scopedFetch("/demo/work", { cache: "no-store" });
    if (!response.ok) return <main className="workspace-page"><h1>Workspace unavailable</h1><p>Sign in with an assigned demo account to continue.</p><a href="/api/auth/login">Sign in</a></main>;
    if (response.ok) tasks = (await response.json()).tasks;
  } catch { return <main className="workspace-page"><h1>Service unavailable</h1><p>Retry shortly.</p></main>; }
  return <main className="workspace-page"><p className="eyebrow">My work · Demo</p><h1>Tasks assigned to you</h1><p className="page-intro">Synthetic tasks show the review pattern without changing a live ledger.</p><div className="task-list">{tasks.map((task: typeof fallback[number]) => <article key={task.id}><div><strong>{task.title}</strong><span>{task.area} · {task.owner} · {task.source}</span></div><b className={"status " + (task.status === "Needs review" ? "warning" : task.status === "Open" ? "neutral" : "")}>{task.status}</b></article>)}</div><a className="back-link" href="/">← Back to workspace</a></main>;
}
