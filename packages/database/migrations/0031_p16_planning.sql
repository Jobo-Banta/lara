-- P16 budgets, cost allocation and project accounting: budget versions per
-- book and period with lines per account and dimension bucket, approved and
-- activated by other principals; commitments reserved from approved
-- purchase orders inside a locked budget bucket, consumed by the bills that
-- post against the order and released on cancellation; allocation rule
-- versions with drivers whose total is positive, runs that preview the
-- pool against a source cutoff and post once per rule version and period;
-- projects with approved contract versions (change orders), milestones
-- certified on evidence, progress billing that holds retention in its own
-- receivable and recoups documented advances, and retention released on
-- evidence through the control account. Posted facts stay immutable.

create table lara.budgets (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 period_start date not null,
 period_end date not null,
 version_number integer not null check (version_number >= 1),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 policy text not null check (policy in ('warn','block')),
 state text not null default 'draft' check (state in ('draft','approved','active','superseded','rejected')),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 approved_by uuid,
 approved_at timestamptz,
 activated_by uuid,
 activated_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, book_id, period_start, period_end, version_number),
 check (period_end >= period_start),
 check (state not in ('approved','active','superseded') or (approved_by is not null and approved_at is not null)),
 check (state not in ('active','superseded') or (activated_by is not null and activated_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, activated_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index budgets_one_active on lara.budgets (tenant_id, entity_id, book_id, period_start, period_end) where state = 'active';
create or replace function lara.budgets_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('superseded','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % budget is final', old.state using errcode = 'check_violation';
 end if;
 if old.state <> 'draft' and (new.content_hash <> old.content_hash or new.policy <> old.policy or new.currency <> old.currency) then
  raise exception 'STATE_CONFLICT: an approved budget is immutable; draft the next version' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('approved','rejected')) or
  (old.state = 'approved' and new.state in ('active','superseded','rejected')) or
  (old.state = 'active' and new.state = 'superseded')) then
  raise exception 'STATE_CONFLICT: budget cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger budgets_validate before update on lara.budgets for each row execute function lara.budgets_validate();
create trigger budgets_touch before update on lara.budgets for each row execute function lara.touch_row();

-- One bucket per account and dimension set; the bucket row is the lock
-- taken while a commitment is reserved against it.
create table lara.budget_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 budget_id uuid not null,
 account_id uuid not null,
 dimensions_json jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions_json) = 'object'),
 dimensions_key text not null,
 amount numeric(20,6) not null check (amount >= 0),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, budget_id, account_id, dimensions_key),
 foreign key (tenant_id, budget_id) references lara.budgets (tenant_id, id) on delete cascade,
 foreign key (tenant_id, account_id) references lara.accounts (tenant_id, id)
);

-- Commitments: reserved when a purchase order is approved, consumed by the
-- bills that post against it, released on cancellation. Amounts in the
-- book's functional currency; an override is the authorized approver's
-- recorded decision under a blocking policy.
create table lara.commitments (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 budget_id uuid,
 budget_line_id uuid,
 source_type text not null check (source_type in ('purchase_order')),
 source_id uuid not null,
 line_no integer not null check (line_no >= 1),
 account_id uuid not null,
 dimensions_json jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions_json) = 'object'),
 amount numeric(20,6) not null check (amount > 0),
 consumed numeric(20,6) not null default 0 check (consumed >= 0),
 state text not null default 'open' check (state in ('open','consumed','released')),
 warning text,
 override_reason text,
 override_by uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, source_type, source_id, line_no),
 check (consumed <= amount),
 check (override_reason is null or override_by is not null),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, budget_id) references lara.budgets (tenant_id, id),
 foreign key (tenant_id, budget_line_id) references lara.budget_lines (tenant_id, id),
 foreign key (tenant_id, entity_id, source_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, override_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index commitments_bucket on lara.commitments (tenant_id, entity_id, book_id, account_id, state);
create or replace function lara.commitments_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('consumed','released') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % commitment is final', old.state using errcode = 'check_violation';
 end if;
 if new.consumed < old.consumed then
  raise exception 'APPEND_ONLY: consumption is never reduced' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger commitments_validate before update on lara.commitments for each row execute function lara.commitments_validate();
create trigger commitments_touch before update on lara.commitments for each row execute function lara.touch_row();

-- Allocation rule versions: the source pool (accounts and dimension
-- filter), the drivers (target dimension sets with positive weights) and the
-- target account; approved by another principal; immutable once approved.
create table lara.allocation_rules (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 code text not null check (code ~ '^[A-Za-z0-9._-]{1,64}$'),
 version_number integer not null check (version_number >= 1),
 name text not null check (length(btrim(name)) between 1 and 200),
 source_account_ids uuid[] not null check (cardinality(source_account_ids) >= 1),
 source_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(source_dimensions) = 'object'),
 target_account_id uuid not null,
 drivers jsonb not null check (jsonb_typeof(drivers) = 'array' and jsonb_array_length(drivers) >= 1),
 effective_from date not null,
 effective_to date,
 state text not null default 'draft' check (state in ('draft','approved','superseded','rejected')),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, code, version_number),
 check (effective_to is null or effective_to >= effective_from),
 check (state <> 'approved' or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, target_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.allocation_rules_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('superseded','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % rule version is final', old.state using errcode = 'check_violation';
 end if;
 if old.state <> 'draft' and new.content_hash <> old.content_hash then
  raise exception 'STATE_CONFLICT: an approved rule version is immutable; add a new version' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not ((old.state = 'draft' and new.state in ('approved','rejected')) or (old.state = 'approved' and new.state = 'superseded')) then
  raise exception 'STATE_CONFLICT: rule version cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger allocation_rules_validate before update on lara.allocation_rules for each row execute function lara.allocation_rules_validate();
create trigger allocation_rules_touch before update on lara.allocation_rules for each row execute function lara.touch_row();

-- Allocation runs: the pool as of the source cutoff, the lines the drivers
-- produce (rounded amounts summing exactly to the pool, residual to the
-- first target in stable order), approved and posted once per rule version
-- and period.
create table lara.allocation_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 rule_version_id uuid not null,
 period_id uuid not null,
 source_cutoff timestamptz not null,
 driver_evidence_id uuid not null,
 state text not null default 'draft' check (state in ('draft','previewed','approved','posted','rejected')),
 pool numeric(20,6),
 lines jsonb,
 lines_hash text check (lines_hash ~ '^[a-f0-9]{64}$'),
 entry_id uuid,
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 approved_by uuid,
 approved_at timestamptz,
 posted_by uuid,
 posted_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state not in ('previewed','approved','posted') or (pool is not null and lines is not null and lines_hash is not null)),
 check (state not in ('approved','posted') or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 check (state <> 'posted' or (entry_id is not null and posted_by is not null and posted_at is not null)),
 foreign key (tenant_id, entity_id, rule_version_id) references lara.allocation_rules (tenant_id, entity_id, id),
 foreign key (tenant_id, period_id) references lara.periods (tenant_id, id),
 foreign key (tenant_id, entity_id, driver_evidence_id) references lara.evidence (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, posted_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index allocation_runs_once on lara.allocation_runs (tenant_id, rule_version_id, period_id) where state = 'posted';
create or replace function lara.allocation_runs_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('posted','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % allocation run is final', old.state using errcode = 'check_violation';
 end if;
 if old.state in ('approved','posted') and (new.lines_hash <> old.lines_hash or new.rule_version_id <> old.rule_version_id or new.period_id <> old.period_id or new.source_cutoff <> old.source_cutoff) then
  raise exception 'STATE_CONFLICT: an approved run keeps its inputs and lines; start a new run' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('previewed','rejected')) or
  (old.state = 'previewed' and new.state in ('draft','previewed','approved','rejected')) or
  (old.state = 'approved' and new.state in ('posted','rejected'))) then
  raise exception 'STATE_CONFLICT: allocation run cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger allocation_runs_validate before update on lara.allocation_runs for each row execute function lara.allocation_runs_validate();
create trigger allocation_runs_touch before update on lara.allocation_runs for each row execute function lara.touch_row();

-- Projects: a customer contract with an approved contract version (change
-- orders add versions; past billing is unchanged), milestones certified on
-- evidence, retention held per progress invoice, and documented advances.
create table lara.projects (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 code text not null check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
 customer_id uuid not null,
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 state text not null default 'active' check (state in ('active','closed')),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, code),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, customer_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger projects_touch before update on lara.projects for each row execute function lara.touch_row();

create table lara.project_contract_versions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 project_id uuid not null,
 version_number integer not null check (version_number >= 1),
 contract_amount numeric(20,6) not null check (contract_amount >= 0),
 reason text not null check (length(btrim(reason)) between 1 and 500),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 state text not null default 'draft' check (state in ('draft','approved','rejected')),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, project_id, version_number),
 check (state <> 'approved' or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id, project_id) references lara.projects (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.project_contract_versions_validate() returns trigger language plpgsql as $$
begin
 if old.state <> 'draft' and (new.state <> old.state or new.content_hash <> old.content_hash or new.contract_amount <> old.contract_amount or new.reason <> old.reason or new.evidence_ids <> old.evidence_ids) then
  raise exception 'STATE_CONFLICT: a decided contract version is immutable; a change order is the next version' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger project_contract_versions_validate before update on lara.project_contract_versions for each row execute function lara.project_contract_versions_validate();
create trigger project_contract_versions_touch before update on lara.project_contract_versions for each row execute function lara.touch_row();

create table lara.milestones (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 project_id uuid not null,
 sequence integer not null check (sequence >= 1),
 name text not null check (length(btrim(name)) between 1 and 200),
 amount numeric(20,6) not null check (amount > 0),
 certified_value numeric(20,6) not null default 0 check (certified_value >= 0),
 billed_value numeric(20,6) not null default 0 check (billed_value >= 0),
 certified_evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(certified_evidence_ids) = 'array'),
 certified_by uuid,
 certified_at timestamptz,
 state text not null default 'planned' check (state in ('planned','certified','billed')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, project_id, sequence),
 check (billed_value <= certified_value),
 check (certified_value = 0 or (certified_by is not null and certified_at is not null and jsonb_array_length(certified_evidence_ids) >= 1)),
 foreign key (tenant_id, entity_id, project_id) references lara.projects (tenant_id, entity_id, id),
 foreign key (tenant_id, certified_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.milestones_validate() returns trigger language plpgsql as $$
begin
 if new.billed_value < old.billed_value then
  raise exception 'APPEND_ONLY: billed value is never reduced; a credit note corrects the invoice' using errcode = 'check_violation';
 end if;
 if new.certified_value < old.billed_value then
  raise exception 'STATE_CONFLICT: certified value cannot fall below what is billed' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger milestones_validate before update on lara.milestones for each row execute function lara.milestones_validate();
create trigger milestones_touch before update on lara.milestones for each row execute function lara.touch_row();

create table lara.project_advances (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 project_id uuid not null,
 collection_id uuid not null,
 amount numeric(20,6) not null check (amount > 0),
 recouped numeric(20,6) not null default 0 check (recouped >= 0),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, project_id, collection_id),
 check (recouped <= amount),
 foreign key (tenant_id, entity_id, project_id) references lara.projects (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, collection_id) references lara.settlements (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger project_advances_touch before update on lara.project_advances for each row execute function lara.touch_row();

-- Progress billings: the invoice drafted for a certified milestone (the
-- due-now amount), the retention held and the advance recouped when it
-- posts; posted billings are immutable.
create table lara.project_billings (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 project_id uuid not null,
 milestone_id uuid not null,
 invoice_id uuid not null,
 contract_version_id uuid not null,
 certified_amount numeric(20,6) not null check (certified_amount > 0),
 retention_amount numeric(20,6) not null default 0 check (retention_amount >= 0),
 advance_recoupment numeric(20,6) not null default 0 check (advance_recoupment >= 0),
 state text not null default 'draft' check (state in ('draft','posted','cancelled')),
 recognition_entry_id uuid,
 allocation_event_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(allocation_event_ids) = 'array'),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, invoice_id),
 check (retention_amount + advance_recoupment <= certified_amount),
 foreign key (tenant_id, entity_id, project_id) references lara.projects (tenant_id, entity_id, id),
 foreign key (tenant_id, milestone_id) references lara.milestones (tenant_id, id),
 foreign key (tenant_id, contract_version_id) references lara.project_contract_versions (tenant_id, id),
 foreign key (tenant_id, entity_id, invoice_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.project_billings_validate() returns trigger language plpgsql as $$
begin
 if old.state <> 'draft' and (new.state <> old.state or new.certified_amount <> old.certified_amount or new.retention_amount <> old.retention_amount or new.advance_recoupment <> old.advance_recoupment) then
  raise exception 'STATE_CONFLICT: a posted billing is immutable; a credit note corrects the invoice' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger project_billings_validate before update on lara.project_billings for each row execute function lara.project_billings_validate();
create trigger project_billings_touch before update on lara.project_billings for each row execute function lara.touch_row();

create table lara.retention_items (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 project_id uuid not null,
 milestone_id uuid not null,
 billing_id uuid not null,
 invoice_id uuid not null,
 held numeric(20,6) not null check (held > 0),
 released numeric(20,6) not null default 0 check (released >= 0),
 due_condition text not null check (length(btrim(due_condition)) between 1 and 500),
 recognition_entry_id uuid not null,
 release_invoice_id uuid,
 released_at timestamptz,
 release_evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(release_evidence_ids) = 'array'),
 state text not null default 'held' check (state in ('held','released')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, invoice_id),
 check (released <= held),
 check (state <> 'released' or (released = held and release_invoice_id is not null and released_at is not null and jsonb_array_length(release_evidence_ids) >= 1)),
 foreign key (tenant_id, entity_id, project_id) references lara.projects (tenant_id, entity_id, id),
 foreign key (tenant_id, milestone_id) references lara.milestones (tenant_id, id),
 foreign key (tenant_id, billing_id) references lara.project_billings (tenant_id, id),
 foreign key (tenant_id, entity_id, invoice_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, release_invoice_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.retention_items_validate() returns trigger language plpgsql as $$
begin
 if old.state = 'released' and (new.state <> old.state or new.released <> old.released) then
  raise exception 'STATE_CONFLICT: a released retention is final' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger retention_items_validate before update on lara.retention_items for each row execute function lara.retention_items_validate();
create trigger retention_items_touch before update on lara.retention_items for each row execute function lara.touch_row();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['budgets','budget_lines','commitments','allocation_rules','allocation_runs','projects','project_contract_versions','milestones','project_advances','project_billings','retention_items'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.budgets, lara.commitments, lara.allocation_rules, lara.allocation_runs, lara.projects, lara.project_contract_versions, lara.milestones, lara.project_advances, lara.project_billings, lara.retention_items to lara_api;
grant select, insert, delete on lara.budget_lines to lara_api;
grant select on lara.budgets, lara.budget_lines, lara.commitments, lara.allocation_rules, lara.allocation_runs, lara.projects, lara.project_contract_versions, lara.milestones, lara.project_advances, lara.project_billings, lara.retention_items to lara_worker, lara_audit_reader;
