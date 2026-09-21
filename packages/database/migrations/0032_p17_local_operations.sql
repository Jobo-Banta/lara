-- P17 local operations feature releases, each behind its own capability:
-- P17A leases (lessor billing on a recurring schedule with escalation
-- steps, deposits and advances held as liabilities until an approved
-- application or refund, withholding by approved profile version);
-- P17B statutory discounts (approved eligibility per party and category on
-- identity evidence with expiry, discount lines per document that follow
-- the approved profile's golden cases); P17C marketplace and POS
-- (channels, payout batches whose gross less fees, withholding and other
-- deductions equals the net, reconciled to imported sales, POS machines and
-- X/Z closings matched to deposits); P17D payroll data (imported batches
-- whose employee records tie to the batch totals, restricted records,
-- remittances per agency on evidence); P17E local obligations (authority
-- profiles, obligations with due dates, payment and filing evidence).
-- Nothing here calculates payroll or files with a government office.

insert into lara.capability_definitions (code, phase, title, depends_on) values
 ('leases', 'P17A', 'Lease billing', array['sales', 'assets']::text[]),
 ('statutory_discounts', 'P17B', 'Statutory discounts', array['sales', 'compliance']::text[]),
 ('marketplace_pos', 'P17C', 'Marketplace and POS integration', array['sales', 'treasury']::text[]),
 ('payroll_data', 'P17D', 'Payroll data and remittances', array['general_ledger', 'compliance']::text[]),
 ('local_obligations', 'P17E', 'Local obligations', array['purchasing', 'compliance']::text[]);

insert into lara.permission_definitions (code) values
 ('channel.create'), ('channel.edit'), ('channel.read'),
 ('payout.create'), ('payout.read'), ('payout.reconcile'), ('payout.post'),
 ('pos_closing.create'), ('pos_closing.read'), ('pos_closing.approve'),
 ('payroll_batch.create'), ('payroll_batch.read'), ('payroll_batch.approve'), ('payroll_batch.post'),
 ('payroll_record.read'),
 ('remittance.create'), ('remittance.read'), ('remittance.approve'),
 ('local_obligation.create'), ('local_obligation.edit'), ('local_obligation.read'), ('local_obligation.complete');

-- ---------------------------------------------------------------------------
-- P17A leases
-- ---------------------------------------------------------------------------
create table lara.lease_contracts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 party_id uuid not null,
 start_date date not null,
 end_date date not null,
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 deposit numeric(20,6) not null check (deposit >= 0),
 advance numeric(20,6) not null check (advance >= 0),
 billing_schedule_id uuid not null,
 withholding_profile_version text not null check (length(withholding_profile_version) between 1 and 100),
 escalation_json jsonb not null default '[]'::jsonb check (jsonb_typeof(escalation_json) = 'array'),
 base_rent numeric(20,6) not null check (base_rent > 0),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 state text not null default 'draft' check (state in ('draft','approved','ended','rejected')),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, billing_schedule_id),
 check (end_date > start_date),
 check (state <> 'approved' or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, billing_schedule_id) references lara.recognition_schedules (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.lease_contracts_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('ended','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % lease is final', old.state using errcode = 'check_violation';
 end if;
 if old.state = 'approved' and (new.content_hash <> old.content_hash) then
  raise exception 'STATE_CONFLICT: an approved lease keeps its terms; an amendment is a new lease' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not ((old.state = 'draft' and new.state in ('approved','rejected')) or (old.state = 'approved' and new.state = 'ended')) then
  raise exception 'STATE_CONFLICT: lease cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger lease_contracts_validate before update on lara.lease_contracts for each row execute function lara.lease_contracts_validate();
create trigger lease_contracts_touch before update on lara.lease_contracts for each row execute function lara.touch_row();

-- Deposits and advances received, applied and refunded; each event carries
-- the entry it posted and the document or settlement it touched.
create table lara.lease_events (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 lease_id uuid not null,
 kind text not null check (kind in ('deposit_received','deposit_applied','deposit_refunded','advance_received','advance_applied','rent_billed','escalation')),
 amount numeric(20,6) not null check (amount >= 0),
 event_date date not null,
 entry_id uuid,
 document_id uuid,
 settlement_id uuid,
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
 reason text,
 approved_by uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 check (kind not in ('deposit_applied','deposit_refunded','advance_applied') or approved_by is not null),
 foreign key (tenant_id, entity_id, lease_id) references lara.lease_contracts (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index lease_events_lease on lara.lease_events (tenant_id, lease_id, kind);
create trigger lease_events_append_only before update or delete on lara.lease_events for each row execute function lara.reject_mutation();

-- ---------------------------------------------------------------------------
-- P17B statutory discounts
-- ---------------------------------------------------------------------------
create table lara.discount_eligibility (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 party_id uuid not null,
 category text not null check (category ~ '^[a-z][a-z0-9_]{0,31}$'),
 profile_version text not null check (length(profile_version) between 1 and 100),
 valid_until date not null,
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 id_reference_masked text,
 state text not null default 'draft' check (state in ('draft','approved','rejected','revoked')),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state <> 'approved' or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index discount_eligibility_one_live on lara.discount_eligibility (tenant_id, entity_id, party_id, category) where state in ('draft','approved');
create or replace function lara.discount_eligibility_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('rejected','revoked') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % eligibility is final', old.state using errcode = 'check_violation';
 end if;
 if old.state = 'approved' and new.content_hash <> old.content_hash then
  raise exception 'STATE_CONFLICT: an approved eligibility is immutable; revoke it and record another' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not ((old.state = 'draft' and new.state in ('approved','rejected','revoked')) or (old.state = 'approved' and new.state = 'revoked')) then
  raise exception 'STATE_CONFLICT: eligibility cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger discount_eligibility_validate before update on lara.discount_eligibility for each row execute function lara.discount_eligibility_validate();
create trigger discount_eligibility_touch before update on lara.discount_eligibility for each row execute function lara.touch_row();

-- The discount applied per document line: basis, rate, amount and the
-- exemption profile, from the approved eligibility and profile version.
create table lara.discount_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 document_id uuid not null,
 line_no integer not null check (line_no >= 1),
 eligibility_id uuid not null,
 category text not null,
 profile_version text not null,
 basis numeric(20,6) not null check (basis >= 0),
 rate numeric(9,6) not null check (rate >= 0 and rate <= 1),
 amount numeric(20,6) not null check (amount >= 0),
 exemption_profile text,
 golden_case_id text,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, document_id, line_no),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, eligibility_id) references lara.discount_eligibility (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- P17C marketplace and POS
-- ---------------------------------------------------------------------------
create table lara.channels (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 code text not null check (code ~ '^[A-Za-z0-9._-]{1,32}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 kind text not null check (kind in ('marketplace','ewallet','pos')),
 provider text not null check (length(btrim(provider)) between 1 and 100),
 mapping_version text not null check (length(mapping_version) between 1 and 100),
 receivable_account_id uuid not null,
 fee_account_id uuid not null,
 withholding_account_id uuid not null,
 clearing_account_id uuid not null,
 status text not null default 'active' check (status in ('active','archived')),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, code),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, receivable_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, fee_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, withholding_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, clearing_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger channels_touch before update on lara.channels for each row execute function lara.touch_row();

-- A payout batch from the channel's statement: gross − fees − withholding −
-- other deductions = net, one per channel and source reference; reconciled
-- to the sales already imported for the period before it posts.
create table lara.payout_batches (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 channel_id uuid not null,
 source_id text not null check (length(btrim(source_id)) between 1 and 200),
 period_start date not null,
 period_end date not null,
 gross numeric(20,6) not null check (gross >= 0),
 fees numeric(20,6) not null default 0 check (fees >= 0),
 withholding numeric(20,6) not null default 0 check (withholding >= 0),
 other_deductions numeric(20,6) not null default 0 check (other_deductions >= 0),
 net numeric(20,6) not null check (net >= 0),
 deductions_json jsonb not null default '[]'::jsonb check (jsonb_typeof(deductions_json) = 'array'),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 sales_reference_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(sales_reference_ids) = 'array'),
 sales_total numeric(20,6),
 difference numeric(20,6),
 state text not null default 'imported' check (state in ('imported','reconciled','posted','exception','cancelled')),
 exception_reason text,
 entry_id uuid,
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 posted_by uuid,
 posted_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, channel_id, source_id),
 check (period_end >= period_start),
 check (net = gross - fees - withholding - other_deductions),
 check (state <> 'posted' or (entry_id is not null and posted_by is not null and posted_at is not null)),
 check (state <> 'exception' or exception_reason is not null),
 foreign key (tenant_id, entity_id, channel_id) references lara.channels (tenant_id, entity_id, id),
 foreign key (tenant_id, posted_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.payout_batches_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('posted','cancelled') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % payout is final', old.state using errcode = 'check_violation';
 end if;
 if old.state = 'posted' and (new.gross <> old.gross or new.fees <> old.fees or new.withholding <> old.withholding or new.net <> old.net) then
  raise exception 'STATE_CONFLICT: a posted payout is immutable' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'imported' and new.state in ('reconciled','exception','cancelled')) or
  (old.state = 'exception' and new.state in ('reconciled','exception','cancelled')) or
  (old.state = 'reconciled' and new.state in ('posted','exception','imported','cancelled'))) then
  raise exception 'STATE_CONFLICT: payout cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger payout_batches_validate before update on lara.payout_batches for each row execute function lara.payout_batches_validate();
create trigger payout_batches_touch before update on lara.payout_batches for each row execute function lara.touch_row();

create table lara.pos_machines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 branch_id uuid not null,
 brand text not null check (length(btrim(brand)) between 1 and 100),
 model text not null check (length(btrim(model)) between 1 and 100),
 serial_number text not null check (length(btrim(serial_number)) between 1 and 100),
 machine_identification_number text not null check (length(btrim(machine_identification_number)) between 1 and 100),
 permit_number text not null check (length(btrim(permit_number)) between 1 and 100),
 status text not null default 'active' check (status in ('active','archived')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, serial_number),
 unique (tenant_id, entity_id, machine_identification_number),
 foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger pos_machines_touch before update on lara.pos_machines for each row execute function lara.touch_row();

-- X and Z closings per machine and shift: readings, cash counted, deposit
-- matched to a posted settlement; approved by another principal.
create table lara.pos_closings (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 machine_id uuid not null,
 shift_date date not null,
 shift_no integer not null check (shift_no >= 1),
 reading_kind text not null check (reading_kind in ('X','Z')),
 beginning_reading numeric(20,6) not null check (beginning_reading >= 0),
 ending_reading numeric(20,6) not null check (ending_reading >= 0),
 gross_sales numeric(20,6) not null check (gross_sales >= 0),
 cash_counted numeric(20,6) not null check (cash_counted >= 0),
 non_cash numeric(20,6) not null default 0 check (non_cash >= 0),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 settlement_id uuid,
 deposit_difference numeric(20,6),
 state text not null default 'draft' check (state in ('draft','approved','matched','exception','rejected')),
 exception_reason text,
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, machine_id, shift_date, shift_no, reading_kind),
 check (ending_reading >= beginning_reading),
 check (gross_sales = ending_reading - beginning_reading),
 check (state not in ('approved','matched') or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 check (state <> 'matched' or settlement_id is not null),
 foreign key (tenant_id, entity_id, machine_id) references lara.pos_machines (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.pos_closings_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('matched','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % closing is final', old.state using errcode = 'check_violation';
 end if;
 if old.state <> 'draft' and new.content_hash <> old.content_hash then
  raise exception 'STATE_CONFLICT: an approved closing keeps its readings' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('approved','rejected')) or
  (old.state = 'approved' and new.state in ('matched','exception')) or
  (old.state = 'exception' and new.state in ('matched','exception'))) then
  raise exception 'STATE_CONFLICT: closing cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger pos_closings_validate before update on lara.pos_closings for each row execute function lara.pos_closings_validate();
create trigger pos_closings_touch before update on lara.pos_closings for each row execute function lara.touch_row();

-- ---------------------------------------------------------------------------
-- P17D payroll data and remittances
-- ---------------------------------------------------------------------------
create table lara.payroll_batches (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_system text not null check (length(btrim(source_system)) between 1 and 100),
 period_key text not null check (period_key ~ '^[0-9]{4}-[0-9]{2}$'),
 mapping_version text not null check (length(mapping_version) between 1 and 100),
 employee_count integer not null check (employee_count >= 1),
 gross_total numeric(20,6) not null check (gross_total >= 0),
 withholding_total numeric(20,6) not null check (withholding_total >= 0),
 sss_total numeric(20,6) not null default 0 check (sss_total >= 0),
 philhealth_total numeric(20,6) not null default 0 check (philhealth_total >= 0),
 pagibig_total numeric(20,6) not null default 0 check (pagibig_total >= 0),
 net_total numeric(20,6) not null check (net_total >= 0),
 source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 state text not null default 'imported' check (state in ('imported','reconciled','approved','posted','exception','rejected')),
 exception_reason text,
 journal_id uuid,
 entry_id uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, source_system, period_key, source_hash),
 check (state not in ('approved','posted') or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 check (state <> 'posted' or entry_id is not null),
 check (state <> 'exception' or exception_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index payroll_batches_one_posted on lara.payroll_batches (tenant_id, entity_id, source_system, period_key) where state = 'posted';
create or replace function lara.payroll_batches_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('posted','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % payroll batch is final', old.state using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'imported' and new.state in ('reconciled','exception','rejected')) or
  (old.state = 'exception' and new.state in ('reconciled','exception','rejected')) or
  (old.state = 'reconciled' and new.state in ('approved','rejected')) or
  (old.state = 'approved' and new.state in ('posted','rejected'))) then
  raise exception 'STATE_CONFLICT: payroll batch cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger payroll_batches_validate before update on lara.payroll_batches for each row execute function lara.payroll_batches_validate();
create trigger payroll_batches_touch before update on lara.payroll_batches for each row execute function lara.touch_row();

-- Individual records are restricted (payroll_record.read); the identifier
-- is stored encrypted and shown masked. Append-only.
create table lara.employee_tax_records (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 batch_id uuid not null,
 line_no integer not null check (line_no >= 1),
 employee_reference_encrypted text not null,
 employee_reference_masked text not null,
 gross numeric(20,6) not null check (gross >= 0),
 withholding numeric(20,6) not null check (withholding >= 0),
 sss numeric(20,6) not null default 0 check (sss >= 0),
 philhealth numeric(20,6) not null default 0 check (philhealth >= 0),
 pagibig numeric(20,6) not null default 0 check (pagibig >= 0),
 net numeric(20,6) not null check (net >= 0),
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, batch_id, line_no),
 foreign key (tenant_id, entity_id, batch_id) references lara.payroll_batches (tenant_id, entity_id, id)
);
create trigger employee_tax_records_append_only before update or delete on lara.employee_tax_records for each row execute function lara.reject_mutation();

create table lara.remittance_records (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 batch_id uuid,
 agency text not null check (agency in ('BIR','SSS','PhilHealth','Pag-IBIG')),
 period_key text not null check (period_key ~ '^[0-9]{4}-[0-9]{2}$'),
 amount numeric(20,6) not null check (amount > 0),
 reference text,
 due_date date not null,
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
 settlement_id uuid,
 state text not null default 'due' check (state in ('due','approved','remitted','rejected')),
 content_version bigint not null default 1 check (content_version >= 1),
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, agency, period_key, batch_id),
 check (state not in ('approved','remitted') or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 check (state <> 'remitted' or (reference is not null and jsonb_array_length(evidence_ids) >= 1)),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, batch_id) references lara.payroll_batches (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.remittance_records_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('remitted','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % remittance is final', old.state using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not ((old.state = 'due' and new.state in ('approved','rejected')) or (old.state = 'approved' and new.state in ('remitted','rejected'))) then
  raise exception 'STATE_CONFLICT: remittance cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger remittance_records_validate before update on lara.remittance_records for each row execute function lara.remittance_records_validate();
create trigger remittance_records_touch before update on lara.remittance_records for each row execute function lara.touch_row();

-- ---------------------------------------------------------------------------
-- P17E local obligations
-- ---------------------------------------------------------------------------
create table lara.local_obligations (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 authority text not null check (length(btrim(authority)) between 1 and 200),
 authority_profile_version text not null check (length(authority_profile_version) between 1 and 100),
 kind text not null check (kind in ('business_permit','local_business_tax','real_property_tax','community_tax','other')),
 property_ref text,
 period_key text not null check (period_key ~ '^[0-9]{4}(-[0-9]{2})?(-Q[1-4])?$'),
 due_date date not null,
 amount numeric(20,6) not null check (amount >= 0),
 requires_filing boolean not null default false,
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
 payment_evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(payment_evidence_ids) = 'array'),
 filing_evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(filing_evidence_ids) = 'array'),
 bill_id uuid,
 settlement_id uuid,
 state text not null default 'open' check (state in ('open','paid','complete','waived')),
 completed_by uuid,
 completed_at timestamptz,
 reason text,
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state <> 'complete' or (completed_by is not null and completed_at is not null and jsonb_array_length(payment_evidence_ids) >= 1)),
 check (state <> 'complete' or not requires_filing or jsonb_array_length(filing_evidence_ids) >= 1),
 check (state <> 'waived' or reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, bill_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id),
 foreign key (tenant_id, completed_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index local_obligations_period_key on lara.local_obligations (tenant_id, entity_id, authority, kind, period_key, coalesce(property_ref, ''));
create index local_obligations_due on lara.local_obligations (tenant_id, entity_id, state, due_date);
create or replace function lara.local_obligations_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('complete','waived') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % obligation is final', old.state using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not ((old.state = 'open' and new.state in ('paid','complete','waived')) or (old.state = 'paid' and new.state in ('complete','waived'))) then
  raise exception 'STATE_CONFLICT: obligation cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger local_obligations_validate before update on lara.local_obligations for each row execute function lara.local_obligations_validate();
create trigger local_obligations_touch before update on lara.local_obligations for each row execute function lara.touch_row();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['lease_contracts','lease_events','discount_eligibility','discount_lines','channels','payout_batches','pos_machines','pos_closings','payroll_batches','employee_tax_records','remittance_records','local_obligations'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.lease_contracts, lara.discount_eligibility, lara.channels, lara.payout_batches, lara.pos_machines, lara.pos_closings, lara.payroll_batches, lara.remittance_records, lara.local_obligations to lara_api;
grant select, insert on lara.lease_events, lara.employee_tax_records to lara_api;
grant select, insert, delete on lara.discount_lines to lara_api;
grant select on lara.lease_contracts, lara.lease_events, lara.discount_eligibility, lara.discount_lines, lara.channels, lara.payout_batches, lara.pos_machines, lara.pos_closings, lara.payroll_batches, lara.remittance_records, lara.local_obligations to lara_worker, lara_audit_reader;
