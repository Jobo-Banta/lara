-- P09 multiple currencies and separate books: currency metadata, reviewed FX
-- rates, foreign-currency journals carrying both transaction and functional
-- amounts at the approved rate, open-item FX layers (remaining transaction
-- amount and functional carrying value), revaluation runs that post once per
-- rate set with a linked adjustment for a later set, separately permissioned
-- book partitions (RBU, FCDU, trust) and management views combined without
-- double counting. Existing entries are backfilled as transaction = functional
-- at rate 1; posted values never change.

create table lara.currency_metadata (
 code text primary key check (code ~ '^[A-Z]{3}$'),
 name text not null,
 minor_units integer not null check (minor_units between 0 and 6)
);
insert into lara.currency_metadata (code, name, minor_units) values
 ('PHP','Philippine peso',2),('USD','United States dollar',2),('EUR','Euro',2),('JPY','Japanese yen',0),('GBP','Pound sterling',2),('SGD','Singapore dollar',2),('HKD','Hong Kong dollar',2),('CNY','Chinese yuan',2),('AUD','Australian dollar',2),('CAD','Canadian dollar',2),('KRW','South Korean won',0),('AED','UAE dirham',2)
 on conflict (code) do nothing;
grant select on lara.currency_metadata to lara_api, lara_worker, lara_audit_reader;

-- Book partitions: the reviewed kinds; a management book is a view that never posts.
alter table lara.books drop constraint books_kind_check;
alter table lara.books add constraint books_kind_check check (kind in ('primary','separate','rbu','fcdu','trust','management'));

-- Book access: who may read or post a partition. A partition with any grant
-- is closed to everyone else; the primary book stays open to the entity.
create table lara.book_access (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 principal_id uuid not null,
 access text not null check (access in ('read','post')),
 granted_by uuid not null,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, book_id, principal_id, access),
 check (granted_by <> principal_id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, principal_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, granted_by) references lara.principals (tenant_id, id)
);
create index book_access_lookup on lara.book_access (tenant_id, book_id, principal_id);

-- Book links: how a source book enters a management view.
create table lara.book_links (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_book_id uuid not null,
 target_view_id uuid not null,
 translation_policy text not null check (translation_policy in ('as_is','closing_rate','exclude')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, source_book_id, target_view_id),
 check (source_book_id <> target_view_id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, source_book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, target_view_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);

-- Reviewed FX rates: one base/quote pair per date, quoted as units of the
-- quote currency per one unit of the base, approved by another principal
-- from source evidence; approved rates are immutable.
create table lara.fx_rates (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
 quote_currency text not null check (quote_currency ~ '^[A-Z]{3}$'),
 rate_date date not null,
 rate numeric(24,12) not null check (rate > 0),
 source_evidence_id uuid not null,
 status text not null default 'draft' check (status in ('draft','approved','rejected')),
 approved_by uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (base_currency <> quote_currency),
 check (status <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, source_evidence_id) references lara.evidence (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index fx_rates_one_approved on lara.fx_rates (tenant_id, entity_id, base_currency, quote_currency, rate_date) where status = 'approved';
create index fx_rates_lookup on lara.fx_rates (tenant_id, entity_id, base_currency, quote_currency, rate_date desc);
create or replace function lara.fx_rates_validate() returns trigger language plpgsql as $$
begin
 if old.status = 'approved' and (new.rate <> old.rate or new.rate_date <> old.rate_date or new.base_currency <> old.base_currency or new.quote_currency <> old.quote_currency or new.source_evidence_id <> old.source_evidence_id or new.status <> 'approved') then
  raise exception 'STATE_CONFLICT: approved FX rates are immutable; a correction is a new rate for the date' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not (old.status = 'draft' and new.status in ('approved','rejected')) and not (old.status = 'rejected' and new.status = 'draft') then
  raise exception 'STATE_CONFLICT: FX rate cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger fx_rates_validate before update on lara.fx_rates for each row execute function lara.fx_rates_validate();
create trigger fx_rates_touch before update on lara.fx_rates for each row execute function lara.touch_row();

-- Journals carry the approved rate they were translated at.
alter table lara.journal_entries add column fx_rate numeric(24,12) not null default 1 check (fx_rate > 0);
alter table lara.journal_entries add column fx_rate_id uuid;
alter table lara.journal_entries add constraint journal_entries_fx_rate_same_currency check (transaction_currency <> functional_currency or fx_rate = 1);

-- Open-item FX layers: append-only events; the latest row per open item is
-- the remaining transaction amount and the functional carrying value.
create table lara.fx_open_item_layers (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 open_item_id uuid not null,
 seq integer not null check (seq >= 1),
 event text not null check (event in ('open','settle','reverse','revalue')),
 settlement_id uuid,
 revaluation_id uuid,
 txn_consumed numeric(24,6) not null default 0,
 func_consumed numeric(24,6) not null default 0,
 realized_fx numeric(24,6) not null default 0,
 txn_remaining numeric(24,6) not null check (txn_remaining >= 0),
 func_carrying numeric(24,6) not null,
 rate numeric(24,12) not null check (rate > 0),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, open_item_id, seq),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, open_item_id) references lara.open_items (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger fx_open_item_layers_append_only before update or delete on lara.fx_open_item_layers for each row execute function lara.reject_mutation();

-- Revaluation runs: one effect per book, period, currency and rate set;
-- a later rate set adjusts the earlier run through a link, never a rewrite.
create table lara.revaluation_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 period_id uuid not null,
 rate_set_id uuid not null,
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 method text not null default 'closing_rate' check (method in ('closing_rate')),
 account_ids jsonb not null check (jsonb_typeof(account_ids) = 'array' and jsonb_array_length(account_ids) >= 1),
 reverse_next_period boolean not null default false,
 preview_json jsonb,
 adjusts_run_id uuid,
 entry_id uuid,
 reversal_entry_id uuid,
 state text not null default 'draft' check (state in ('draft','previewed','approved','posted','rejected')),
 approved_by uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 check (state <> 'posted' or entry_id is not null),
 check (state not in ('previewed','approved','posted') or preview_json is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, period_id) references lara.periods (tenant_id, id),
 foreign key (tenant_id, entity_id, rate_set_id) references lara.fx_rates (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, adjusts_run_id) references lara.revaluation_runs (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, entity_id, book_id, reversal_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index revaluation_runs_one_per_set on lara.revaluation_runs (tenant_id, book_id, period_id, rate_set_id) where state <> 'rejected';
create or replace function lara.revaluation_runs_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('approved','posted') and (new.account_ids <> old.account_ids or new.rate_set_id <> old.rate_set_id or new.preview_json is distinct from old.preview_json and old.state = 'posted') then
  raise exception 'STATE_CONFLICT: an approved revaluation is frozen; a new rate set is a linked run' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('previewed','rejected')) or
  (old.state = 'previewed' and new.state in ('approved','rejected','draft','previewed')) or
  (old.state = 'approved' and new.state in ('posted','rejected'))) then
  raise exception 'STATE_CONFLICT: revaluation cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if old.state = 'posted' and new.entry_id is distinct from old.entry_id then
  raise exception 'STATE_CONFLICT: a posted revaluation keeps its entry' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger revaluation_runs_validate before update on lara.revaluation_runs for each row execute function lara.revaluation_runs_validate();
create trigger revaluation_runs_touch before update on lara.revaluation_runs for each row execute function lara.touch_row();

-- Posting: a foreign-currency entry carries the approved rate and every line's
-- functional amount; the header totals are functional amounts.
-- functional amount (supplied by the owning module, residual on the last
-- line, or translated here at the rate); functional totals balance as well as
-- transaction totals. Management books never post; a partition with access
-- grants admits only its granted posters. Rates never default to 1 for a
-- foreign currency.
create or replace function lara.post_journal_entry(p jsonb) returns uuid
language plpgsql security definer set search_path = lara, pg_temp as $$
declare
 v_tenant uuid := (p->>'tenantId')::uuid; v_entity uuid := (p->>'entityId')::uuid; v_book uuid := (p->>'bookId')::uuid;
 v_date date := (p->>'accountingDate')::date; v_currency text := coalesce(p->>'currency','PHP');
 v_purpose text := coalesce(p->>'purpose','posting'); v_manual boolean := coalesce((p->>'manual')::boolean, false);
 v_allow_soft boolean := coalesce((p->>'allowSoftClosed')::boolean, false);
 v_rate numeric(24,12) := (p->>'rate')::numeric; v_rate_id uuid := (p->>'rateId')::uuid; v_actor uuid := (p->>'postingActor')::uuid;
 v_period lara.periods%rowtype; v_book_row lara.books%rowtype; v_acct lara.accounts%rowtype; v_branch uuid;
 v_line jsonb; v_no integer := 0; v_debit numeric(24,6); v_credit numeric(24,6); v_td numeric(24,6) := 0; v_tc numeric(24,6) := 0;
 v_fd numeric(24,6); v_fc numeric(24,6); v_ftd numeric(24,6) := 0; v_ftc numeric(24,6) := 0; v_fx boolean;
 v_hash text; v_existing lara.journal_entries%rowtype; v_id uuid; v_dim text; v_required text; v_children integer;
begin
 if nullif(current_setting('lara.tenant_id', true), '')::uuid is distinct from v_tenant then raise exception 'FORBIDDEN: posting outside the bound tenant' using errcode = 'insufficient_privilege'; end if;
 if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') < 2 then raise exception 'UNBALANCED_ENTRY: at least two lines are required' using errcode = 'check_violation'; end if;
 select * into v_book_row from lara.books where tenant_id = v_tenant and entity_id = v_entity and id = v_book;
 if v_book_row.id is null then raise exception 'NOT_FOUND: book' using errcode = 'foreign_key_violation'; end if;
 if v_book_row.status <> 'active' then raise exception 'STATE_CONFLICT: book is not active' using errcode = 'check_violation'; end if;
 if v_book_row.kind = 'management' then raise exception 'STATE_CONFLICT: a management view never posts; it combines its source books' using errcode = 'check_violation'; end if;
 if v_book_row.kind in ('rbu','fcdu','trust') and exists (select 1 from lara.book_access a where a.tenant_id = v_tenant and a.book_id = v_book)
  and not exists (select 1 from lara.book_access a where a.tenant_id = v_tenant and a.book_id = v_book and a.principal_id = v_actor and a.access = 'post') then
  raise exception 'FORBIDDEN: no posting access to book %', v_book_row.code using errcode = 'insufficient_privilege';
 end if;
 v_fx := v_currency <> v_book_row.functional_currency;
 if v_fx and v_rate is null then raise exception 'STATE_CONFLICT: no approved % / % rate for %; rates never default to 1', v_currency, v_book_row.functional_currency, v_date using errcode = 'check_violation'; end if;
 if not v_fx then v_rate := 1; v_rate_id := null; end if;
 -- Lock the period FOR SHARE so a concurrent close waits for or excludes this posting.
 select * into v_period from lara.periods where tenant_id = v_tenant and entity_id = v_entity and book_id = v_book and v_date between starts_on and ends_on for share;
 if v_period.id is null then raise exception 'PERIOD_LOCKED: no open period covers %', v_date using errcode = 'check_violation'; end if;
 -- Locked periods refuse every posting except the fiscal-year closing entry,
 -- which the close command issues once after all periods of the year are locked.
 if v_period.status = 'locked' and v_purpose <> 'closing' then raise exception 'PERIOD_LOCKED: period is locked' using errcode = 'check_violation'; end if;
 if v_period.status = 'soft_closed' and not v_allow_soft and v_purpose <> 'closing' then raise exception 'PERIOD_LOCKED: period is soft closed; use the adjustment workflow' using errcode = 'check_violation'; end if;
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
  -- Closing entries aggregate balances across dimensions and carry none.
  for v_required in select dimension_type from lara.account_dimension_rules r where r.tenant_id = v_tenant and r.account_id = v_acct.id and r.required and v_purpose <> 'closing' loop
   v_dim := v_line->'dimensions'->>v_required;
   if v_dim is null or not exists (select 1 from lara.dimensions d where d.tenant_id = v_tenant and d.entity_id = v_entity and d.type = v_required and d.id = v_dim::uuid and d.status = 'active') then
    raise exception 'VALIDATION_FAILED: account % requires dimension %', v_acct.code, v_required using errcode = 'check_violation';
   end if;
  end loop;
  v_td := v_td + v_debit; v_tc := v_tc + v_credit;
  if v_fx then
   v_fd := coalesce((v_line->>'funcDebit')::numeric, round(v_debit * v_rate, 2)); v_fc := coalesce((v_line->>'funcCredit')::numeric, round(v_credit * v_rate, 2));
   if (v_fd > 0) <> (v_debit > 0) or (v_fc > 0) <> (v_credit > 0) then raise exception 'UNBALANCED_ENTRY: line % functional side differs from its transaction side', v_no using errcode = 'check_violation'; end if;
   v_ftd := v_ftd + v_fd; v_ftc := v_ftc + v_fc;
  end if;
 end loop;
 if v_td <> v_tc then raise exception 'UNBALANCED_ENTRY: debits % differ from credits %', v_td, v_tc using errcode = 'check_violation'; end if;
 if v_fx and v_ftd <> v_ftc then raise exception 'UNBALANCED_ENTRY: functional debits % differ from credits %', v_ftd, v_ftc using errcode = 'check_violation'; end if;
 insert into lara.journal_entries (tenant_id, entity_id, book_id, source_type, source_id, source_version, purpose, accounting_date, document_date, description, period_id, transaction_currency, functional_currency, reversal_of, posting_actor, command_id, lines_hash, line_count, total_debit, total_credit, fx_rate, fx_rate_id)
  values (v_tenant, v_entity, v_book, p->>'sourceType', (p->>'sourceId')::uuid, (p->>'sourceVersion')::bigint, v_purpose, v_date, (p->>'documentDate')::date, p->>'description', v_period.id, v_currency, v_book_row.functional_currency, (p->>'reversalOf')::uuid, v_actor, (p->>'commandId')::uuid, v_hash, v_no, case when v_fx then v_ftd else v_td end, case when v_fx then v_ftc else v_tc end, v_rate, v_rate_id)
  returning id into v_id;
 v_no := 0;
 for v_line in select * from jsonb_array_elements(p->'lines') loop
  v_no := v_no + 1;
  v_debit := coalesce((v_line->>'debit')::numeric, 0); v_credit := coalesce((v_line->>'credit')::numeric, 0);
  if v_fx then v_fd := coalesce((v_line->>'funcDebit')::numeric, round(v_debit * v_rate, 2)); v_fc := coalesce((v_line->>'funcCredit')::numeric, round(v_credit * v_rate, 2)); else v_fd := v_debit; v_fc := v_credit; end if;
  insert into lara.journal_lines (tenant_id, entity_id, book_id, entry_id, line_no, account_id, branch_id, txn_debit, txn_credit, func_debit, func_credit, dimensions_json)
   values (v_tenant, v_entity, v_book, v_id, v_no, (v_line->>'accountId')::uuid, (v_line->>'branchId')::uuid, v_debit, v_credit, v_fd, v_fc, coalesce(v_line->'dimensions', '{}'::jsonb));
 end loop;
 return v_id;
end $$;
revoke all on function lara.post_journal_entry(jsonb) from public;
grant execute on function lara.post_journal_entry(jsonb) to lara_api, lara_worker;

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['book_access','book_links','fx_rates','fx_open_item_layers','revaluation_runs'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.fx_rates, lara.revaluation_runs to lara_api;
grant select, insert, update on lara.book_access, lara.book_links to lara_api;
grant select, insert on lara.fx_open_item_layers to lara_api;
grant select on lara.book_access, lara.book_links, lara.fx_rates, lara.fx_open_item_layers, lara.revaluation_runs to lara_worker, lara_audit_reader;
