-- P11 assets, recurring work and recognition schedules: reviewed asset
-- classes, an asset register capitalized from posted bills or construction in
-- progress, append-only lifecycle events (transfer, split, merge, disposal,
-- impairment, revaluation, capitalization) each linked to its posting, one
-- schedule engine for depreciation, prepayments, deferred revenue, recurring
-- drafts and employee deductions with prospective versions, planned lines
-- unique per schedule and period so a rerun posts once, runs executed by the
-- worker under an explicit revocable authority, and memo book/tax layers per
-- asset and period. Every financial effect posts through lara.post_journal_entry.

create table lara.asset_classes (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 asset_account_id uuid not null,
 accumulated_depreciation_account_id uuid not null,
 depreciation_expense_account_id uuid not null,
 disposal_gain_account_id uuid not null,
 disposal_loss_account_id uuid not null,
 cip_account_id uuid,
 revaluation_surplus_account_id uuid,
 default_method text not null check (default_method in ('straight_line','declining_balance','sum_of_years')),
 default_useful_life_months integer not null check (default_useful_life_months >= 1),
 tax_method text check (tax_method is null or tax_method in ('straight_line','declining_balance','sum_of_years')),
 tax_useful_life_months integer check (tax_useful_life_months is null or tax_useful_life_months >= 1),
 status text not null default 'active' check (status in ('active','archived')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, code),
 check (asset_account_id <> accumulated_depreciation_account_id and asset_account_id <> depreciation_expense_account_id and accumulated_depreciation_account_id <> depreciation_expense_account_id),
 check (cip_account_id is null or cip_account_id <> asset_account_id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, asset_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, accumulated_depreciation_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, depreciation_expense_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, disposal_gain_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, disposal_loss_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, cip_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, revaluation_surplus_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger asset_classes_touch before update on lara.asset_classes for each row execute function lara.touch_row();

create table lara.assets (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 class_id uuid not null,
 tag text not null check (tag ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
 cost numeric(24,6) not null check (cost > 0),
 residual numeric(24,6) not null default 0 check (residual >= 0),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 in_service_date date not null,
 useful_life_months integer not null check (useful_life_months >= 1),
 method text not null check (method in ('straight_line','declining_balance','sum_of_years')),
 source_document_id uuid,
 location_id uuid,
 custodian_id uuid,
 stage text not null default 'in_service' check (stage in ('cip','in_service')),
 accumulated_depreciation numeric(24,6) not null default 0 check (accumulated_depreciation >= 0),
 state text not null default 'draft' check (state in ('draft','approved','disposed','merged','rejected')),
 approved_by uuid,
 capitalized_entry_id uuid,
 parent_id uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, tag),
 check (residual <= cost),
 check (accumulated_depreciation <= cost),
 check (state <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 check (source_document_id is not null or parent_id is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, class_id) references lara.asset_classes (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, source_document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, location_id) references lara.branches (tenant_id, entity_id, id),
 foreign key (tenant_id, custodian_id) references lara.party (tenant_id, id),
 foreign key (tenant_id, entity_id, parent_id) references lara.assets (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, capitalized_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index assets_queue on lara.assets (tenant_id, entity_id, state, in_service_date);
create index assets_source on lara.assets (tenant_id, source_document_id) where source_document_id is not null;
create or replace function lara.assets_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('disposed','merged','rejected') and (new.state <> old.state or new.cost <> old.cost or new.accumulated_depreciation <> old.accumulated_depreciation) then
  raise exception 'STATE_CONFLICT: a % asset is immutable', old.state using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('approved','rejected')) or
  (old.state = 'approved' and new.state in ('disposed','merged'))) then
  raise exception 'STATE_CONFLICT: asset cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 -- Once approved, the register facts change only through linked events (which carry the hash forward).
 if old.state = 'approved' and new.state = 'approved' and (new.method <> old.method or new.useful_life_months <> old.useful_life_months or new.class_id <> old.class_id) then
  raise exception 'STATE_CONFLICT: method and life change through a prospective schedule version, not by editing the asset' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger assets_validate before update on lara.assets for each row execute function lara.assets_validate();
create trigger assets_touch before update on lara.assets for each row execute function lara.touch_row();

create table lara.asset_events (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 asset_id uuid not null,
 sequence integer not null check (sequence >= 1),
 kind text not null check (kind in ('transfer','split','merge','disposal','impairment','revaluation','capitalize_cip')),
 effective_date date not null,
 amount numeric(24,6) check (amount is null or amount >= 0),
 proceeds numeric(24,6) check (proceeds is null or proceeds >= 0),
 related_asset_ids uuid[] not null default '{}',
 target_location_id uuid,
 reason text not null check (length(btrim(reason)) between 1 and 2000),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 posted_entry_id uuid,
 cost_before numeric(24,6) not null,
 accumulated_before numeric(24,6) not null,
 cost_after numeric(24,6) not null,
 accumulated_after numeric(24,6) not null,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, asset_id, sequence),
 check (kind <> 'disposal' or proceeds is not null),
 check (kind not in ('split','impairment','revaluation') or (amount is not null and amount > 0)),
 check (kind <> 'transfer' or target_location_id is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, asset_id) references lara.assets (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, target_location_id) references lara.branches (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index asset_events_asset on lara.asset_events (tenant_id, asset_id, effective_date);
create trigger asset_events_append_only before update or delete on lara.asset_events for each row execute function lara.reject_mutation();

-- Split and merge lineage: each component row names a child (split) or an
-- absorbed asset (merge) with the gross cost and accumulated depreciation moved.
create table lara.asset_components (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 parent_id uuid not null,
 asset_id uuid not null,
 event_id uuid not null,
 cost numeric(24,6) not null check (cost > 0),
 accumulated_depreciation numeric(24,6) not null check (accumulated_depreciation >= 0),
 useful_life_months integer not null check (useful_life_months >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 check (parent_id <> asset_id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, parent_id) references lara.assets (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, asset_id) references lara.assets (tenant_id, entity_id, id),
 foreign key (tenant_id, event_id) references lara.asset_events (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger asset_components_append_only before update or delete on lara.asset_components for each row execute function lara.reject_mutation();

create table lara.recognition_schedules (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 kind text not null check (kind in ('depreciation','prepayment','deferred_revenue','recurring_invoice','recurring_journal','employee_deduction')),
 source_type text not null check (source_type in ('asset','document','journal_draft','party')),
 source_id uuid not null,
 start_date date not null,
 end_date date not null,
 basis_amount numeric(24,6) not null check (basis_amount > 0),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 method text not null check (method in ('straight_line','declining_balance','sum_of_years','ratable','recurring')),
 policy_version text not null check (length(policy_version) between 1 and 100),
 mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(mapping) = 'object'),
 state text not null default 'draft' check (state in ('draft','approved','paused','completed','rejected')),
 current_version_no integer not null default 1 check (current_version_no >= 1),
 approved_by uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (end_date >= start_date),
 check (state not in ('approved','paused','completed') or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index recognition_schedules_one_live on lara.recognition_schedules (tenant_id, entity_id, kind, source_id) where state not in ('rejected','completed');
create index recognition_schedules_queue on lara.recognition_schedules (tenant_id, entity_id, state, start_date);
create or replace function lara.recognition_schedules_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('completed','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % schedule is immutable', old.state using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('approved','rejected')) or
  (old.state = 'approved' and new.state in ('paused','completed')) or
  (old.state = 'paused' and new.state in ('approved','completed'))) then
  raise exception 'STATE_CONFLICT: schedule cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 -- The reviewed identity never changes; amounts and dates change through versions.
 if new.kind <> old.kind or new.source_id <> old.source_id or new.source_type <> old.source_type or new.book_id <> old.book_id or new.currency <> old.currency then
  raise exception 'STATE_CONFLICT: schedule identity is fixed' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger recognition_schedules_validate before update on lara.recognition_schedules for each row execute function lara.recognition_schedules_validate();
create trigger recognition_schedules_touch before update on lara.recognition_schedules for each row execute function lara.touch_row();

create table lara.schedule_versions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 schedule_id uuid not null,
 version_no integer not null check (version_no >= 1),
 effective_from date not null,
 start_date date not null,
 end_date date not null,
 method text not null check (method in ('straight_line','declining_balance','sum_of_years','ratable','recurring')),
 basis_amount numeric(24,6) not null check (basis_amount > 0),
 opening_recognized numeric(24,6) not null default 0 check (opening_recognized >= 0),
 policy_version text not null check (length(policy_version) between 1 and 100),
 mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(mapping) = 'object'),
 parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
 reason text not null check (length(btrim(reason)) between 1 and 2000),
 state text not null default 'draft' check (state in ('draft','approved','superseded','rejected')),
 approved_by uuid,
 checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, schedule_id, version_no),
 check (end_date >= start_date),
 check (effective_from >= start_date),
 check (state <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, schedule_id) references lara.recognition_schedules (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index schedule_versions_one_draft on lara.schedule_versions (tenant_id, schedule_id) where state = 'draft';
create or replace function lara.schedule_versions_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('approved','superseded','rejected') and (new.checksum <> old.checksum or new.method <> old.method or new.basis_amount <> old.basis_amount or new.effective_from <> old.effective_from or new.start_date <> old.start_date or new.end_date <> old.end_date or new.parameters <> old.parameters or new.mapping <> old.mapping) then
  raise exception 'STATE_CONFLICT: a reviewed schedule version is immutable; changes are a new prospective version' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('approved','rejected')) or
  (old.state = 'approved' and new.state = 'superseded')) then
  raise exception 'STATE_CONFLICT: schedule version cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger schedule_versions_validate before update on lara.schedule_versions for each row execute function lara.schedule_versions_validate();
create trigger schedule_versions_touch before update on lara.schedule_versions for each row execute function lara.touch_row();

create table lara.schedule_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 schedule_id uuid not null,
 version_id uuid not null,
 sequence integer not null check (sequence >= 1),
 period_start date not null check (extract(day from period_start) = 1),
 period_end date not null,
 amount numeric(24,6) not null check (amount >= 0),
 account_mapping jsonb not null default '{}'::jsonb check (jsonb_typeof(account_mapping) = 'object'),
 state text not null default 'planned' check (state in ('planned','posted','drafted','blocked','cancelled')),
 run_id uuid,
 posted_entry_id uuid,
 drafted_resource_type text check (drafted_resource_type is null or drafted_resource_type in ('journal','document')),
 drafted_resource_id uuid,
 task_id uuid,
 executed_at timestamptz,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, schedule_id, period_start),
 check (period_end >= period_start),
 check (state <> 'posted' or posted_entry_id is not null),
 check (state <> 'drafted' or (drafted_resource_type is not null and drafted_resource_id is not null)),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, schedule_id) references lara.recognition_schedules (tenant_id, entity_id, id),
 foreign key (tenant_id, version_id) references lara.schedule_versions (tenant_id, id),
 foreign key (tenant_id, task_id) references lara.tasks (tenant_id, id)
);
create index schedule_lines_period on lara.schedule_lines (tenant_id, entity_id, period_start, state);
create or replace function lara.schedule_lines_validate() returns trigger language plpgsql as $$
begin
 if tg_op = 'DELETE' then
  if old.state in ('posted','drafted') and not (current_setting('lara.maintenance', true) = 'teardown' and (
   exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper))
   or exists (select 1 from pg_tables where schemaname = tg_table_schema and tablename = tg_table_name and tableowner = current_user))) then
   raise exception 'STATE_CONFLICT: executed schedule lines are immutable' using errcode = 'check_violation';
  end if;
  return old;
 end if;
 if old.state in ('posted','drafted') and (new.state <> old.state or new.amount <> old.amount or new.period_start <> old.period_start or new.posted_entry_id is distinct from old.posted_entry_id or new.drafted_resource_id is distinct from old.drafted_resource_id) then
  raise exception 'STATE_CONFLICT: executed schedule lines are immutable' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'planned' and new.state in ('posted','drafted','blocked','cancelled')) or
  (old.state = 'blocked' and new.state in ('posted','drafted','planned','cancelled'))) then
  raise exception 'STATE_CONFLICT: schedule line cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger schedule_lines_validate before update or delete on lara.schedule_lines for each row execute function lara.schedule_lines_validate();

create table lara.schedule_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 period_id uuid not null,
 schedule_ids uuid[] not null check (cardinality(schedule_ids) >= 1),
 state text not null default 'queued' check (state in ('queued','running','completed','completed_with_tasks','failed')),
 job_id uuid,
 results jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array'),
 requested_by uuid not null,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, period_id) references lara.periods (tenant_id, id),
 foreign key (tenant_id, requested_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index schedule_runs_queue on lara.schedule_runs (tenant_id, entity_id, state, created_at);
create trigger schedule_runs_touch before update on lara.schedule_runs for each row execute function lara.touch_row();

-- Memo book and tax carrying amounts per asset and period; tax follows the
-- class tax rule independently of the book schedule and is reproducible from
-- the rule version.
create table lara.book_tax_layers (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 asset_id uuid not null,
 period_start date not null,
 book_depreciation numeric(24,6) not null check (book_depreciation >= 0),
 tax_depreciation numeric(24,6) not null check (tax_depreciation >= 0),
 book_value numeric(24,6) not null check (book_value >= 0),
 tax_value numeric(24,6) not null check (tax_value >= 0),
 rule_version text not null check (length(rule_version) between 1 and 100),
 line_id uuid,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, asset_id, period_start, rule_version),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, asset_id) references lara.assets (tenant_id, entity_id, id),
 foreign key (tenant_id, line_id) references lara.schedule_lines (tenant_id, id)
);
create trigger book_tax_layers_append_only before update or delete on lara.book_tax_layers for each row execute function lara.reject_mutation();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['asset_classes','assets','asset_events','asset_components','recognition_schedules','schedule_versions','schedule_lines','schedule_runs','book_tax_layers'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.asset_classes, lara.assets, lara.recognition_schedules, lara.schedule_versions, lara.schedule_runs to lara_api;
grant select, insert, update, delete on lara.schedule_lines to lara_api;
grant select, insert on lara.asset_events, lara.asset_components, lara.book_tax_layers to lara_api;
grant select on lara.asset_classes, lara.assets, lara.asset_events, lara.asset_components, lara.recognition_schedules, lara.schedule_versions, lara.schedule_lines, lara.schedule_runs, lara.book_tax_layers to lara_worker, lara_audit_reader;
-- The worker executes approved schedules: it posts lines, records layers,
-- rolls the register forward, creates the recurring drafts and raises tasks.
grant update on lara.schedule_lines, lara.schedule_runs, lara.recognition_schedules, lara.assets to lara_worker;
grant insert on lara.book_tax_layers, lara.journal_drafts, lara.documents, lara.document_lines, lara.document_relations, lara.tasks to lara_worker;
