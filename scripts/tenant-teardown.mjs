// Removes tenants created by tests or interrupted runs. Requires a connection
// that owns the tables or bypasses RLS and sets the maintenance flag; runtime
// roles cannot delete. Engineering databases only.
const order=['transmission_attempts','transmission_jobs','filing_records','return_source_links','return_lines','return_runs','schema_artifacts','regulatory_profiles','registration_cases','bank_file_items','bank_file_runs','cash_handovers','cash_count_lines','cash_sessions','transfers','check_instruments','reconciliation_allocations','reconciliation_matches','bank_statement_lines','bank_statement_batches','advance_events','expense_claims','advances','payment_orders','beneficiary_versions','receipts_of_service','withholding_certificates','allocation_events','tax_events','deliveries','party_snapshots','document_relations','open_items','settlements','bank_accounts','document_lines','documents','number_events','document_series','payment_terms','credit_limits','tax_rule_versions','journal_drafts','opening_rows','source_control_balances','opening_batches','journal_lines','journal_entries','report_snapshots','close_tasks','substantiations','statement_mappings','journal_templates','account_dimension_rules','accounts','dimensions','periods','audit_events','audit_chain_heads','inbox_receipts','outbox_events','jobs','command_receipts','approval_decisions','approval_requests','obligations','task_comments','tasks','evidence_links','party_bank_accounts','party_roles','party','evidence','settings_versions','onboarding_checks','capability_activations','approval_policies','delegation','memberships','roles','principals','books','branches','entities'];
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
