-- P05 purchasing, payables and expenses. Purchase orders, bills and expense
-- claims are documents (kinds purchase_order, bill, expense_claim); this
-- migration adds the purchasing facts around them: duplicate-reference guard,
-- receipts of service, reviewed beneficiary versions, payment orders with the
-- published payment state machine, employee advances with append-only events,
-- expense claim facts and withholding certificates derived from tax events.

-- Bills: normalized supplier reference, unique per supplier while not cancelled.
alter table lara.documents add column supplier_reference_normalized text;
create unique index documents_supplier_reference on lara.documents (tenant_id, entity_id, party_id, supplier_reference_normalized) where kind = 'bill' and state <> 'cancelled' and supplier_reference_normalized is not null;
alter table lara.documents add column withholding numeric(24,6) not null default 0 check (withholding >= 0);
alter table lara.documents add column withholding_rule_version_id uuid;
alter table lara.documents add constraint documents_withholding_rule_fk foreign key (tenant_id, entity_id, withholding_rule_version_id) references lara.tax_rule_versions (tenant_id, entity_id, id);
alter table lara.documents add column withholding_recognition text check (withholding_recognition in ('accrual','payment'));
alter table lara.documents add constraint documents_withholding_bounds check (withholding <= net);
alter table lara.documents add constraint documents_withholding_needs_rule check (withholding = 0 or withholding_rule_version_id is not null);

-- Receipts of service: evidence that ordered services were received, accepted
-- by a named principal; amounts per order line are append-only facts.
create table lara.receipts_of_service (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 order_id uuid not null,
 evidence_id uuid not null,
 accepted_by uuid not null,
 accepted_at timestamptz not null default now(),
 lines_json jsonb not null check (jsonb_typeof(lines_json) = 'array' and jsonb_array_length(lines_json) >= 1),
 total numeric(24,6) not null check (total > 0),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 foreign key (tenant_id, entity_id, order_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, evidence_id) references lara.evidence (tenant_id, id),
 foreign key (tenant_id, accepted_by) references lara.principals (tenant_id, id)
);
create index receipts_of_service_order on lara.receipts_of_service (tenant_id, entity_id, order_id, accepted_at);
create trigger receipts_of_service_append_only before update or delete on lara.receipts_of_service for each row execute function lara.reject_mutation();

-- Beneficiary versions: reviewed payee bank details per party; the account
-- number is encrypted at rest; one approved version per party.
create table lara.beneficiary_versions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 party_id uuid not null,
 version_number integer not null check (version_number >= 1),
 bank_name text not null check (length(btrim(bank_name)) between 1 and 200),
 account_name text not null check (length(btrim(account_name)) between 1 and 200),
 account_number_encrypted text not null,
 account_number_last4 text not null check (account_number_last4 ~ '^[A-Za-z0-9]{1,4}$'),
 status text not null default 'draft' check (status in ('draft','approved','superseded','rejected')),
 reviewed_by uuid,
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, party_id, version_number),
 check (status <> 'approved' or reviewed_by is not null),
 check (reviewed_by is null or reviewed_by <> created_by),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, reviewed_by) references lara.principals (tenant_id, id)
);
create unique index beneficiary_versions_one_approved on lara.beneficiary_versions (tenant_id, entity_id, party_id) where status = 'approved';
create or replace function lara.beneficiary_versions_validate() returns trigger language plpgsql as $$
begin
 if old.status in ('approved','superseded') and (new.account_number_encrypted <> old.account_number_encrypted or new.bank_name <> old.bank_name or new.account_name <> old.account_name or new.content_hash <> old.content_hash) then
  raise exception 'STATE_CONFLICT: reviewed beneficiary details are immutable; a change is a new version' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not ((old.status = 'draft' and new.status in ('approved','rejected')) or (old.status = 'approved' and new.status = 'superseded')) then
  raise exception 'STATE_CONFLICT: beneficiary version cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger beneficiary_versions_validate before update on lara.beneficiary_versions for each row execute function lara.beneficiary_versions_validate();
create trigger beneficiary_versions_touch before update on lara.beneficiary_versions for each row execute function lara.touch_row();

-- Payment orders: the authority to pay a submitted payment settlement to a
-- reviewed beneficiary. Published machine: draft → submitted → authorized →
-- released | release_unknown → settled | failed | returned. Authority binds the
-- settlement content version and the beneficiary version; the domain returns
-- the order to draft when either changes. No screen action moves money: release
-- and settlement record what happened outside with evidence.
create table lara.payment_orders (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 settlement_id uuid not null,
 beneficiary_version_id uuid not null,
 scheduled_date date not null,
 reason text,
 state text not null default 'draft' check (state in ('draft','submitted','authorized','release_unknown','released','settled','failed','returned','cancelled')),
 submitted_by uuid,
 authorized_by uuid,
 authorized_settlement_version bigint,
 release_channel text check (release_channel in ('manual','bank_file','qualified_api')),
 release_reference text,
 release_evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(release_evidence_ids) = 'array'),
 released_by uuid,
 released_at timestamptz,
 settle_reference text,
 settled_at timestamptz,
 settle_value_date date,
 settle_evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(settle_evidence_ids) = 'array'),
 settled_by uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state not in ('authorized','release_unknown','released','settled','returned') or (authorized_by is not null and authorized_settlement_version is not null)),
 check (state not in ('released','settled','returned') or (release_channel is not null and release_reference is not null and released_by is not null and jsonb_array_length(release_evidence_ids) >= 1)),
 check (state not in ('settled','returned') or (settle_reference is not null and settled_at is not null and settle_value_date is not null and settled_by is not null and jsonb_array_length(settle_evidence_ids) >= 1)),
 check (authorized_by is null or (authorized_by <> created_by and authorized_by is distinct from submitted_by)),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, beneficiary_version_id) references lara.beneficiary_versions (tenant_id, entity_id, id),
 foreign key (tenant_id, authorized_by) references lara.principals (tenant_id, id)
);
create unique index payment_orders_one_live on lara.payment_orders (tenant_id, settlement_id) where state not in ('cancelled','failed');
create index payment_orders_queue on lara.payment_orders (tenant_id, entity_id, state, scheduled_date, id);
create or replace function lara.payment_orders_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('settled','failed','returned','cancelled') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: payment order is terminal in state %', old.state using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('submitted','cancelled')) or
  (old.state = 'submitted' and new.state in ('authorized','draft','cancelled')) or
  (old.state = 'authorized' and new.state in ('released','release_unknown','draft','cancelled')) or
  (old.state = 'release_unknown' and new.state in ('released','failed')) or
  (old.state = 'released' and new.state in ('settled','failed','returned')) or
  (old.state = 'settled' and new.state = 'returned')) then
  raise exception 'STATE_CONFLICT: payment order cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if old.state in ('released','settled') and (new.release_reference <> old.release_reference or new.release_channel <> old.release_channel or new.release_evidence_ids <> old.release_evidence_ids) then
  raise exception 'STATE_CONFLICT: release evidence is immutable' using errcode = 'check_violation';
 end if;
 if old.state = 'settled' and (new.settle_reference <> old.settle_reference or new.settled_at <> old.settled_at or new.settle_value_date <> old.settle_value_date or new.settle_evidence_ids <> old.settle_evidence_ids) then
  raise exception 'STATE_CONFLICT: settlement evidence is immutable' using errcode = 'check_violation';
 end if;
 if (new.settlement_id <> old.settlement_id or new.beneficiary_version_id <> old.beneficiary_version_id) and old.state not in ('draft','submitted') then
  raise exception 'STATE_CONFLICT: an authorized payment cannot change its settlement or beneficiary; it returns to draft first' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger payment_orders_validate before update on lara.payment_orders for each row execute function lara.payment_orders_validate();
create trigger payment_orders_touch before update on lara.payment_orders for each row execute function lara.touch_row();

-- Employee advances: issued by a posted payment settlement, liquidated by
-- posted expense claims, remainder returned; every movement is an append-only
-- event checked against the advance balance.
create table lara.advances (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 party_id uuid not null,
 settlement_id uuid not null,
 amount numeric(24,6) not null check (amount > 0),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 status text not null default 'open' check (status in ('open','partially_liquidated','closed')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, settlement_id),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id)
);
create or replace function lara.advances_guard() returns trigger language plpgsql as $$
begin
 if new.amount <> old.amount or new.party_id <> old.party_id or new.settlement_id <> old.settlement_id or new.currency <> old.currency then
  raise exception 'STATE_CONFLICT: advance identity and amount are immutable' using errcode = 'check_violation';
 end if;
 new.version := old.version + 1; new.updated_at := now();
 return new;
end $$;
create trigger advances_guard before update on lara.advances for each row execute function lara.advances_guard();

create table lara.advance_events (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 advance_id uuid not null,
 kind text not null check (kind in ('liquidation','return')),
 amount numeric(24,6) not null check (amount > 0),
 document_id uuid,
 settlement_id uuid,
 entry_id uuid,
 command_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 check (kind <> 'liquidation' or document_id is not null),
 check (kind <> 'return' or settlement_id is not null),
 foreign key (tenant_id, entity_id, advance_id) references lara.advances (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id)
);
create unique index advance_events_one_liquidation_per_claim on lara.advance_events (tenant_id, advance_id, document_id) where kind = 'liquidation';
create index advance_events_advance on lara.advance_events (tenant_id, advance_id, created_at);
create trigger advance_events_append_only before update or delete on lara.advance_events for each row execute function lara.reject_mutation();
create or replace function lara.advance_used(p_tenant uuid, p_advance uuid) returns numeric(24,6) language sql stable as $$
 select coalesce(sum(amount), 0) from lara.advance_events where tenant_id = p_tenant and advance_id = p_advance
$$;
grant execute on function lara.advance_used(uuid, uuid) to lara_api, lara_worker, lara_audit_reader;
create or replace function lara.advance_events_guard() returns trigger language plpgsql as $$
declare adv lara.advances%rowtype; used numeric(24,6); s lara.settlements%rowtype;
begin
 select * into adv from lara.advances where tenant_id = new.tenant_id and id = new.advance_id for update;
 if adv.id is null then raise exception 'NOT_FOUND: advance' using errcode = 'foreign_key_violation'; end if;
 select * into s from lara.settlements where tenant_id = new.tenant_id and id = adv.settlement_id;
 if s.state <> 'posted' then raise exception 'STATE_CONFLICT: only posted advances liquidate' using errcode = 'check_violation'; end if;
 used := lara.advance_used(new.tenant_id, adv.id);
 if used + new.amount > adv.amount then raise exception 'ALLOCATION_EXCEEDS_BALANCE: advance remaining % is below %', adv.amount - used, new.amount using errcode = 'check_violation'; end if;
 return new;
end $$;
create trigger advance_events_guard before insert on lara.advance_events for each row execute function lara.advance_events_guard();
create or replace function lara.advances_refresh() returns trigger language plpgsql as $$
declare used numeric(24,6);
begin
 used := lara.advance_used(new.tenant_id, new.advance_id);
 update lara.advances set status = case when used <= 0 then 'open' when used >= amount then 'closed' else 'partially_liquidated' end where tenant_id = new.tenant_id and id = new.advance_id;
 return null;
end $$;
create trigger advance_events_refresh after insert on lara.advance_events for each row execute function lara.advances_refresh();

-- Expense claim facts beside the document: the employee, the advance being
-- liquidated and the policy version the claim was checked against.
create table lara.expense_claims (
 document_id uuid not null,
 tenant_id uuid not null,
 entity_id uuid not null,
 employee_party_id uuid not null,
 advance_id uuid,
 policy_version text not null check (length(policy_version) between 1 and 100),
 created_at timestamptz not null default now(),
 primary key (document_id),
 unique (tenant_id, document_id),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, employee_party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, advance_id) references lara.advances (tenant_id, entity_id, id)
);
create or replace function lara.expense_claims_guard() returns trigger language plpgsql as $$
begin
 if new.employee_party_id <> old.employee_party_id or new.document_id <> old.document_id then raise exception 'STATE_CONFLICT: claim facts are immutable' using errcode = 'check_violation'; end if;
 return new;
end $$;
create trigger expense_claims_guard before update on lara.expense_claims for each row execute function lara.expense_claims_guard();

-- Withholding certificates derive from tax events and store the reviewed
-- output version; issued certificates are immutable and re-issued as new versions.
create table lara.withholding_certificates (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 party_id uuid not null,
 period_key text not null check (period_key ~ '^\d{4}(-\d{2}|-Q[1-4])?$'),
 version_number integer not null check (version_number >= 1),
 tax_rule_version_id uuid not null,
 basis_total numeric(24,6) not null check (basis_total >= 0),
 tax_total numeric(24,6) not null check (tax_total >= 0),
 tax_event_ids jsonb not null check (jsonb_typeof(tax_event_ids) = 'array' and jsonb_array_length(tax_event_ids) >= 1),
 output_version text not null check (length(output_version) between 1 and 100),
 status text not null default 'draft' check (status in ('draft','reviewed','issued','superseded')),
 reviewed_by uuid,
 evidence_id uuid,
 checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, party_id, period_key, tax_rule_version_id, version_number),
 check (status not in ('reviewed','issued') or reviewed_by is not null),
 check (reviewed_by is null or reviewed_by <> created_by),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, tax_rule_version_id) references lara.tax_rule_versions (tenant_id, entity_id, id),
 foreign key (tenant_id, evidence_id) references lara.evidence (tenant_id, id)
);
create or replace function lara.withholding_certificates_validate() returns trigger language plpgsql as $$
begin
 if old.status in ('issued','superseded') and (new.basis_total <> old.basis_total or new.tax_total <> old.tax_total or new.tax_event_ids <> old.tax_event_ids or new.checksum <> old.checksum or new.output_version <> old.output_version) then
  raise exception 'STATE_CONFLICT: issued certificates are immutable; re-issue as a new version' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not ((old.status = 'draft' and new.status = 'reviewed') or (old.status = 'reviewed' and new.status in ('issued','draft')) or (old.status = 'issued' and new.status = 'superseded')) then
  raise exception 'STATE_CONFLICT: certificate cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger withholding_certificates_validate before update on lara.withholding_certificates for each row execute function lara.withholding_certificates_validate();
create trigger withholding_certificates_touch before update on lara.withholding_certificates for each row execute function lara.touch_row();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['receipts_of_service','beneficiary_versions','payment_orders','advances','advance_events','expense_claims','withholding_certificates'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.beneficiary_versions, lara.payment_orders, lara.advances, lara.expense_claims, lara.withholding_certificates to lara_api;
grant select, insert on lara.receipts_of_service, lara.advance_events to lara_api;
grant select on lara.receipts_of_service, lara.beneficiary_versions, lara.payment_orders, lara.advances, lara.advance_events, lara.expense_claims, lara.withholding_certificates to lara_worker, lara_audit_reader;
grant update (status, evidence_id) on lara.withholding_certificates to lara_worker;

-- Posted immutability now also covers the withholding snapshot and the supplier reference.
create or replace function lara.documents_validate() returns trigger language plpgsql as $$
begin
 if tg_op = 'UPDATE' then
  if old.state = 'posted' and (new.net <> old.net or new.tax <> old.tax or new.gross <> old.gross or new.withholding <> old.withholding or new.withholding_rule_version_id is distinct from old.withholding_rule_version_id or new.supplier_reference_normalized is distinct from old.supplier_reference_normalized or new.payload_hash <> old.payload_hash or new.party_id is distinct from old.party_id or new.document_date <> old.document_date or new.accounting_date <> old.accounting_date or new.kind <> old.kind or new.book_id <> old.book_id or new.branch_id <> old.branch_id or new.posted_entry_id <> old.posted_entry_id or new.official_number is distinct from old.official_number or new.series_id is distinct from old.series_id or new.approved_version <> old.approved_version or new.rule_profile_version <> old.rule_profile_version or new.currency <> old.currency) then
   raise exception 'STATE_CONFLICT: posted documents are immutable; corrections are new linked documents' using errcode = 'check_violation';
  end if;
  if old.state = 'cancelled' and new.state <> 'cancelled' then raise exception 'STATE_CONFLICT: cancelled documents stay cancelled' using errcode = 'check_violation'; end if;
  if new.state <> old.state and not (
   (old.state = 'draft' and new.state in ('submitted','cancelled')) or
   (old.state = 'submitted' and new.state in ('approved','changes_requested','cancelled','draft')) or
   (old.state = 'changes_requested' and new.state = 'draft') or
   (old.state = 'approved' and new.state in ('posted','draft','cancelled'))) then
   raise exception 'STATE_CONFLICT: document cannot move from % to %', old.state, new.state using errcode = 'check_violation';
  end if;
  if new.payload_hash <> old.payload_hash and new.state not in ('draft','cancelled') then
   raise exception 'STATE_CONFLICT: edited documents return to draft before approval' using errcode = 'check_violation';
  end if;
  if old.official_number is not null and new.official_number is distinct from old.official_number then
   raise exception 'STATE_CONFLICT: official numbers are never reassigned' using errcode = 'check_violation';
  end if;
 end if;
 return new;
end $$;
