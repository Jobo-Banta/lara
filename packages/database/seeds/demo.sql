insert into lara_demo.runs(id, fixture_version, label)
values ('demo-run-001', 'phase1-v1', 'LARA Demo Finance')
on conflict (id) do nothing;

insert into lara_demo.tasks(id, run_id, title, area, status, due_date, owner, source, amount)
values
  ('task-bill-001', 'demo-run-001', 'Review uncertain supplier bill', 'Money out', 'Needs review', '2026-09-18', 'Clerk', 'Supplier bill · synthetic', 74800.00),
  ('task-invoice-001', 'demo-run-001', 'Approve direct invoice draft', 'Money in', 'Due today', '2026-09-18', 'Reviewer', 'Invoice · synthetic', 11200.00),
  ('task-close-001', 'demo-run-001', 'Attach evidence to close task', 'Close', 'Open', '2026-09-20', 'Controller', 'Period close · synthetic', null)
on conflict (id) do nothing;

insert into lara_demo.invoices(id,run_id,customer,issue_date,due_date,subtotal,tax,total,status,idempotency_key)
values ('invoice-demo-001','demo-run-001','Northwind Services','2026-09-18','2026-10-18',10000,1200,11200,'Draft','invoice-demo-001') on conflict do nothing;
insert into lara_demo.bills(id,run_id,supplier,confidence,amount,status,correction,evidence_id)
values ('bill-demo-001','demo-run-001','Harbor Cloud Hosting',0.62,74800,'Needs review',null,'evidence-bill-001') on conflict do nothing;
insert into lara_demo.reconciliation_lines(id,run_id,statement_date,description,statement_amount,matched_amount,status)
values ('bank-line-001','demo-run-001','2026-09-18','Customer receipt · synthetic',11200,11200,'Matched'),('bank-line-002','demo-run-001','2026-09-18','Bank fee · synthetic',350,0,'Unmatched') on conflict do nothing;
insert into lara_demo.close_tasks(id,run_id,period,title,owner,status,required)
values ('close-task-001','demo-run-001','2026-08','Attach bank evidence','Controller','Open',true),('close-task-002','demo-run-001','2026-08','Review synthetic tax queue','Tax','Complete',true) on conflict do nothing;
insert into lara_demo.compliance_items(id,run_id,obligation,status,next_action)
values ('compliance-001','demo-run-001','BIR fixture queue','Needs review','Resolve buyer field before simulated submit'),('compliance-002','demo-run-001','Monthly close package','Ready','Open evidence trail') on conflict do nothing;
insert into lara_demo.evidence(id,run_id,title,kind,related_to,status)
values ('evidence-bill-001','demo-run-001','Harbor Cloud invoice fixture','Synthetic PDF','bill-demo-001','Available'),('evidence-bank-001','demo-run-001','September bank statement fixture','Synthetic CSV','bank-line-001','Available') on conflict do nothing;
