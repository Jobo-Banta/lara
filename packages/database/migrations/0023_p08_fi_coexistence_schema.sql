-- P08 financial institution coexistence: named source systems, approved source
-- ownership windows per book and transaction family, reviewed account mapping
-- versions, canonical source batches with manifests and staged rows tied to
-- the import pipeline, expected batches with deadlines, source balance
-- snapshots, tax instrument facts and branch roll-up manifests. Core banking,
-- valuation, lending and ECL stay in their authoritative systems; nothing here
-- is seeded for a live institution.

-- Source systems: the named authoritative systems a pilot institution feeds from.
create table lara.source_systems (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 owner_name text not null check (length(btrim(owner_name)) between 1 and 200),
 owner_principal_id uuid,
 granularity text not null check (granularity in ('detail','summary')),
 cutoff_timezone text not null default 'Asia/Manila' check (length(cutoff_timezone) between 1 and 64),
 feed_format text not null default 'lara-feed-1' check (length(feed_format) between 1 and 40),
 status text not null default 'active' check (status in ('active','archived')),
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
 foreign key (tenant_id, owner_principal_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger source_systems_touch before update on lara.source_systems for each row execute function lara.touch_row();

-- Source ownership: which system owns a transaction family in a book for a
-- window; ingestion requires an approved window effective on the cutoff.
create table lara.source_ownership (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 source_system text not null check (source_system ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 transaction_family text not null check (transaction_family ~ '^[a-z][a-z0-9_]{0,63}$'),
 effective_from date not null,
 effective_to date,
 evidence_ids jsonb not null check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 status text not null default 'draft' check (status in ('draft','approved','rejected','archived')),
 approved_by uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (effective_to is null or effective_to >= effective_from),
 check (status <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index source_ownership_lookup on lara.source_ownership (tenant_id, entity_id, book_id, transaction_family, effective_from);
create or replace function lara.source_ownership_validate() returns trigger language plpgsql as $$
declare clash uuid;
begin
 if old.status in ('approved','archived') and (new.book_id <> old.book_id or new.source_system <> old.source_system or new.transaction_family <> old.transaction_family or new.effective_from <> old.effective_from or new.effective_to is distinct from old.effective_to or new.evidence_ids <> old.evidence_ids) then
  raise exception 'STATE_CONFLICT: approved source ownership is immutable; a change is a new record' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not (
  (old.status = 'draft' and new.status in ('approved','rejected')) or
  (old.status = 'rejected' and new.status = 'draft') or
  (old.status = 'approved' and new.status = 'archived')) then
  raise exception 'STATE_CONFLICT: source ownership cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 if new.status = 'approved' and old.status <> 'approved' then
  select id into clash from lara.source_ownership o where o.tenant_id = new.tenant_id and o.entity_id = new.entity_id and o.book_id = new.book_id and o.transaction_family = new.transaction_family and o.status = 'approved' and o.id <> new.id
   and daterange(o.effective_from, coalesce(o.effective_to, date '9999-12-31'), '[]') && daterange(new.effective_from, coalesce(new.effective_to, date '9999-12-31'), '[]') limit 1;
  if clash is not null then raise exception 'STATE_CONFLICT: source ownership % already covers this family and window', clash using errcode = 'check_violation'; end if;
 end if;
 return new;
end $$;
create trigger source_ownership_validate before update on lara.source_ownership for each row execute function lara.source_ownership_validate();
create trigger source_ownership_touch before update on lara.source_ownership for each row execute function lara.touch_row();

-- Mapping versions: reviewed CSV evidence mapping source accounts to target
-- accounts, dimensions and tax profiles; lines freeze once approved.
create table lara.mapping_versions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_system_id uuid not null,
 version_label text not null check (length(version_label) between 1 and 100),
 evidence_id uuid not null,
 hash text not null check (hash ~ '^[a-f0-9]{64}$'),
 line_count integer not null default 0 check (line_count >= 0),
 status text not null default 'draft' check (status in ('draft','approved','rejected','superseded')),
 approved_by uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, source_system_id, version_label),
 check (status <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, source_system_id) references lara.source_systems (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, evidence_id) references lara.evidence (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index mapping_versions_one_approved on lara.mapping_versions (tenant_id, entity_id, source_system_id, version_label) where status = 'approved';
create or replace function lara.mapping_versions_validate() returns trigger language plpgsql as $$
begin
 if old.status in ('approved','superseded') and (new.hash <> old.hash or new.evidence_id <> old.evidence_id or new.line_count <> old.line_count) then
  raise exception 'STATE_CONFLICT: approved mapping versions are immutable; a change is a new version' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not (
  (old.status = 'draft' and new.status in ('approved','rejected')) or
  (old.status = 'approved' and new.status = 'superseded')) then
  raise exception 'STATE_CONFLICT: mapping version cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger mapping_versions_validate before update on lara.mapping_versions for each row execute function lara.mapping_versions_validate();
create trigger mapping_versions_touch before update on lara.mapping_versions for each row execute function lara.touch_row();
create table lara.mapping_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 mapping_version_id uuid not null,
 source_account text not null check (length(source_account) between 1 and 100),
 target_account_id uuid not null,
 dimensions_json jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions_json) = 'object'),
 tax_profile text check (tax_profile is null or tax_profile ~ '^[a-z][a-z0-9_]{0,63}$'),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, mapping_version_id, source_account),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, mapping_version_id) references lara.mapping_versions (tenant_id, entity_id, id),
 foreign key (tenant_id, target_account_id) references lara.accounts (tenant_id, id)
);
create or replace function lara.mapping_lines_guard() returns trigger language plpgsql as $$
declare mv_state text;
begin
 if tg_op = 'DELETE' and current_setting('lara.maintenance', true) = 'teardown' and (exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper)) or exists (select 1 from pg_tables where schemaname = tg_table_schema and tablename = tg_table_name and tableowner = current_user)) then return old; end if;
 select status into mv_state from lara.mapping_versions where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.mapping_version_id, old.mapping_version_id);
 if mv_state in ('approved','superseded') then raise exception 'STATE_CONFLICT: lines of an approved mapping version are frozen' using errcode = 'check_violation'; end if;
 if tg_op = 'DELETE' then return old; end if;
 return new;
end $$;
create trigger mapping_lines_guard before insert or update or delete on lara.mapping_lines for each row execute function lara.mapping_lines_guard();

-- Source batches: one per import of a canonical feed, identified by the
-- source's external batch id; the manifest is declared by the source and
-- checked against the staged rows. A batch posts once; a correction is a
-- linked replacement, never an overwrite.
create table lara.source_batches (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 source_system_id uuid not null,
 import_id uuid not null,
 kind text not null check (kind in ('journal','source_balances')),
 external_batch_id text not null check (length(external_batch_id) between 1 and 200),
 checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
 mapping_version_id uuid,
 atomic boolean not null default true,
 manifest_json jsonb not null default '{}'::jsonb check (jsonb_typeof(manifest_json) = 'object'),
 row_count integer not null default 0 check (row_count >= 0),
 error_count integer not null default 0 check (error_count >= 0),
 debit_total numeric(24,6) not null default 0 check (debit_total >= 0),
 credit_total numeric(24,6) not null default 0 check (credit_total >= 0),
 currency_totals jsonb not null default '{}'::jsonb check (jsonb_typeof(currency_totals) = 'object'),
 duplicate_count integer not null default 0 check (duplicate_count >= 0),
 replaces_batch_id uuid,
 replaced_by_batch_id uuid,
 posted_entry_id uuid,
 reversal_entry_id uuid,
 state text not null default 'staged' check (state in ('staged','validated','approved','posted','rejected','replaced')),
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, import_id),
 check (state <> 'posted' or kind <> 'journal' or posted_entry_id is not null),
 check (replaces_batch_id is null or replaces_batch_id <> id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, source_system_id) references lara.source_systems (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, import_id) references lara.opening_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, mapping_version_id) references lara.mapping_versions (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, replaces_batch_id) references lara.source_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, replaced_by_batch_id) references lara.source_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, posted_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, entity_id, book_id, reversal_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index source_batches_external on lara.source_batches (tenant_id, entity_id, source_system_id, external_batch_id) where state <> 'rejected';
create index source_batches_queue on lara.source_batches (tenant_id, entity_id, state, created_at);
create or replace function lara.source_batches_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('posted','replaced') and (new.checksum <> old.checksum or new.manifest_json <> old.manifest_json or new.external_batch_id <> old.external_batch_id or new.debit_total <> old.debit_total or new.credit_total <> old.credit_total or new.posted_entry_id is distinct from old.posted_entry_id) then
  raise exception 'STATE_CONFLICT: posted source batches are immutable; a correction is a linked replacement' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'staged' and new.state in ('validated','rejected')) or
  (old.state = 'validated' and new.state in ('approved','rejected','staged')) or
  (old.state = 'approved' and new.state in ('posted','rejected','staged')) or
  (old.state = 'posted' and new.state = 'replaced')) then
  raise exception 'STATE_CONFLICT: source batch cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if new.state = 'approved' and old.state <> 'approved' and new.error_count > 0 then
  raise exception 'STATE_CONFLICT: a batch with % error(s) cannot be approved', new.error_count using errcode = 'check_violation';
 end if;
 if new.state = 'replaced' and new.replaced_by_batch_id is null then
  raise exception 'STATE_CONFLICT: a replaced batch names its replacement' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger source_batches_validate before update on lara.source_batches for each row execute function lara.source_batches_validate();
create trigger source_batches_touch before update on lara.source_batches for each row execute function lara.touch_row();

-- Staged canonical rows; re-validation replaces them while the batch is
-- staged or validated, and they freeze once the batch is approved.
create table lara.source_rows (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 batch_id uuid not null,
 row_no integer not null check (row_no >= 1),
 external_line_id text not null check (length(external_line_id) between 1 and 200),
 accounting_date date,
 book_code text not null default '',
 branch_code text not null default '',
 branch_id uuid,
 account_code text not null default '',
 target_account_id uuid,
 currency text not null default '' check (currency = '' or currency ~ '^[A-Z]{3}$'),
 debit numeric(24,6) not null default 0 check (debit >= 0),
 credit numeric(24,6) not null default 0 check (credit >= 0),
 source_document_ref text not null default '',
 dimensions_json jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions_json) = 'object'),
 tax_event_ref text,
 instrument_ref text,
 instrument_type text,
 maturity_date date,
 income_category text,
 status text not null default 'valid' check (status in ('valid','error')),
 error text,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, batch_id, external_line_id),
 check (status <> 'error' or error is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, batch_id) references lara.source_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id),
 foreign key (tenant_id, target_account_id) references lara.accounts (tenant_id, id)
);
create index source_rows_batch on lara.source_rows (tenant_id, batch_id, row_no);
create or replace function lara.source_rows_guard() returns trigger language plpgsql as $$
declare b_state text;
begin
 if tg_op = 'DELETE' and current_setting('lara.maintenance', true) = 'teardown' and (exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper)) or exists (select 1 from pg_tables where schemaname = tg_table_schema and tablename = tg_table_name and tableowner = current_user)) then return old; end if;
 select state into b_state from lara.source_batches where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.batch_id, old.batch_id);
 if b_state in ('approved','posted','replaced') then raise exception 'STATE_CONFLICT: rows of an approved source batch are frozen' using errcode = 'check_violation'; end if;
 if tg_op = 'DELETE' then return old; end if;
 return new;
end $$;
create trigger source_rows_guard before insert or update or delete on lara.source_rows for each row execute function lara.source_rows_guard();

-- Expected batches: the feed calendar; a missing batch after its deadline
-- raises a required close task on the affected period only.
create table lara.expected_batches (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_system_id uuid not null,
 book_id uuid not null,
 kind text not null default 'journal' check (kind in ('journal','source_balances')),
 period_start date not null,
 period_end date not null,
 deadline_at timestamptz not null,
 state text not null default 'expected' check (state in ('expected','received','missing','waived')),
 received_batch_id uuid,
 close_task_id uuid,
 waiver_reason text,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, source_system_id, kind, period_start),
 check (period_end >= period_start),
 check (state <> 'received' or received_batch_id is not null),
 check (state <> 'waived' or waiver_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, source_system_id) references lara.source_systems (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, received_batch_id) references lara.source_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, close_task_id) references lara.close_tasks (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index expected_batches_due on lara.expected_batches (tenant_id, entity_id, state, deadline_at);
create trigger expected_batches_touch before update on lara.expected_batches for each row execute function lara.touch_row();

-- Source balance snapshots: subsidiary ledger balances declared by the source
-- at a cutoff, reconciled against the mapped control accounts. Append-only.
create table lara.source_balance_snapshots (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_system_id uuid not null,
 batch_id uuid not null,
 book_id uuid not null,
 account_code text not null check (length(account_code) between 1 and 100),
 target_account_id uuid,
 branch_code text not null default '',
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 balance numeric(24,6) not null,
 cutoff date not null,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, source_system_id, account_code, branch_code, currency, cutoff),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, source_system_id) references lara.source_systems (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, batch_id) references lara.source_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, target_account_id) references lara.accounts (tenant_id, id)
);
create trigger source_balance_snapshots_append_only before update or delete on lara.source_balance_snapshots for each row execute function lara.reject_mutation();

-- Tax instrument facts: what the institution's instruments did, from the
-- feed, classified later through reviewed rules. A replaced batch supersedes
-- its facts; nothing is edited in place.
create table lara.tax_instrument_facts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_system_id uuid not null,
 batch_id uuid not null,
 row_id uuid not null,
 instrument_ref text not null check (length(instrument_ref) between 1 and 200),
 instrument_type text not null check (instrument_type in ('loan','deposit','lease','share_issuance','security','other')),
 maturity_date date,
 amount numeric(24,6) not null check (amount > 0),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 income_category text not null check (income_category ~ '^[a-z][a-z0-9_]{0,63}$'),
 event_date date not null,
 tax_event_ref text,
 status text not null default 'active' check (status in ('active','superseded')),
 superseded_by_batch_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, row_id),
 check (maturity_date is null or maturity_date >= event_date),
 check (status <> 'superseded' or superseded_by_batch_id is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, source_system_id) references lara.source_systems (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, batch_id) references lara.source_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, row_id) references lara.source_rows (tenant_id, id),
 foreign key (tenant_id, entity_id, superseded_by_batch_id) references lara.source_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index tax_instrument_facts_period on lara.tax_instrument_facts (tenant_id, entity_id, status, event_date);
create or replace function lara.tax_instrument_facts_validate() returns trigger language plpgsql as $$
begin
 if new.instrument_ref <> old.instrument_ref or new.amount <> old.amount or new.event_date <> old.event_date or new.income_category <> old.income_category or new.maturity_date is distinct from old.maturity_date or new.instrument_type <> old.instrument_type then
  raise exception 'STATE_CONFLICT: instrument facts are immutable; a corrected batch supersedes them' using errcode = 'check_violation';
 end if;
 if old.status = 'superseded' and new.status <> 'superseded' then raise exception 'STATE_CONFLICT: superseded facts stay superseded' using errcode = 'check_violation'; end if;
 return new;
end $$;
create trigger tax_instrument_facts_validate before update on lara.tax_instrument_facts for each row execute function lara.tax_instrument_facts_validate();
create trigger tax_instrument_facts_touch before update on lara.tax_instrument_facts for each row execute function lara.touch_row();

-- Branch roll-ups: an immutable manifest of per-branch totals, interbranch
-- pairs and the entity roll-up at a cutoff, with its checksum.
create table lara.branch_rollups (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 period_start date not null,
 period_end date not null,
 cutoff_at timestamptz not null default now(),
 checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
 manifest_json jsonb not null check (jsonb_typeof(manifest_json) = 'object'),
 snapshot_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 check (period_end >= period_start),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index branch_rollups_period on lara.branch_rollups (tenant_id, entity_id, book_id, period_start, created_at);
create trigger branch_rollups_append_only before update or delete on lara.branch_rollups for each row execute function lara.reject_mutation();

-- Source-fed imports commit without a journal entry when they carry balances.
create or replace function lara.opening_batches_validate() returns trigger language plpgsql as $$
begin
 if tg_op = 'UPDATE' then
  if old.state = 'committed' and (new.state <> 'committed' or new.checksum <> old.checksum or new.debit_total <> old.debit_total or new.credit_total <> old.credit_total) then
   raise exception 'STATE_CONFLICT: committed imports are immutable' using errcode = 'check_violation';
  end if;
  if new.state <> old.state and not (
   (old.state = 'staged' and new.state in ('validated','rejected')) or
   (old.state = 'validated' and new.state in ('approved','rejected','staged')) or
   (old.state = 'approved' and new.state in ('committed','rejected','staged'))) then
   raise exception 'STATE_CONFLICT: import cannot move from % to %', old.state, new.state using errcode = 'check_violation';
  end if;
  if new.state = 'committed' and new.kind not in ('bank_statement','source_balances') and new.debit_total <> new.credit_total then raise exception 'UNBALANCED_ENTRY: opening totals differ' using errcode = 'check_violation'; end if;
 end if;
 return new;
end $$;
alter table lara.opening_batches drop constraint opening_batches_committed_check;
alter table lara.opening_batches add constraint opening_batches_committed_check check (state <> 'committed' or (approved_by is not null and (committed_entry_id is not null or kind in ('bank_statement','source_balances'))));

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['source_systems','source_ownership','mapping_versions','mapping_lines','source_batches','source_rows','expected_batches','source_balance_snapshots','tax_instrument_facts','branch_rollups'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.source_systems, lara.source_ownership, lara.mapping_versions, lara.source_batches, lara.expected_batches, lara.tax_instrument_facts to lara_api;
grant select, insert, delete on lara.mapping_lines, lara.source_rows to lara_api;
grant select, insert on lara.source_balance_snapshots, lara.branch_rollups to lara_api;
grant select on lara.source_systems, lara.source_ownership, lara.mapping_versions, lara.mapping_lines, lara.source_batches, lara.source_rows, lara.expected_batches, lara.source_balance_snapshots, lara.tax_instrument_facts, lara.branch_rollups to lara_worker, lara_audit_reader;
grant update on lara.expected_batches to lara_worker;
grant insert on lara.branch_rollups to lara_worker;
