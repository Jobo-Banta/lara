import {createHash} from 'node:crypto';
export const tables=['public.schema_migrations','lara.environment','lara.demo_seed_runs','lara_demo.runs','lara_demo.tasks','lara_demo.invoices','lara_demo.bills','lara_demo.reconciliation_lines','lara_demo.close_tasks','lara_demo.compliance_items','lara_demo.evidence','lara_demo.feedback','lara_demo.workspaces','lara.permission_definitions','lara.capability_definitions','lara.role_templates','lara.tenants','lara.entities','lara.branches','lara.books','lara.principals','lara.roles','lara.memberships','lara.delegation','lara.approval_policies','lara.capability_activations','lara.onboarding_checks','lara.settings_versions','lara.party','lara.party_roles','lara.party_bank_accounts','lara.evidence','lara.evidence_links','lara.tasks','lara.task_comments','lara.obligations','lara.approval_requests','lara.approval_decisions','lara.command_receipts','lara.outbox_events','lara.inbox_receipts','lara.jobs','lara.audit_chain_heads','lara.audit_events','lara.principal_directory','lara.accounts','lara.account_dimension_rules','lara.dimensions','lara.periods','lara.journal_entries','lara.journal_lines','lara.opening_batches','lara.opening_rows','lara.source_control_balances','lara.report_snapshots','lara.close_tasks','lara.substantiations','lara.statement_mappings','lara.journal_templates','lara.journal_drafts','lara.tax_rule_versions','lara.document_series','lara.number_events','lara.payment_terms','lara.documents','lara.document_lines','lara.document_relations','lara.party_snapshots','lara.tax_events','lara.open_items','lara.settlements','lara.allocation_events','lara.credit_limits','lara.deliveries','lara.receipts_of_service','lara.beneficiary_versions','lara.payment_orders','lara.advances','lara.advance_events','lara.expense_claims','lara.withholding_certificates','lara.bank_accounts','lara.bank_statement_batches','lara.bank_statement_lines','lara.reconciliation_matches','lara.reconciliation_allocations','lara.check_instruments','lara.transfers','lara.cash_sessions','lara.cash_count_lines','lara.cash_handovers','lara.bank_file_runs','lara.bank_file_items','lara.regulatory_profiles','lara.schema_artifacts','lara.return_runs','lara.return_lines','lara.return_source_links','lara.filing_records','lara.transmission_jobs','lara.transmission_attempts','lara.registration_cases','lara.source_systems','lara.source_ownership','lara.mapping_versions','lara.mapping_lines','lara.source_batches','lara.source_rows','lara.expected_batches','lara.source_balance_snapshots','lara.tax_instrument_facts','lara.branch_rollups','lara.currency_metadata','lara.book_access','lara.book_links','lara.fx_rates','lara.fx_open_item_layers','lara.revaluation_runs','lara.warehouses','lara.items','lara.stock_movements','lara.stock_movement_lines','lara.stock_balances','lara.valuation_layers','lara.stock_allocations','lara.lot_serials','lara.count_sessions','lara.count_lines','lara.landed_cost_runs','lara.landed_cost_allocations','lara.asset_classes','lara.assets','lara.asset_events','lara.asset_components','lara.recognition_schedules','lara.schedule_versions','lara.schedule_lines','lara.schedule_runs','lara.book_tax_layers'];
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
