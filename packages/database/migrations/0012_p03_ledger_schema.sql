-- P03 general ledger: chart of accounts, dimensions, periods, journals,
-- openings, report snapshots and close support. Journal rows are inserted
-- only through lara.post_journal_entry, which the runtime roles may execute
-- but whose tables they cannot write directly; posted rows are immutable for
-- every role. Money is numeric(24,6); PHP amounts carry two decimals.

-- Books gain the kinds named by the reviewed BookCreate schema.
alter table lara.books drop constraint books_kind_check;
alter table lara.books add constraint books_kind_check check (kind in ('primary','rbu','fcdu','trust','management','separate'));

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
create table lara.accounts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9.-]{0,31}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 category text not null check (category in ('asset','liability','equity','income','expense')),
 normal_side text not null check (normal_side in ('debit','credit')),
 parent_id uuid,
 control_type text not null default 'none' check (control_type in ('ar','ap','inventory','input_tax','output_tax','advance','none')),
 allow_manual boolean not null default true,
 status text not null default 'active' check (status in ('active','frozen','archived')),
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, book_id, id),
 unique (tenant_id, entity_id, book_id, code),
 check (normal_side = case when category in ('asset','expense') then 'debit' else 'credit' end),
 check (control_type = 'none' or allow_manual = false),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, parent_id) references lara.accounts (tenant_id, entity_id, book_id, id)
);
create index accounts_parent on lara.accounts (tenant_id, entity_id, book_id, parent_id);
-- Parent changes cannot form a cycle and a parent shares the child's category.
create or replace function lara.accounts_validate() returns trigger language plpgsql as $$
declare cursor_id uuid := new.parent_id; depth integer := 0; parent_category text;
begin
 if new.parent_id is not null then
  if new.parent_id = new.id then raise exception 'VALIDATION_FAILED: an account cannot be its own parent' using errcode = 'check_violation'; end if;
  select category into parent_category from lara.accounts where tenant_id = new.tenant_id and id = new.parent_id;
  if parent_category <> new.category then raise exception 'VALIDATION_FAILED: parent account must share the category' using errcode = 'check_violation'; end if;
  while cursor_id is not null loop
   depth := depth + 1;
   if depth > 32 then raise exception 'VALIDATION_FAILED: account hierarchy too deep' using errcode = 'check_violation'; end if;
   if cursor_id = new.id then raise exception 'VALIDATION_FAILED: account hierarchy cycle' using errcode = 'check_violation'; end if;
   select parent_id into cursor_id from lara.accounts where tenant_id = new.tenant_id and id = cursor_id;
  end loop;
 end if;
 if tg_op = 'UPDATE' and (new.code <> old.code or new.book_id <> old.book_id or new.category <> old.category) and exists (select 1 from lara.journal_lines l where l.tenant_id = old.tenant_id and l.account_id = old.id) then
  raise exception 'STATE_CONFLICT: accounts with postings keep their code, book and category' using errcode = 'check_violation';
 end if;
 return new;
end $$;

create table lara.account_dimension_rules (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 account_id uuid not null,
 dimension_type text not null check (dimension_type ~ '^[a-z][a-z0-9_]{0,31}$'),
 required boolean not null default true,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, account_id, dimension_type),
 foreign key (tenant_id, account_id) references lara.accounts (tenant_id, id)
);

create table lara.dimensions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 type text not null check (type ~ '^[a-z][a-z0-9_]{0,31}$'),
 code text not null check (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 parent_id uuid,
 status text not null default 'active' check (status in ('active','archived')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, type, code),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, parent_id) references lara.dimensions (tenant_id, entity_id, id)
);

-- ---------------------------------------------------------------------------
-- Periods: non-overlapping per book, open → soft_closed → locked, reopen bumps close_version.
-- ---------------------------------------------------------------------------
create table lara.periods (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 starts_on date not null,
 ends_on date not null,
 status text not null default 'open' check (status in ('open','soft_closed','locked')),
 close_version integer not null default 0 check (close_version >= 0),
 locked_by uuid,
 locked_at timestamptz,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, book_id, id),
 unique (tenant_id, entity_id, book_id, starts_on),
 check (ends_on >= starts_on),
 check (status <> 'locked' or (locked_by is not null and locked_at is not null)),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id)
);
create index periods_lookup on lara.periods (tenant_id, entity_id, book_id, starts_on, ends_on);
create or replace function lara.periods_validate() returns trigger language plpgsql as $$
begin
 if exists (select 1 from lara.periods p where p.tenant_id = new.tenant_id and p.book_id = new.book_id and p.id <> new.id and p.starts_on <= new.ends_on and p.ends_on >= new.starts_on) then
  raise exception 'STATE_CONFLICT: periods of a book cannot overlap' using errcode = 'check_violation';
 end if;
 if tg_op = 'UPDATE' then
  if new.status <> old.status and not (
   (old.status = 'open' and new.status = 'soft_closed') or
   (old.status = 'soft_closed' and new.status in ('open','locked')) or
   (old.status = 'locked' and new.status = 'open')) then
   raise exception 'STATE_CONFLICT: period cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;
  if old.status = 'locked' and new.status = 'open' and new.close_version <= old.close_version then
   raise exception 'STATE_CONFLICT: reopening a locked period starts a new close version' using errcode = 'check_violation';
  end if;
  if (new.starts_on <> old.starts_on or new.ends_on <> old.ends_on) and exists (select 1 from lara.journal_entries j where j.tenant_id = old.tenant_id and j.period_id = old.id) then
   raise exception 'STATE_CONFLICT: periods with postings keep their dates' using errcode = 'check_violation';
  end if;
 end if;
 return new;
end $$;

-- ---------------------------------------------------------------------------
-- Journals: append-only facts written only by the posting function.
-- ---------------------------------------------------------------------------
create table lara.journal_entries (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 source_type text not null check (source_type ~ '^[a-z][a-z0-9_]{0,63}$'),
 source_id uuid not null,
 source_version bigint not null check (source_version >= 1),
 purpose text not null default 'posting' check (purpose in ('posting','reversal','opening','closing','adjustment')),
 accounting_date date not null,
 document_date date,
 description text not null check (length(btrim(description)) between 1 and 500),
 period_id uuid not null,
 transaction_currency text not null check (transaction_currency ~ '^[A-Z]{3}$'),
 functional_currency text not null check (functional_currency ~ '^[A-Z]{3}$'),
 rate_version text,
 reversal_of uuid,
 posting_actor uuid,
 command_id uuid,
 lines_hash text not null check (lines_hash ~ '^[a-f0-9]{64}$'),
 line_count integer not null check (line_count >= 2),
 total_debit numeric(24,6) not null check (total_debit > 0),
 total_credit numeric(24,6) not null check (total_credit > 0),
 posted_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, book_id, id),
 unique (tenant_id, entity_id, book_id, source_type, source_id, source_version, purpose),
 check (total_debit = total_credit),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, period_id) references lara.periods (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, entity_id, book_id, reversal_of) references lara.journal_entries (tenant_id, entity_id, book_id, id)
);
create index journal_entries_date on lara.journal_entries (tenant_id, entity_id, book_id, accounting_date, id);
create index journal_entries_source on lara.journal_entries (tenant_id, entity_id, book_id, source_type, source_id);
create unique index journal_entries_one_reversal on lara.journal_entries (tenant_id, entity_id, book_id, reversal_of) where reversal_of is not null;

create table lara.journal_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 entry_id uuid not null,
 line_no integer not null check (line_no >= 1),
 account_id uuid not null,
 branch_id uuid not null,
 txn_debit numeric(24,6) not null default 0 check (txn_debit >= 0),
 txn_credit numeric(24,6) not null default 0 check (txn_credit >= 0),
 func_debit numeric(24,6) not null default 0 check (func_debit >= 0),
 func_credit numeric(24,6) not null default 0 check (func_credit >= 0),
 dimensions_json jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions_json) = 'object'),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, book_id, entry_id, line_no),
 check ((txn_debit > 0 and txn_credit = 0) or (txn_credit > 0 and txn_debit = 0)),
 check ((func_debit > 0 and func_credit = 0) or (func_credit > 0 and func_debit = 0)),
 check ((txn_debit > 0) = (func_debit > 0)),
 foreign key (tenant_id, entity_id, book_id, entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, entity_id, book_id, account_id) references lara.accounts (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id)
);
create index journal_lines_account on lara.journal_lines (tenant_id, entity_id, book_id, account_id, entry_id);
create trigger journal_entries_append_only before update or delete on lara.journal_entries for each row execute function lara.reject_mutation();
create trigger journal_lines_append_only before update or delete on lara.journal_lines for each row execute function lara.reject_mutation();

-- Header totals must equal the sum of lines at transaction end; a violated
-- deferred constraint aborts the whole posting transaction.
create or replace function lara.journal_balance_check() returns trigger language plpgsql as $$
declare e lara.journal_entries%rowtype; d numeric(24,6); c numeric(24,6); n integer; td numeric(24,6); tc numeric(24,6);
begin
 select * into e from lara.journal_entries where id = new.entry_id;
 select coalesce(sum(func_debit),0), coalesce(sum(func_credit),0), count(*), coalesce(sum(txn_debit),0), coalesce(sum(txn_credit),0) into d, c, n, td, tc from lara.journal_lines where entry_id = new.entry_id;
 if d <> c then raise exception 'UNBALANCED_ENTRY: functional debits % differ from credits %', d, c using errcode = 'check_violation'; end if;
 if n < 2 then raise exception 'UNBALANCED_ENTRY: a journal needs at least two lines' using errcode = 'check_violation'; end if;
 if e.transaction_currency = e.functional_currency and td <> tc then raise exception 'UNBALANCED_ENTRY: transaction debits differ from credits' using errcode = 'check_violation'; end if;
 if e.total_debit <> d or e.total_credit <> c or e.line_count <> n then raise exception 'UNBALANCED_ENTRY: header totals differ from lines' using errcode = 'check_violation'; end if;
 return null;
end $$;
create constraint trigger journal_lines_balance after insert on lara.journal_lines deferrable initially deferred for each row execute function lara.journal_balance_check();

-- The posting service. Validates period, accounts and dimensions after taking
-- locks, computes totals server-side and inserts header and lines. Retrying
-- the same source version with identical lines returns the existing entry;
-- different lines for the same source version are a duplicate-source conflict.
create or replace function lara.post_journal_entry(p jsonb) returns uuid
language plpgsql security definer set search_path = lara, pg_temp as $$
declare
 v_tenant uuid := (p->>'tenantId')::uuid; v_entity uuid := (p->>'entityId')::uuid; v_book uuid := (p->>'bookId')::uuid;
 v_date date := (p->>'accountingDate')::date; v_currency text := coalesce(p->>'currency','PHP');
 v_purpose text := coalesce(p->>'purpose','posting'); v_manual boolean := coalesce((p->>'manual')::boolean, false);
 v_allow_soft boolean := coalesce((p->>'allowSoftClosed')::boolean, false);
 v_period lara.periods%rowtype; v_book_row lara.books%rowtype; v_acct lara.accounts%rowtype; v_branch uuid;
 v_line jsonb; v_no integer := 0; v_debit numeric(24,6); v_credit numeric(24,6); v_td numeric(24,6) := 0; v_tc numeric(24,6) := 0;
 v_hash text; v_existing lara.journal_entries%rowtype; v_id uuid; v_dim text; v_required text; v_children integer;
begin
 if nullif(current_setting('lara.tenant_id', true), '')::uuid is distinct from v_tenant then raise exception 'FORBIDDEN: posting outside the bound tenant' using errcode = 'insufficient_privilege'; end if;
 if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') < 2 then raise exception 'UNBALANCED_ENTRY: at least two lines are required' using errcode = 'check_violation'; end if;
 select * into v_book_row from lara.books where tenant_id = v_tenant and entity_id = v_entity and id = v_book;
 if v_book_row.id is null then raise exception 'NOT_FOUND: book' using errcode = 'foreign_key_violation'; end if;
 if v_book_row.status <> 'active' then raise exception 'STATE_CONFLICT: book is not active' using errcode = 'check_violation'; end if;
 -- Lock the period FOR SHARE so a concurrent close waits for or excludes this posting.
 select * into v_period from lara.periods where tenant_id = v_tenant and entity_id = v_entity and book_id = v_book and v_date between starts_on and ends_on for share;
 if v_period.id is null then raise exception 'PERIOD_LOCKED: no open period covers %', v_date using errcode = 'check_violation'; end if;
 if v_period.status = 'locked' then raise exception 'PERIOD_LOCKED: period is locked' using errcode = 'check_violation'; end if;
 if v_period.status = 'soft_closed' and not v_allow_soft then raise exception 'PERIOD_LOCKED: period is soft closed; use the adjustment workflow' using errcode = 'check_violation'; end if;
 -- Canonical hash of the lines as supplied (order preserved).
 v_hash := encode(sha256(convert_to((p->'lines')::text || '|' || v_date::text || '|' || v_currency, 'UTF8')), 'hex');
 select * into v_existing from lara.journal_entries where tenant_id = v_tenant and entity_id = v_entity and book_id = v_book and source_type = p->>'sourceType' and source_id = (p->>'sourceId')::uuid and source_version = (p->>'sourceVersion')::bigint and purpose = v_purpose;
 if v_existing.id is not null then
  if v_existing.lines_hash = v_hash then return v_existing.id; end if;
  raise exception 'DUPLICATE_SOURCE: this source version already posted different lines' using errcode = 'unique_violation';
 end if;
 for v_line in select * from jsonb_array_elements(p->'lines') loop
  v_no := v_no + 1;
  v_debit := coalesce((v_line->>'debit')::numeric, 0); v_credit := coalesce((v_line->>'credit')::numeric, 0);
  if v_debit < 0 or v_credit < 0 or (v_debit > 0) = (v_credit > 0) then raise exception 'UNBALANCED_ENTRY: line % must have exactly one positive side', v_no using errcode = 'check_violation'; end if;
  select * into v_acct from lara.accounts where tenant_id = v_tenant and entity_id = v_entity and book_id = v_book and id = (v_line->>'accountId')::uuid for share;
  if v_acct.id is null then raise exception 'NOT_FOUND: account on line %', v_no using errcode = 'foreign_key_violation'; end if;
  if v_acct.status <> 'active' then raise exception 'STATE_CONFLICT: account % is %', v_acct.code, v_acct.status using errcode = 'check_violation'; end if;
  select count(*) into v_children from lara.accounts where tenant_id = v_tenant and parent_id = v_acct.id and status <> 'archived';
  if v_children > 0 then raise exception 'STATE_CONFLICT: account % is not a leaf', v_acct.code using errcode = 'check_violation'; end if;
  if v_manual and not v_acct.allow_manual then raise exception 'STATE_CONFLICT: account % accepts postings only from its owning module', v_acct.code using errcode = 'check_violation'; end if;
  select id into v_branch from lara.branches where tenant_id = v_tenant and entity_id = v_entity and id = (v_line->>'branchId')::uuid and status = 'active';
  if v_branch is null then raise exception 'NOT_FOUND: active branch on line %', v_no using errcode = 'foreign_key_violation'; end if;
  for v_required in select dimension_type from lara.account_dimension_rules r where r.tenant_id = v_tenant and r.account_id = v_acct.id and r.required loop
   v_dim := v_line->'dimensions'->>v_required;
   if v_dim is null or not exists (select 1 from lara.dimensions d where d.tenant_id = v_tenant and d.entity_id = v_entity and d.type = v_required and d.id = v_dim::uuid and d.status = 'active') then
    raise exception 'VALIDATION_FAILED: account % requires dimension %', v_acct.code, v_required using errcode = 'check_violation';
   end if;
  end loop;
  v_td := v_td + v_debit; v_tc := v_tc + v_credit;
 end loop;
 if v_td <> v_tc then raise exception 'UNBALANCED_ENTRY: debits % differ from credits %', v_td, v_tc using errcode = 'check_violation'; end if;
 if v_currency <> v_book_row.functional_currency then raise exception 'FEATURE_NOT_ENABLED: foreign-currency journals arrive with separate books' using errcode = 'check_violation'; end if;
 insert into lara.journal_entries (tenant_id, entity_id, book_id, source_type, source_id, source_version, purpose, accounting_date, document_date, description, period_id, transaction_currency, functional_currency, reversal_of, posting_actor, command_id, lines_hash, line_count, total_debit, total_credit)
  values (v_tenant, v_entity, v_book, p->>'sourceType', (p->>'sourceId')::uuid, (p->>'sourceVersion')::bigint, v_purpose, v_date, (p->>'documentDate')::date, p->>'description', v_period.id, v_currency, v_book_row.functional_currency, (p->>'reversalOf')::uuid, (p->>'postingActor')::uuid, (p->>'commandId')::uuid, v_hash, v_no, v_td, v_tc)
  returning id into v_id;
 v_no := 0;
 for v_line in select * from jsonb_array_elements(p->'lines') loop
  v_no := v_no + 1;
  v_debit := coalesce((v_line->>'debit')::numeric, 0); v_credit := coalesce((v_line->>'credit')::numeric, 0);
  insert into lara.journal_lines (tenant_id, entity_id, book_id, entry_id, line_no, account_id, branch_id, txn_debit, txn_credit, func_debit, func_credit, dimensions_json)
   values (v_tenant, v_entity, v_book, v_id, v_no, (v_line->>'accountId')::uuid, (v_line->>'branchId')::uuid, v_debit, v_credit, v_debit, v_credit, coalesce(v_line->'dimensions', '{}'::jsonb));
 end loop;
 return v_id;
end $$;
revoke all on function lara.post_journal_entry(jsonb) from public;

-- Balances: sum of posted functional lines by account up to a cutoff.
create or replace function lara.account_balances(p_tenant uuid, p_entity uuid, p_book uuid, p_from date, p_to date, p_cutoff timestamptz)
returns table (account_id uuid, code text, name text, category text, normal_side text, debit numeric(24,6), credit numeric(24,6), balance numeric(24,6))
language sql stable as $$
 select a.id, a.code, a.name, a.category, a.normal_side,
  coalesce(sum(l.func_debit),0), coalesce(sum(l.func_credit),0),
  case when a.normal_side = 'debit' then coalesce(sum(l.func_debit),0) - coalesce(sum(l.func_credit),0) else coalesce(sum(l.func_credit),0) - coalesce(sum(l.func_debit),0) end
 from lara.accounts a
 left join lara.journal_entries e on e.tenant_id = a.tenant_id and e.book_id = a.book_id and e.accounting_date between p_from and p_to and e.posted_at <= p_cutoff
 left join lara.journal_lines l on l.entry_id = e.id and l.account_id = a.id
 where a.tenant_id = p_tenant and a.entity_id = p_entity and a.book_id = p_book
 group by a.id, a.code, a.name, a.category, a.normal_side
 order by a.code
$$;

-- ---------------------------------------------------------------------------
-- Openings and source imports
-- ---------------------------------------------------------------------------
create table lara.opening_batches (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 kind text not null check (kind in ('masters','openings','journal','bank_statement','inventory','assets','payroll_tax','tax_adjustments','payroll','marketplace','pos','source_balances')),
 evidence_id uuid not null,
 checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
 cutoff date not null,
 source_id text not null check (length(source_id) between 1 and 200),
 external_batch_id text not null check (length(external_batch_id) between 1 and 200),
 mapping_version text not null check (length(mapping_version) between 1 and 100),
 state text not null default 'staged' check (state in ('staged','validated','approved','committed','rejected')),
 row_count integer not null default 0 check (row_count >= 0),
 error_count integer not null default 0 check (error_count >= 0),
 debit_total numeric(24,6) not null default 0 check (debit_total >= 0),
 credit_total numeric(24,6) not null default 0 check (credit_total >= 0),
 approved_by uuid,
 committed_entry_id uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, book_id, source_id, checksum, cutoff),
 check (state <> 'approved' or approved_by is not null),
 check (state <> 'committed' or (approved_by is not null and committed_entry_id is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, evidence_id) references lara.evidence (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, committed_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id)
);
-- The same external batch with a different checksum is a conflict, never a duplicate success.
create unique index opening_batches_external on lara.opening_batches (tenant_id, entity_id, book_id, source_id, external_batch_id) where state <> 'rejected';
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
  if new.state = 'committed' and new.debit_total <> new.credit_total then raise exception 'UNBALANCED_ENTRY: opening totals differ' using errcode = 'check_violation'; end if;
 end if;
 return new;
end $$;

create table lara.opening_rows (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 batch_id uuid not null,
 row_no integer not null check (row_no >= 1),
 source_key text not null check (length(source_key) between 1 and 200),
 account_code text not null,
 account_id uuid,
 branch_code text not null,
 branch_id uuid,
 accounting_date date not null,
 debit numeric(24,6) not null default 0 check (debit >= 0),
 credit numeric(24,6) not null default 0 check (credit >= 0),
 dimensions_json jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions_json) = 'object'),
 evidence_id uuid,
 status text not null default 'staged' check (status in ('staged','valid','error','quarantined')),
 error text,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, batch_id, source_key),
 unique (tenant_id, entity_id, batch_id, row_no),
 check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0)),
 check (status <> 'error' or error is not null),
 foreign key (tenant_id, entity_id, batch_id) references lara.opening_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id)
);

create table lara.source_control_balances (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 batch_id uuid not null,
 control_account_id uuid not null,
 detail_total numeric(24,6) not null,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, batch_id, control_account_id),
 foreign key (tenant_id, entity_id, batch_id) references lara.opening_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, control_account_id) references lara.accounts (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Reports and close
-- ---------------------------------------------------------------------------
create table lara.report_snapshots (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 report_type text not null check (report_type ~ '^[a-z][a-z0-9_]{0,63}$'),
 period_key text not null check (period_key ~ '^[0-9]{4}(-[0-9]{2}){0,2}(-Q[1-4])?$'),
 version_number integer not null check (version_number >= 1),
 cutoff_posted_at timestamptz not null,
 rule_version text not null check (length(rule_version) between 1 and 100),
 parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
 payload jsonb not null,
 checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
 evidence_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, book_id, report_type, period_key, version_number),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, evidence_id) references lara.evidence (tenant_id, entity_id, id)
);
create trigger report_snapshots_append_only before update or delete on lara.report_snapshots for each row execute function lara.reject_mutation();

create table lara.close_tasks (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 period_id uuid not null,
 close_version integer not null default 0 check (close_version >= 0),
 requirement text not null check (requirement ~ '^[a-z][a-z0-9_]{0,63}$'),
 required boolean not null default true,
 owner_id uuid,
 status text not null default 'open' check (status in ('open','complete','waived')),
 evidence_id uuid,
 waiver_reason text,
 completed_by uuid,
 completed_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, period_id, close_version, requirement),
 check (status <> 'complete' or (evidence_id is not null and completed_by is not null and completed_at is not null)),
 check (status <> 'waived' or (waiver_reason is not null and required = false)),
 foreign key (tenant_id, period_id) references lara.periods (tenant_id, id),
 foreign key (tenant_id, entity_id, evidence_id) references lara.evidence (tenant_id, entity_id, id),
 foreign key (tenant_id, owner_id) references lara.principals (tenant_id, id)
);

create table lara.substantiations (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 period_id uuid not null,
 account_id uuid not null,
 preparer_id uuid not null,
 reviewer_id uuid,
 evidence_id uuid,
 state text not null default 'prepared' check (state in ('prepared','reviewed','rejected')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, period_id, account_id),
 check (state <> 'reviewed' or (reviewer_id is not null and evidence_id is not null)),
 check (reviewer_id is null or reviewer_id <> preparer_id),
 foreign key (tenant_id, period_id) references lara.periods (tenant_id, id),
 foreign key (tenant_id, account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, entity_id, evidence_id) references lara.evidence (tenant_id, entity_id, id),
 foreign key (tenant_id, preparer_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, reviewer_id) references lara.principals (tenant_id, id)
);

create table lara.statement_mappings (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 account_id uuid not null,
 statement text not null check (statement in ('balance_sheet','income_statement','cash_flow','equity')),
 line_code text not null check (line_code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 version_number integer not null default 1 check (version_number >= 1),
 status text not null default 'draft' check (status in ('draft','approved','superseded')),
 approved_by uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, account_id, statement, version_number),
 check (status <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);

create table lara.journal_templates (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) >= 2),
 effective_from date not null,
 status text not null default 'active' check (status in ('active','archived')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, book_id, code, effective_from),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id)
);

-- Draft journals before posting live in documents-like drafts with the
-- published document state machine; posting writes the immutable entry.
create table lara.journal_drafts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 accounting_date date not null,
 document_date date not null,
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 description text not null check (length(btrim(description)) between 1 and 500),
 lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) >= 2),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
 status text not null default 'draft' check (status in ('draft','submitted','changes_requested','approved','posted','cancelled')),
 submitted_by uuid,
 approved_by uuid,
 posted_entry_id uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, book_id, id),
 check (status <> 'posted' or posted_entry_id is not null),
 check (approved_by is null or (approved_by <> created_by and approved_by is distinct from submitted_by)),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, posted_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id)
);
create index journal_drafts_queue on lara.journal_drafts (tenant_id, entity_id, book_id, status, created_at, id);
create or replace function lara.journal_drafts_validate() returns trigger language plpgsql as $$
begin
 if tg_op = 'UPDATE' then
  if old.status = 'posted' then raise exception 'STATE_CONFLICT: posted journals are immutable; create a reversal' using errcode = 'check_violation'; end if;
  if old.status = 'cancelled' and new.status <> 'cancelled' then raise exception 'STATE_CONFLICT: cancelled journals stay cancelled' using errcode = 'check_violation'; end if;
  if new.status <> old.status and not (
   (old.status = 'draft' and new.status in ('submitted','cancelled')) or
   (old.status = 'submitted' and new.status in ('approved','changes_requested','cancelled','draft')) or
   (old.status = 'changes_requested' and new.status = 'draft') or
   (old.status = 'approved' and new.status in ('posted','draft'))) then
   raise exception 'STATE_CONFLICT: journal cannot move from % to %', old.status, new.status using errcode = 'check_violation';
  end if;
  -- Material edits after submission return the journal to draft.
  if new.content_hash <> old.content_hash and new.status not in ('draft','cancelled') then
   raise exception 'STATE_CONFLICT: edited journals return to draft before approval' using errcode = 'check_violation';
  end if;
 end if;
 return new;
end $$;

-- Row version triggers and validators
create trigger accounts_validate before insert or update on lara.accounts for each row execute function lara.accounts_validate();
create trigger accounts_touch before update on lara.accounts for each row execute function lara.touch_row();
create trigger dimensions_touch before update on lara.dimensions for each row execute function lara.touch_row();
create trigger periods_validate before insert or update on lara.periods for each row execute function lara.periods_validate();
create trigger periods_touch before update on lara.periods for each row execute function lara.touch_row();
create trigger opening_batches_validate before update on lara.opening_batches for each row execute function lara.opening_batches_validate();
create trigger opening_batches_touch before update on lara.opening_batches for each row execute function lara.touch_row();
create trigger close_tasks_touch before update on lara.close_tasks for each row execute function lara.touch_row();
create trigger substantiations_touch before update on lara.substantiations for each row execute function lara.touch_row();
create trigger statement_mappings_touch before update on lara.statement_mappings for each row execute function lara.touch_row();
create trigger journal_templates_touch before update on lara.journal_templates for each row execute function lara.touch_row();
create trigger journal_drafts_validate before update on lara.journal_drafts for each row execute function lara.journal_drafts_validate();
create trigger journal_drafts_touch before update on lara.journal_drafts for each row execute function lara.touch_row();
create trigger account_dimension_rules_append_only before update on lara.account_dimension_rules for each row execute function lara.reject_mutation();
create trigger source_control_balances_append_only before update or delete on lara.source_control_balances for each row execute function lara.reject_mutation();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['accounts','account_dimension_rules','dimensions','periods','journal_entries','journal_lines','opening_batches','opening_rows','source_control_balances','report_snapshots','close_tasks','substantiations','statement_mappings','journal_templates','journal_drafts'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.accounts, lara.dimensions, lara.periods, lara.opening_batches, lara.opening_rows, lara.close_tasks, lara.substantiations, lara.statement_mappings, lara.journal_templates, lara.journal_drafts to lara_api;
grant select, insert on lara.account_dimension_rules, lara.source_control_balances, lara.report_snapshots to lara_api;
grant select on lara.journal_entries, lara.journal_lines to lara_api;
grant select on all tables in schema lara to lara_worker, lara_audit_reader;
grant insert on lara.report_snapshots to lara_worker;
grant execute on function lara.post_journal_entry(jsonb) to lara_api, lara_worker;
grant execute on function lara.account_balances(uuid, uuid, uuid, date, date, timestamptz) to lara_api, lara_worker, lara_audit_reader;
