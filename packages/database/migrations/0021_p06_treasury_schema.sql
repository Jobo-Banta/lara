-- P06 treasury: bank accounts (reviewed, encrypted number), bank statement
-- batches and lines imported through the P03 import pipeline (opening + signed
-- lines = closing, single-use source line keys per account), reconciliation
-- matches whose confirmed amounts never overlap on a statement line or a
-- settlement, check instruments with the custody/deposit/clear/dishonor
-- machine, transfers between bank accounts posted as one entry, cash sessions
-- with denomination counts, variance and an independent handover, and bank
-- file runs generated once per released payment. No table here moves money:
-- runs and releases record what was generated and what the bank reported.

create table lara.bank_accounts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 ledger_account_id uuid not null,
 bank_code text not null check (bank_code ~ '^[A-Z0-9]{3,20}$'),
 encrypted_number text not null check (length(encrypted_number) between 1 and 2000),
 number_hash text not null check (number_hash ~ '^[a-f0-9]{64}$'),
 number_last4 text not null check (number_last4 ~ '^[A-Za-z0-9]{1,4}$'),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 evidence_ids jsonb not null check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 status text not null default 'draft' check (status in ('draft','approved','rejected','archived')),
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
 unique (tenant_id, entity_id, bank_code, number_hash),
 check (status <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, ledger_account_id) references lara.accounts (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);
create index bank_accounts_list on lara.bank_accounts (tenant_id, entity_id, status, created_at, id);
create or replace function lara.bank_accounts_validate() returns trigger language plpgsql as $$
begin
 if old.status = 'approved' and (new.encrypted_number <> old.encrypted_number or new.bank_code <> old.bank_code or new.ledger_account_id <> old.ledger_account_id or new.currency <> old.currency or new.book_id <> old.book_id) and new.status = 'approved' then
  raise exception 'STATE_CONFLICT: approved bank accounts change through a new draft and approval' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not ((old.status = 'draft' and new.status in ('approved','rejected')) or (old.status = 'approved' and new.status in ('draft','archived')) or (old.status = 'rejected' and new.status = 'draft')) then
  raise exception 'STATE_CONFLICT: bank account cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger bank_accounts_validate before update on lara.bank_accounts for each row execute function lara.bank_accounts_validate();
create trigger bank_accounts_touch before update on lara.bank_accounts for each row execute function lara.touch_row();

-- Settlements name the bank account they move through (P05 kept the column as an opaque reference).
alter table lara.settlements add constraint settlements_bank_account_fk foreign key (tenant_id, entity_id, bank_account_id) references lara.bank_accounts (tenant_id, entity_id, id) not valid;

-- Statement batches derive from a committed bank_statement import; lines
-- keep the source text and are single-use per account and source line key.
create table lara.bank_statement_batches (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 bank_account_id uuid not null,
 import_id uuid not null,
 from_date date not null,
 to_date date not null,
 source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
 opening_balance numeric(24,6) not null,
 closing_balance numeric(24,6) not null,
 line_count integer not null check (line_count >= 0),
 duplicate_count integer not null default 0 check (duplicate_count >= 0),
 state text not null default 'committed' check (state in ('committed','reconciled')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, import_id),
 unique (tenant_id, bank_account_id, source_hash),
 check (to_date >= from_date),
 foreign key (tenant_id, entity_id, bank_account_id) references lara.bank_accounts (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, import_id) references lara.opening_batches (tenant_id, entity_id, id)
);
create table lara.bank_statement_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 bank_account_id uuid not null,
 batch_id uuid not null,
 source_line_key text not null check (length(source_line_key) between 1 and 200),
 booked_date date not null,
 value_date date,
 signed_amount numeric(24,6) not null check (signed_amount <> 0),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 reference text,
 description text,
 source_json jsonb not null check (jsonb_typeof(source_json) = 'object'),
 match_state text not null default 'unmatched' check (match_state in ('unmatched','partially_matched','matched')),
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, bank_account_id, source_line_key),
 foreign key (tenant_id, entity_id, bank_account_id) references lara.bank_accounts (tenant_id, entity_id, id),
 foreign key (tenant_id, batch_id) references lara.bank_statement_batches (tenant_id, id)
);
create index bank_statement_lines_queue on lara.bank_statement_lines (tenant_id, bank_account_id, match_state, booked_date, id);
create or replace function lara.bank_statement_lines_guard() returns trigger language plpgsql as $$
begin
 if new.signed_amount <> old.signed_amount or new.booked_date <> old.booked_date or new.source_line_key <> old.source_line_key or new.bank_account_id <> old.bank_account_id or new.reference is distinct from old.reference or new.source_json <> old.source_json then
  raise exception 'STATE_CONFLICT: statement lines keep their source content' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger bank_statement_lines_guard before update on lara.bank_statement_lines for each row execute function lara.bank_statement_lines_guard();
create trigger bank_statement_batches_append_only before update or delete on lara.bank_statement_batches for each row execute function lara.reject_mutation();

-- Reconciliation matches: statement lines against settlements or journal
-- entries. Confirmed allocations are rows the guard checks against the line
-- amounts and the counterpart amounts, so confirmed amounts never overlap.
create table lara.reconciliation_matches (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 bank_account_id uuid not null,
 statement_line_ids jsonb not null check (jsonb_typeof(statement_line_ids) = 'array' and jsonb_array_length(statement_line_ids) >= 1),
 allocations jsonb not null check (jsonb_typeof(allocations) = 'array' and jsonb_array_length(allocations) >= 1),
 reason text,
 origin text not null default 'manual' check (origin in ('manual','proposed')),
 state text not null default 'draft' check (state in ('draft','proposed','confirmed','rejected','reversed')),
 confirmed_by uuid,
 reversal_reason text,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state <> 'confirmed' or confirmed_by is not null),
 check (state <> 'reversed' or reversal_reason is not null),
 foreign key (tenant_id, entity_id, bank_account_id) references lara.bank_accounts (tenant_id, entity_id, id),
 foreign key (tenant_id, confirmed_by) references lara.principals (tenant_id, id)
);
create index reconciliation_matches_queue on lara.reconciliation_matches (tenant_id, entity_id, bank_account_id, state, created_at, id);
create or replace function lara.reconciliation_matches_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('confirmed','reversed') and (new.statement_line_ids <> old.statement_line_ids or new.allocations <> old.allocations or new.content_hash <> old.content_hash) then
  raise exception 'STATE_CONFLICT: confirmed matches are immutable; reverse them' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state in ('draft','proposed') and new.state in ('confirmed','rejected','draft')) or
  (old.state = 'confirmed' and new.state = 'reversed')) then
  raise exception 'STATE_CONFLICT: match cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if new.state = 'confirmed' and new.confirmed_by = new.created_by and new.origin = 'manual' then
  raise exception 'SELF_APPROVAL: the preparer of a match cannot confirm it' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger reconciliation_matches_validate before update on lara.reconciliation_matches for each row execute function lara.reconciliation_matches_validate();
create trigger reconciliation_matches_touch before update on lara.reconciliation_matches for each row execute function lara.touch_row();

-- Confirmed allocations, one row per line and counterpart, append-only; the
-- guard refuses any confirmation that would exceed a statement line's
-- amount or a counterpart's bank movement. Reversal rows mirror one apply.
create table lara.reconciliation_allocations (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 match_id uuid not null,
 line_id uuid not null,
 resource_type text not null check (resource_type in ('settlement','journal')),
 resource_id uuid not null,
 amount numeric(24,6) not null check (amount > 0),
 action text not null check (action in ('apply','reverse')),
 reverses_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 check ((action = 'reverse') = (reverses_id is not null)),
 foreign key (tenant_id, entity_id, match_id) references lara.reconciliation_matches (tenant_id, entity_id, id),
 foreign key (tenant_id, line_id) references lara.bank_statement_lines (tenant_id, id),
 foreign key (tenant_id, reverses_id) references lara.reconciliation_allocations (tenant_id, id)
);
create unique index reconciliation_allocations_one_reverse on lara.reconciliation_allocations (tenant_id, reverses_id) where reverses_id is not null;
create index reconciliation_allocations_line on lara.reconciliation_allocations (tenant_id, line_id);
create index reconciliation_allocations_resource on lara.reconciliation_allocations (tenant_id, resource_type, resource_id);
create trigger reconciliation_allocations_append_only before update or delete on lara.reconciliation_allocations for each row execute function lara.reject_mutation();
create or replace function lara.line_matched(p_tenant uuid, p_line uuid) returns numeric(24,6) language sql stable as $$
 select coalesce(sum(case when action = 'apply' then amount else -amount end), 0) from lara.reconciliation_allocations where tenant_id = p_tenant and line_id = p_line
$$;
create or replace function lara.resource_matched(p_tenant uuid, p_type text, p_id uuid) returns numeric(24,6) language sql stable as $$
 select coalesce(sum(case when action = 'apply' then amount else -amount end), 0) from lara.reconciliation_allocations where tenant_id = p_tenant and resource_type = p_type and resource_id = p_id
$$;
grant execute on function lara.line_matched(uuid, uuid), lara.resource_matched(uuid, text, uuid) to lara_api, lara_worker, lara_audit_reader;
create or replace function lara.reconciliation_allocations_guard() returns trigger language plpgsql as $$
declare line lara.bank_statement_lines%rowtype; original lara.reconciliation_allocations%rowtype; used numeric(24,6); capacity numeric(24,6); s lara.settlements%rowtype;
begin
 select * into line from lara.bank_statement_lines where tenant_id = new.tenant_id and id = new.line_id for update;
 if line.id is null then raise exception 'NOT_FOUND: statement line' using errcode = 'foreign_key_violation'; end if;
 if new.action = 'apply' then
  used := lara.line_matched(new.tenant_id, line.id);
  if used + new.amount > abs(line.signed_amount) then raise exception 'ALLOCATION_EXCEEDS_BALANCE: statement line unmatched % is below %', abs(line.signed_amount) - used, new.amount using errcode = 'check_violation'; end if;
  if new.resource_type = 'settlement' then
   select * into s from lara.settlements where tenant_id = new.tenant_id and id = new.resource_id for update;
   if s.id is null then raise exception 'NOT_FOUND: settlement' using errcode = 'foreign_key_violation'; end if;
   if s.state <> 'posted' then raise exception 'STATE_CONFLICT: only posted settlements reconcile' using errcode = 'check_violation'; end if;
   if (s.direction = 'receipt') <> (line.signed_amount > 0) then raise exception 'VALIDATION_FAILED: receipts match credits and payments match debits' using errcode = 'check_violation'; end if;
   if s.currency <> line.currency then raise exception 'VALIDATION_FAILED: settlement and statement currencies differ' using errcode = 'check_violation'; end if;
   capacity := s.cash_amount;
  else
   select coalesce(sum(abs(l.txn_debit - l.txn_credit)), 0) into capacity from lara.journal_lines l join lara.bank_accounts b on b.tenant_id = l.tenant_id and b.ledger_account_id = l.account_id where l.tenant_id = new.tenant_id and l.entry_id = new.resource_id and b.id = line.bank_account_id;
   if capacity = 0 then raise exception 'VALIDATION_FAILED: the journal entry has no line on this bank account' using errcode = 'check_violation'; end if;
  end if;
  used := lara.resource_matched(new.tenant_id, new.resource_type, new.resource_id);
  if used + new.amount > capacity then raise exception 'ALLOCATION_EXCEEDS_BALANCE: counterpart unmatched % is below %', capacity - used, new.amount using errcode = 'check_violation'; end if;
 else
  select * into original from lara.reconciliation_allocations where tenant_id = new.tenant_id and id = new.reverses_id;
  if original.id is null or original.action <> 'apply' or original.line_id <> new.line_id or original.resource_type <> new.resource_type or original.resource_id <> new.resource_id or original.amount <> new.amount or original.match_id <> new.match_id then
   raise exception 'STATE_CONFLICT: a reverse must mirror one apply of the same match, line and counterpart' using errcode = 'check_violation';
  end if;
 end if;
 return new;
end $$;
create trigger reconciliation_allocations_guard before insert on lara.reconciliation_allocations for each row execute function lara.reconciliation_allocations_guard();
create or replace function lara.bank_statement_lines_refresh() returns trigger language plpgsql as $$
declare line lara.bank_statement_lines%rowtype; used numeric(24,6);
begin
 select * into line from lara.bank_statement_lines where tenant_id = new.tenant_id and id = new.line_id;
 used := lara.line_matched(new.tenant_id, line.id);
 update lara.bank_statement_lines set match_state = case when used <= 0 then 'unmatched' when used >= abs(signed_amount) then 'matched' else 'partially_matched' end where tenant_id = new.tenant_id and id = line.id;
 return null;
end $$;
create trigger reconciliation_allocations_refresh after insert on lara.reconciliation_allocations for each row execute function lara.bank_statement_lines_refresh();

-- Check instruments: received checks are custody only until they clear;
-- issued checks are released to the payee and clear at the bank. Numbers are
-- unique per bank account and direction; a check never clears twice.
create table lara.check_instruments (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 direction text not null check (direction in ('received','issued')),
 bank_account_id uuid not null,
 check_number text not null check (length(btrim(check_number)) between 1 and 50),
 party_id uuid not null,
 amount numeric(24,6) not null check (amount > 0),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 due_date date not null,
 settlement_id uuid,
 replaces_id uuid,
 state text not null check (state in ('custody','drafted','released','deposited','cleared','dishonored','cancelled')),
 state_reason text,
 cleared_at timestamptz,
 dishonor_entry_id uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, bank_account_id, direction, check_number),
 check (state <> 'cleared' or cleared_at is not null),
 foreign key (tenant_id, entity_id, bank_account_id) references lara.bank_accounts (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, replaces_id) references lara.check_instruments (tenant_id, entity_id, id)
);
create index check_instruments_calendar on lara.check_instruments (tenant_id, entity_id, direction, state, due_date, id);
create or replace function lara.check_instruments_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('dishonored','cancelled') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: check is terminal in state %', old.state using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'custody' and new.state in ('deposited','cancelled')) or
  (old.state = 'deposited' and new.state in ('cleared','dishonored')) or
  (old.state = 'drafted' and new.state in ('released','cancelled')) or
  (old.state = 'released' and new.state in ('cleared','dishonored','cancelled')) or
  (old.state = 'cleared' and new.state = 'dishonored')) then
  raise exception 'STATE_CONFLICT: check cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if old.state not in ('custody','drafted') and (new.amount <> old.amount or new.check_number <> old.check_number or new.party_id <> old.party_id or new.bank_account_id <> old.bank_account_id or new.direction <> old.direction) then
  raise exception 'STATE_CONFLICT: a check in circulation keeps its number, party and amount' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger check_instruments_validate before update on lara.check_instruments for each row execute function lara.check_instruments_validate();
create trigger check_instruments_touch before update on lara.check_instruments for each row execute function lara.touch_row();

-- Transfers between two bank accounts of one book post both sides in one entry.
create table lara.transfers (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 from_account_id uuid not null,
 to_account_id uuid not null,
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 amount numeric(24,6) not null check (amount > 0),
 value_date date not null,
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
 state text not null default 'draft' check (state in ('draft','submitted','approved','posted','cancelled')),
 submitted_by uuid,
 approved_by uuid,
 posted_entry_id uuid,
 payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (from_account_id <> to_account_id),
 check (state <> 'posted' or posted_entry_id is not null),
 check (approved_by is null or (approved_by <> created_by and approved_by is distinct from submitted_by)),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, from_account_id) references lara.bank_accounts (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, to_account_id) references lara.bank_accounts (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, posted_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id)
);
create or replace function lara.transfers_validate() returns trigger language plpgsql as $$
begin
 if old.state = 'posted' and (new.amount <> old.amount or new.from_account_id <> old.from_account_id or new.to_account_id <> old.to_account_id or new.value_date <> old.value_date or new.payload_hash <> old.payload_hash or new.posted_entry_id <> old.posted_entry_id) then
  raise exception 'STATE_CONFLICT: posted transfers are immutable' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('submitted','cancelled')) or
  (old.state = 'submitted' and new.state in ('approved','draft','cancelled')) or
  (old.state = 'approved' and new.state in ('posted','draft'))) then
  raise exception 'STATE_CONFLICT: transfer cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if new.payload_hash <> old.payload_hash and new.state not in ('draft','cancelled') then
  raise exception 'STATE_CONFLICT: edited transfers return to draft before approval' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger transfers_validate before update on lara.transfers for each row execute function lara.transfers_validate();
create trigger transfers_touch before update on lara.transfers for each row execute function lara.touch_row();

-- Cash sessions: opened per branch and cashier for a business date, counted
-- by denomination, closed with the variance explained, handed over by an
-- independent incoming cashier who attests to the counted value.
create table lara.cash_sessions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 branch_id uuid not null,
 cashier_id uuid not null,
 business_date date not null,
 opening_amount numeric(24,6) not null check (opening_amount >= 0),
 expected_amount numeric(24,6),
 counted_amount numeric(24,6),
 variance numeric(24,6),
 variance_reason text,
 variance_entry_id uuid,
 state text not null default 'open' check (state in ('open','counted','closed','handed_over')),
 opened_at timestamptz not null default now(),
 closed_at timestamptz,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state not in ('counted','closed','handed_over') or (expected_amount is not null and counted_amount is not null and variance is not null)),
 check (state not in ('closed','handed_over') or closed_at is not null),
 check (variance is null or variance = 0 or variance_reason is not null),
 foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id),
 foreign key (tenant_id, cashier_id) references lara.principals (tenant_id, id)
);
create unique index cash_sessions_one_open on lara.cash_sessions (tenant_id, entity_id, branch_id, cashier_id, business_date) where state <> 'handed_over';
create or replace function lara.cash_sessions_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('closed','handed_over') and (new.counted_amount <> old.counted_amount or new.expected_amount <> old.expected_amount or new.variance <> old.variance or new.opening_amount <> old.opening_amount) then
  raise exception 'STATE_CONFLICT: counted values are never overwritten after close' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'open' and new.state = 'counted') or
  (old.state = 'counted' and new.state in ('closed','open')) or
  (old.state = 'closed' and new.state = 'handed_over')) then
  raise exception 'STATE_CONFLICT: cash session cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger cash_sessions_validate before update on lara.cash_sessions for each row execute function lara.cash_sessions_validate();
create trigger cash_sessions_touch before update on lara.cash_sessions for each row execute function lara.touch_row();
create table lara.cash_count_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 session_id uuid not null,
 count_no integer not null check (count_no >= 1),
 denomination numeric(24,6) not null check (denomination > 0),
 quantity integer not null check (quantity >= 0),
 primary key (id),
 unique (tenant_id, session_id, count_no, denomination),
 foreign key (tenant_id, session_id) references lara.cash_sessions (tenant_id, id)
);
create trigger cash_count_lines_append_only before update or delete on lara.cash_count_lines for each row execute function lara.reject_mutation();
create table lara.cash_handovers (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 session_id uuid not null,
 outgoing_id uuid not null,
 incoming_id uuid not null,
 decision text not null check (decision in ('approve','reject')),
 attestations jsonb not null check (jsonb_typeof(attestations) = 'object'),
 reason text,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 check (outgoing_id <> incoming_id),
 foreign key (tenant_id, session_id) references lara.cash_sessions (tenant_id, id),
 foreign key (tenant_id, outgoing_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, incoming_id) references lara.principals (tenant_id, id)
);
create trigger cash_handovers_append_only before update or delete on lara.cash_handovers for each row execute function lara.reject_mutation();

-- Bank file runs: one locked file per release command, hashed and stored as
-- evidence; items name the payments it carries. Generated versus accepted
-- versus settled is what the payment orders record.
create table lara.bank_file_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 bank_account_id uuid not null,
 format_version text not null check (length(format_version) between 1 and 100),
 file_hash text not null check (file_hash ~ '^[a-f0-9]{64}$'),
 export_evidence_id uuid,
 item_count integer not null check (item_count >= 1),
 total_amount numeric(24,6) not null check (total_amount > 0),
 state text not null default 'generated' check (state in ('generated','accepted','rejected')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, bank_account_id, file_hash),
 foreign key (tenant_id, entity_id, bank_account_id) references lara.bank_accounts (tenant_id, entity_id, id),
 foreign key (tenant_id, export_evidence_id) references lara.evidence (tenant_id, id)
);
create table lara.bank_file_items (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 run_id uuid not null,
 payment_id uuid not null,
 amount numeric(24,6) not null check (amount > 0),
 primary key (id),
 unique (tenant_id, run_id, payment_id),
 unique (tenant_id, payment_id),
 foreign key (tenant_id, run_id) references lara.bank_file_runs (tenant_id, id),
 foreign key (tenant_id, payment_id) references lara.payment_orders (tenant_id, id)
);
create trigger bank_file_items_append_only before update or delete on lara.bank_file_items for each row execute function lara.reject_mutation();
create or replace function lara.bank_file_runs_guard() returns trigger language plpgsql as $$
begin
 if new.file_hash <> old.file_hash or new.bank_account_id <> old.bank_account_id or new.item_count <> old.item_count or new.total_amount <> old.total_amount then
  raise exception 'STATE_CONFLICT: generated files are immutable' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and old.state <> 'generated' then
  raise exception 'STATE_CONFLICT: bank file run is terminal in state %', old.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger bank_file_runs_guard before update on lara.bank_file_runs for each row execute function lara.bank_file_runs_guard();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['bank_accounts','bank_statement_batches','bank_statement_lines','reconciliation_matches','reconciliation_allocations','check_instruments','transfers','cash_sessions','cash_count_lines','cash_handovers','bank_file_runs','bank_file_items'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.bank_accounts, lara.bank_statement_lines, lara.reconciliation_matches, lara.check_instruments, lara.transfers, lara.cash_sessions, lara.bank_file_runs to lara_api;
grant select, insert on lara.bank_statement_batches, lara.reconciliation_allocations, lara.cash_count_lines, lara.cash_handovers, lara.bank_file_items to lara_api;
grant select on lara.bank_accounts, lara.bank_statement_batches, lara.bank_statement_lines, lara.reconciliation_matches, lara.reconciliation_allocations, lara.check_instruments, lara.transfers, lara.cash_sessions, lara.cash_count_lines, lara.cash_handovers, lara.bank_file_runs, lara.bank_file_items to lara_worker, lara_audit_reader;
grant insert on lara.reconciliation_matches to lara_worker;
grant update (state) on lara.bank_file_runs to lara_worker;

-- Bank statement imports commit without a journal entry: their totals are the
-- credited and debited statement amounts, which need not balance.
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
  if new.state = 'committed' and new.kind <> 'bank_statement' and new.debit_total <> new.credit_total then raise exception 'UNBALANCED_ENTRY: opening totals differ' using errcode = 'check_violation'; end if;
 end if;
 return new;
end $$;
alter table lara.opening_batches drop constraint opening_batches_check1;
alter table lara.opening_batches add constraint opening_batches_committed_check check (state <> 'committed' or (approved_by is not null and (committed_entry_id is not null or kind = 'bank_statement')));
