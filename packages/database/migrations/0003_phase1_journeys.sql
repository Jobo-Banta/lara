create table if not exists lara_demo.invoices (
  id text primary key,
  run_id text not null references lara_demo.runs(id),
  customer text not null,
  issue_date date not null,
  due_date date not null,
  subtotal numeric(18,2) not null,
  tax numeric(18,2) not null,
  total numeric(18,2) not null,
  status text not null,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists lara_demo.bills (
  id text primary key,
  run_id text not null references lara_demo.runs(id),
  supplier text not null,
  confidence numeric(5,2) not null,
  amount numeric(18,2) not null,
  status text not null,
  correction text,
  evidence_id text,
  created_at timestamptz not null default now()
);
create table if not exists lara_demo.reconciliation_lines (
  id text primary key,
  run_id text not null references lara_demo.runs(id),
  statement_date date not null,
  description text not null,
  statement_amount numeric(18,2) not null,
  matched_amount numeric(18,2) not null default 0,
  status text not null
);
create table if not exists lara_demo.close_tasks (
  id text primary key,
  run_id text not null references lara_demo.runs(id),
  period text not null,
  title text not null,
  owner text not null,
  status text not null,
  required boolean not null default true
);
create table if not exists lara_demo.compliance_items (
  id text primary key,
  run_id text not null references lara_demo.runs(id),
  obligation text not null,
  status text not null,
  next_action text not null
);
create table if not exists lara_demo.evidence (
  id text primary key,
  run_id text not null references lara_demo.runs(id),
  title text not null,
  kind text not null,
  related_to text not null,
  status text not null
);
create table if not exists lara_demo.feedback (
  id bigserial primary key,
  run_id text not null references lara_demo.runs(id),
  scenario text not null,
  route text not null,
  severity text not null,
  message text not null,
  created_at timestamptz not null default now()
);
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
