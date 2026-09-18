// Removes tenants created by tests or interrupted runs. Requires a connection
// that owns the tables or bypasses RLS and sets the maintenance flag; runtime
// roles cannot delete. Engineering databases only.
const order=['journal_lines','journal_entries','journal_drafts','report_snapshots','close_tasks','substantiations','statement_mappings','journal_templates','source_control_balances','opening_rows','opening_batches','account_dimension_rules','accounts','dimensions','periods','audit_events','audit_chain_heads','inbox_receipts','outbox_events','jobs','command_receipts','approval_decisions','approval_requests','obligations','task_comments','tasks','evidence_links','party_bank_accounts','party_roles','party','evidence','settings_versions','onboarding_checks','capability_activations','approval_policies','delegation','memberships','roles','principals','books','branches','entities'];
export async function removeTenants(db,ids){
 await db.query("select set_config('lara.maintenance','teardown',false)");
 for(const id of ids){
  await db.query("select set_config('lara.tenant_id',$1,false)",[id]);
  for(const table of order){
   if(table==='inbox_receipts')await db.query('delete from lara.inbox_receipts where event_id in (select event_id from lara.outbox_events where tenant_id=$1)',[id]);
   else await db.query('delete from lara.'+table+' where tenant_id=$1',[id]);
  }
  await db.query('delete from lara.tenants where id=$1',[id]);
 }
}
