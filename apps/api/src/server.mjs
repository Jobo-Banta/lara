import http from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { loadConfig, safeConfigError } from "../../../packages/config/src/env.mjs";

const pg = createRequire(import.meta.url)("pg");
function loadLocalEnv() {
  try {
    for (const line of readFileSync(join(process.cwd(), "..", "..", ".env.local"), "utf8").split(/\r?\n/)) {
      const index = line.indexOf("=");
      if (index > 0 && !line.startsWith("#")) process.env[line.slice(0, index)] ??= line.slice(index + 1);
    }
  } catch {}
}
loadLocalEnv();
const port = Number(process.env.API_PORT || 4000);
function database() {
  const url = new URL(process.env.DATABASE_URL);
  url.search = "";
  return new pg.Client({ connectionString: url.toString(), ssl: url.hostname.includes("supabase") ? { rejectUnauthorized: false } : undefined });
}
async function query(sql) {
  const db = database();
  await db.connect();
  try { return await db.query(sql); } finally { await db.end(); }
}
async function ready() {
  try { const config = loadConfig(); await query("select 1"); return { ok: true, mode: config.mode }; }
  catch (error) { return { ok: false, error: safeConfigError(error) }; }
}
const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  try {
    if (request.url === "/health/live") { response.end(JSON.stringify({ ok: true })); return; }
    if (request.url === "/health/ready") { const state = await ready(); response.statusCode = state.ok ? 200 : 503; response.end(JSON.stringify(state)); return; }
    if (request.url === "/demo/work") { const result = await query("select id,title,area,status,due_date,owner,source,amount::text from lara_demo.tasks order by due_date,id"); response.end(JSON.stringify({ run: "demo-run-001", synthetic: true, tasks: result.rows })); return; }
    if (request.url === "/demo/overview") { const result = await query("select count(*)::int as tasks, coalesce(sum(amount),0)::text as amount from lara_demo.tasks"); response.end(JSON.stringify({ run: "demo-run-001", synthetic: true, asOf: "2026-09-18", tasks: result.rows[0].tasks, amount: result.rows[0].amount })); return; }
    if (request.url === "/ops/version") { response.end(JSON.stringify({ version: "0.0.1", schema: "0002_demo_work" })); return; }
    response.statusCode = 404; response.end(JSON.stringify({ error: "NOT_FOUND" }));
  } catch (error) { response.statusCode = 500; response.end(JSON.stringify({ error: safeConfigError(error) })); }
});
server.listen(port, "127.0.0.1", () => console.log("LARA API listening on http://127.0.0.1:" + port));
