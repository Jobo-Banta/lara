import { connectionOptions } from '../../../packages/database/src/connection.mjs';
import http from "node:http";
import { loadLocalEnv as loadRootEnv } from "../../../scripts/local-env.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { loadConfig, safeConfigError } from "../../../packages/config/src/env.mjs";
const pg = createRequire(import.meta.url)("pg");
function loadLocalEnv() { try { for (const line of readFileSync(join(process.cwd(), "..", "..", ".env.local"), "utf8").split(/\r?\n/)) { const i = line.indexOf("="); if (i > 0 && !line.startsWith("#")) process.env[line.slice(0, i)] ??= line.slice(i + 1); } } catch {} }
loadRootEnv();
let config;
try { config = loadConfig(); } catch (error) { console.error(safeConfigError(error)); process.exit(1); }
const port = Number(process.env.API_PORT || 4000);
function database() { return new pg.Client(connectionOptions(process.env.DATABASE_URL)); }
async function query(sql, params = []) { const db = database(); await db.connect(); try { return await db.query(sql, params); } finally { await db.end(); } }
async function body(request) { let text = ""; for await (const chunk of request) text += chunk; return text ? JSON.parse(text) : {}; }
function send(response, status, value) { response.statusCode = status; response.end(JSON.stringify(value)); }
async function ready() { try { const config = loadConfig(); const schema = await query("select version from schema_migrations order by version"); if (!schema.rows.some(row => row.version === "0004_phase1_runtime_grants")) throw new Error("Schema incompatible"); return { ok: true, mode: config.mode }; } catch (error) { return { ok: false, error: safeConfigError(error) }; } }
const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-request-id", randomUUID());
  response.setHeader("cache-control", "no-store");
  try {
    const url = new URL(request.url, "http://localhost"); const path = url.pathname; const method = request.method;
    if (path === "/health/live") return send(response, 200, { ok: true });
    if (path === "/health/ready") { const state = await ready(); return send(response, state.ok ? 200 : 503, state); }
    if (path === "/ops/version") return send(response, 401, { error: "AUTHENTICATION_REQUIRED" });
    if (path.startsWith("/demo/") && config.mode !== "demo") return send(response, 404, { error: "NOT_FOUND" });
    if (path === "/demo/work") { const r = await query("select id,title,area,status,due_date,owner,source,amount::text from lara_demo.tasks order by due_date,id"); return send(response, 200, { run: "demo-run-001", synthetic: true, tasks: r.rows }); }
    if (path === "/demo/overview") { const r = await query("select count(*)::int as tasks, coalesce(sum(amount),0)::text as amount from lara_demo.tasks"); return send(response, 200, { run: "demo-run-001", synthetic: true, asOf: "2026-09-18", tasks: r.rows[0].tasks, amount: r.rows[0].amount }); }
    if (path === "/demo/invoices" && method === "GET") { const r = await query("select id,customer,issue_date,due_date,subtotal::text,tax::text,total::text,status from lara_demo.invoices order by created_at desc"); return send(response, 200, { synthetic: true, invoices: r.rows }); }
    if (path === "/demo/invoices" && method === "POST") { const b = await body(request); const key = b.idempotencyKey || `invoice-${Date.now()}`; const existing = await query("select id,customer,total::text,status from lara_demo.invoices where idempotency_key=$1", [key]); if (existing.rowCount) return send(response, 200, { synthetic: true, duplicate: true, invoice: existing.rows[0] }); const subtotal = Number(b.subtotal || 0); const tax = Math.round(subtotal * 0.12 * 100) / 100; const total = subtotal + tax; const id = `invoice-${Date.now()}`; const r = await query("insert into lara_demo.invoices(id,run_id,customer,issue_date,due_date,subtotal,tax,total,status,idempotency_key) values($1,'demo-run-001',$2,$3,$4,$5,$6,$7,'Draft',$8) returning id,customer,total::text,status", [id,b.customer || "Unnamed customer",b.issueDate || "2026-09-18",b.dueDate || "2026-10-18",subtotal,tax,total,key]); return send(response, 201, { synthetic: true, invoice: r.rows[0] }); }
    const invoiceMatch = path.match(/^\/demo\/invoices\/([^/]+)\/(submit|approve|post|collect)$/); if (invoiceMatch && method === "POST") { const status = { submit: "Submitted", approve: "Approved", post: "Posted", collect: "Collected" }[invoiceMatch[2]]; const r = await query("update lara_demo.invoices set status=$1,updated_at=now() where id=$2 returning id,status,total::text", [status, invoiceMatch[1]]); return send(response, r.rowCount ? 200 : 404, { synthetic: true, invoice: r.rows[0] || null }); }
    if (path === "/demo/bills" && method === "GET") { const r = await query("select id,supplier,confidence::text,amount::text,status,correction,evidence_id from lara_demo.bills"); return send(response, 200, { synthetic: true, bills: r.rows }); }
    const billMatch = path.match(/^\/demo\/bills\/([^/]+)\/correct$/); if (billMatch && method === "POST") { const b = await body(request); const r = await query("update lara_demo.bills set correction=$1,status='Corrected' where id=$2 returning id,supplier,status,correction", [b.correction || "Field corrected", billMatch[1]]); return send(response, r.rowCount ? 200 : 404, { synthetic: true, bill: r.rows[0] || null }); }
    if (path === "/demo/reconciliation" && method === "GET") { const r = await query("select id,statement_date,description,statement_amount::text,matched_amount::text,status from lara_demo.reconciliation_lines"); return send(response, 200, { synthetic: true, lines: r.rows }); }
    const reconMatch = path.match(/^\/demo\/reconciliation\/([^/]+)\/match$/); if (reconMatch && method === "POST") { const b = await body(request); const r = await query("update lara_demo.reconciliation_lines set matched_amount=$1,status=case when $1=statement_amount then 'Matched' else 'Partial' end where id=$2 returning id,status,matched_amount::text", [Number(b.amount || 0), reconMatch[1]]); return send(response, r.rowCount ? 200 : 404, { synthetic: true, line: r.rows[0] || null }); }
    if (path === "/demo/close" && method === "GET") { const r = await query("select id,period,title,owner,status,required from lara_demo.close_tasks order by id"); return send(response, 200, { synthetic: true, locked: r.rows.some(x => x.required && x.status !== "Complete"), tasks: r.rows }); }
    const closeMatch = path.match(/^\/demo\/close\/([^/]+)\/complete$/); if (closeMatch && method === "POST") { const r = await query("update lara_demo.close_tasks set status='Complete' where id=$1 returning id,status", [closeMatch[1]]); return send(response, r.rowCount ? 200 : 404, { synthetic: true, task: r.rows[0] || null }); }
    if (path === "/demo/payments" && method === "GET") return send(response, 200, { synthetic: true, payments: [{ id: "payment-demo-001", bill_id: "bill-demo-001", beneficiary: "Harbor Cloud Hosting", authority: "Approved", release: "Simulated", settlement: "Not released" }] });
    const evidenceMatch = path.match(/^\/demo\/evidence\/([^/]+)$/); if (evidenceMatch && method === "GET") { const r = await query("select id,title,kind,related_to,status from lara_demo.evidence where id=$1", [evidenceMatch[1]]); return send(response, r.rowCount ? 200 : 404, { synthetic: true, evidence: r.rows[0] || null }); }
    if (path === "/demo/compliance" && method === "GET") { const r = await query("select id,obligation,status,next_action from lara_demo.compliance_items"); return send(response, 200, { synthetic: true, items: r.rows }); }
    if (path === "/demo/evidence" && method === "GET") { const r = await query("select id,title,kind,related_to,status from lara_demo.evidence"); return send(response, 200, { synthetic: true, evidence: r.rows }); }
    if (path === "/demo/scenarios" && method === "GET") return send(response, 200, { synthetic: true, scenarios: [{ id: "DEMO-01", title: "Direct invoice" }, { id: "DEMO-02", title: "Uncertain bill" }, { id: "DEMO-05", title: "Cash match" }, { id: "DEMO-06", title: "Period close" }] });
    if (path === "/demo/reset" && method === "POST") return send(response, 501, { error: "SESSION_SCOPED_RESET_NOT_IMPLEMENTED" });
    if (path === "/demo/feedback" && method === "POST") { const b = await body(request); const r = await query("insert into lara_demo.feedback(run_id,scenario,route,severity,message) values('demo-run-001',$1,$2,$3,$4) returning id", [b.scenario || "Unspecified",b.route || "/",b.severity || "minor",b.message || ""]); return send(response, 201, { synthetic: true, feedbackId: r.rows[0].id }); }
    return send(response, 404, { error: "NOT_FOUND" });
  } catch (error) { return send(response, 500, { error: safeConfigError(error) }); }
});
server.listen(port, "127.0.0.1", () => console.log("LARA API listening on http://127.0.0.1:" + port));
