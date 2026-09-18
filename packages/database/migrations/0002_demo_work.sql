create schema if not exists lara_demo;

create table if not exists lara_demo.runs (
  id text primary key,
  fixture_version text not null,
  label text not null,
  created_at timestamptz not null default now()
);

create table if not exists lara_demo.tasks (
  id text primary key,
  run_id text not null references lara_demo.runs(id),
  title text not null,
  area text not null,
  status text not null,
  due_date date not null,
  owner text not null,
  source text not null,
  amount numeric(18,2),
  created_at timestamptz not null default now()
);

insert into lara_demo.runs(id, fixture_version, label)
values ('demo-run-001', 'phase1-v1', 'LARA Demo Finance')
on conflict (id) do nothing;

insert into lara_demo.tasks(id, run_id, title, area, status, due_date, owner, source, amount)
values
  ('task-bill-001', 'demo-run-001', 'Review uncertain supplier bill', 'Money out', 'Needs review', '2026-09-18', 'Clerk', 'Supplier bill · synthetic', 74800.00),
  ('task-invoice-001', 'demo-run-001', 'Approve direct invoice draft', 'Money in', 'Due today', '2026-09-18', 'Reviewer', 'Invoice · synthetic', 11200.00),
  ('task-close-001', 'demo-run-001', 'Attach evidence to close task', 'Close', 'Open', '2026-09-20', 'Controller', 'Period close · synthetic', null)
on conflict (id) do nothing;
