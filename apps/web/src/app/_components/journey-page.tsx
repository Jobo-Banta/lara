"use client";
import { useEffect, useState } from "react";
type Config = { title: string; eyebrow: string; endpoint: string; action?: { label: string; url: string; body: Record<string, unknown> } };
export default function JourneyPage({ config }: { config: Config }) {
  const [data, setData] = useState<any>(null); const [message, setMessage] = useState("");
  async function load() { const response = await fetch(`http://127.0.0.1:4000${config.endpoint}`); setData(await response.json()); }
  useEffect(() => { load().catch(() => setMessage("Retry when the local API is available.")); }, []);
  async function act() { const action = config.action!; const response = await fetch(`http://127.0.0.1:4000${action.url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action.body) }); const result = await response.json(); setMessage(result.message || "Saved to the synthetic demo service."); await load(); }
  const rows = data?.invoices || data?.bills || data?.lines || data?.tasks || data?.items || data?.evidence || data?.scenarios || [];
  return <main className="workspace-page"><p className="eyebrow">{config.eyebrow} · Demo</p><h1>{config.title}</h1><p className="page-intro">Synthetic records only. Actions persist in Supabase demo tables and are labelled simulated.</p>{message && <p role="status" className="status neutral">{message}</p>}<section className="task-list">{rows.map((row: any) => <article key={row.id || row.title}><div><strong>{row.title || row.customer || row.supplier || row.description || row.obligation || row.name}</strong><span>{row.status || row.kind || row.owner || row.next_action || row.total || ""}</span></div><b className="status">{row.amount ? `PHP ${Number(row.amount).toLocaleString("en-PH", { minimumFractionDigits: 2 })}` : row.confidence ? `Confidence ${row.confidence}` : row.id || ""}</b></article>)}</section>{data?.locked !== undefined && <p className="status warning">{data.locked ? "Lock preview blocked until required demo tasks are complete." : "All required synthetic close tasks are complete."}</p>}{config.action && <button className="primary-button" onClick={act}>{config.action.label}</button>}<a className="back-link" href="/">← Back to workspace</a></main>;
}

