import {createHash} from 'node:crypto';
export const tables=['public.schema_migrations','lara.environment','lara.demo_seed_runs','lara_demo.runs','lara_demo.tasks','lara_demo.invoices','lara_demo.bills','lara_demo.reconciliation_lines','lara_demo.close_tasks','lara_demo.compliance_items','lara_demo.evidence','lara_demo.feedback','lara_demo.workspaces'];
export function digest(rows){return createHash('sha256').update(JSON.stringify(rows.map(row=>JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))))).sort())).digest('hex');}
export async function snapshot(db){
 await db.query('begin isolation level repeatable read read only');
 try{
  const data={format:'lara-engineering-snapshot-v2',created_at:new Date().toISOString(),tables:{}};
  for(const table of tables){const r=await db.query('select to_jsonb(t) as row from '+table+' t');const rows=r.rows.map(v=>v.row);data.tables[table]={rows,sha256:digest(rows)};}
  await db.query('commit');return data;
 }catch(e){await db.query('rollback');throw e;}
}
export async function restoreRehearsal(db,data){
 if(data.format!=='lara-engineering-snapshot-v2'||tables.some(t=>!data.tables[t]||digest(data.tables[t].rows)!==data.tables[t].sha256))throw Error('Snapshot integrity verification failed');
 await db.query('begin');
 try{
  await db.query('create schema lara_restore_rehearsal');
  const counts={};
  for(const [index,table] of tables.entries()){
   const target='lara_restore_rehearsal.table_'+index;
   await db.query('create table '+target+' (like '+table+')');
   await db.query('insert into '+target+' select * from jsonb_populate_recordset(null::'+target+',$1::jsonb)',[JSON.stringify(data.tables[table].rows)]);
   const rows=(await db.query('select to_jsonb(t) as row from '+target+' t')).rows.map(v=>v.row);
   if(digest(rows)!==data.tables[table].sha256)throw Error('Restored content mismatch: '+table);
   counts[table]=rows.length;
  }
  return counts;
 }finally{await db.query('rollback');}
}
