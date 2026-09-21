-- P04 sales invoicing and receivables, with the tax kernel registry: tax rule
-- versions and events, documents and lines with server-computed tax snapshots,
-- document relations, numbering series with single-use official numbers,
-- open items whose outstanding amount derives from append-only allocation
-- events, settlements, payment terms, credit limits, deliveries and party
-- snapshots. Nothing here activates a live tax profile: rule versions are
-- approved and activated separately with evidence, and sample rates stay draft.

-- ---------------------------------------------------------------------------
-- Tax kernel registry
-- ---------------------------------------------------------------------------
create table lara.tax_rule_versions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 version_number integer not null check (version_number >= 1),
 tax_type text not null check (tax_type in ('vat','withholding','grt','dst','percentage')),
 valid_from date not null,
 valid_to date,
 rate numeric(24,12) not null check (rate >= 0 and rate <= 1),
 basis text not null check (basis in ('net','gross','instrument','approved_expression')),
 recognition text not null check (recognition in ('issue','accrual','payment','profile_event')),
 rounding text not null check (rounding in ('line_half_up','document_half_up')),
 applicability_profile_id uuid,
 source_evidence_ids jsonb not null check (jsonb_typeof(source_evidence_ids) = 'array' and jsonb_array_length(source_evidence_ids) >= 1),
 golden_case_ids jsonb not null check (jsonb_typeof(golden_case_ids) = 'array' and jsonb_array_length(golden_case_ids) >= 1),
 status text not null default 'draft' check (status in ('draft','pending_approval','approved','active','superseded','rejected')),
 approved_by uuid,
 activated_by uuid,
 activated_at timestamptz,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, code, version_number),
 check (valid_to is null or valid_to >= valid_from),
 check (status not in ('approved','active','superseded') or approved_by is not null),
 check (status <> 'active' or (activated_by is not null and activated_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, activated_by) references lara.principals (tenant_id, id)
);
create unique index tax_rule_versions_one_active on lara.tax_rule_versions (tenant_id, entity_id, code) where status = 'active';
-- Approved rule content is immutable; a change is a new version number.
create or replace function lara.tax_rule_versions_immutable() returns trigger language plpgsql as $$
begin
 if old.status in ('approved','active','superseded') and (new.rate <> old.rate or new.basis <> old.basis or new.recognition <> old.recognition or new.rounding <> old.rounding or new.valid_from <> old.valid_from or new.valid_to is distinct from old.valid_to or new.tax_type <> old.tax_type or new.content_hash <> old.content_hash) then
  raise exception 'STATE_CONFLICT: approved tax rule versions are immutable' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not (
  (old.status = 'draft' and new.status in ('pending_approval','rejected')) or
  (old.status = 'pending_approval' and new.status in ('approved','rejected','draft')) or
  (old.status = 'approved' and new.status in ('active','superseded')) or
  (old.status = 'active' and new.status = 'superseded')) then
  raise exception 'STATE_CONFLICT: tax rule version cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 if new.status = 'active' and new.activated_by = new.created_by then
  raise exception 'SELF_APPROVAL: the rule author cannot activate it' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger tax_rule_versions_immutable before update on lara.tax_rule_versions for each row execute function lara.tax_rule_versions_immutable();
create trigger tax_rule_versions_touch before update on lara.tax_rule_versions for each row execute function lara.touch_row();

-- ---------------------------------------------------------------------------
-- Numbering series: numbers are allocated once, inside the issuing
-- transaction, and every allocation or skip is recorded.
-- ---------------------------------------------------------------------------
create table lara.document_series (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 branch_id uuid not null,
 kind text not null check (kind in ('invoice','credit_note','sales_order','quotation','bill','purchase_order','expense_claim')),
 prefix text not null check (prefix ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
 next_number bigint not null default 1 check (next_number >= 1),
 maximum_number bigint,
 profile_version text not null check (length(profile_version) between 1 and 100),
 status text not null default 'active' check (status in ('draft','active','exhausted','archived')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, branch_id, kind, prefix),
 check (maximum_number is null or maximum_number >= next_number - 1),
 foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id)
);
create unique index document_series_one_active on lara.document_series (tenant_id, entity_id, branch_id, kind) where status = 'active';
create or replace function lara.document_series_validate() returns trigger language plpgsql as $$
begin
 if new.next_number < old.next_number then raise exception 'STATE_CONFLICT: issued numbers are never recycled' using errcode = 'check_violation'; end if;
 if old.status = 'exhausted' and new.status = 'active' then raise exception 'STATE_CONFLICT: an exhausted series is replaced, not reopened' using errcode = 'check_violation'; end if;
 return new;
end $$;
create trigger document_series_validate before update on lara.document_series for each row execute function lara.document_series_validate();
create trigger document_series_touch before update on lara.document_series for each row execute function lara.touch_row();

create table lara.number_events (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 series_id uuid not null,
 number bigint not null check (number >= 1),
 document_id uuid,
 event text not null check (event in ('issued','skipped','voided')),
 reason text,
 occurred_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 check (event <> 'issued' or document_id is not null),
 check (event = 'issued' or reason is not null),
 foreign key (tenant_id, entity_id, series_id) references lara.document_series (tenant_id, entity_id, id)
);
create unique index number_events_one_issue on lara.number_events (tenant_id, series_id, number) where event = 'issued';
create trigger number_events_append_only before update or delete on lara.number_events for each row execute function lara.reject_mutation();

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create table lara.payment_terms (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 installments_json jsonb not null check (jsonb_typeof(installments_json) = 'array' and jsonb_array_length(installments_json) >= 1),
 status text not null default 'active' check (status in ('active','archived')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, code),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id)
);
create trigger payment_terms_touch before update on lara.payment_terms for each row execute function lara.touch_row();

create table lara.documents (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 kind text not null check (kind in ('invoice','bill','quotation','sales_order','purchase_order','credit_note','expense_claim')),
 branch_id uuid not null,
 party_id uuid,
 document_date date not null,
 accounting_date date not null,
 tax_date date,
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 state text not null default 'draft' check (state in ('draft','submitted','changes_requested','approved','posted','cancelled')),
 net numeric(24,6) not null default 0 check (net >= 0),
 tax numeric(24,6) not null default 0 check (tax >= 0),
 gross numeric(24,6) not null default 0 check (gross >= 0),
 series_id uuid,
 official_number text,
 approved_version bigint,
 rule_profile_version text not null check (length(rule_profile_version) between 1 and 100),
 external_reference text,
 source_document_id uuid,
 payment_terms_id uuid,
 due_schedule jsonb not null default '[]'::jsonb check (jsonb_typeof(due_schedule) = 'array'),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
 payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
 posted_entry_id uuid,
 delivery_state text not null default 'not_requested' check (delivery_state in ('not_requested','queued','sent','delivered','failed')),
 reporting_state text not null default 'not_applicable' check (reporting_state in ('not_applicable','queued','sending','accepted','rejected','unknown','retry_wait')),
 settlement_state text not null default 'unpaid' check (settlement_state in ('unpaid','partially_paid','paid','not_applicable')),
 submitted_by uuid,
 approved_by uuid,
 posted_by uuid,
 posted_at timestamptz,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (gross = net + tax),
 check (state <> 'posted' or (posted_entry_id is not null and posted_by is not null and posted_at is not null and approved_version is not null)),
 check (approved_by is null or (approved_by <> created_by and approved_by is distinct from submitted_by)),
 check (official_number is null or series_id is not null),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, series_id) references lara.document_series (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, source_document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, payment_terms_id) references lara.payment_terms (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id, posted_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id)
);
create unique index documents_official_number on lara.documents (tenant_id, entity_id, series_id, official_number) where official_number is not null;
create index documents_queue on lara.documents (tenant_id, entity_id, kind, state, created_at, id);
create index documents_party on lara.documents (tenant_id, entity_id, party_id, kind, document_date);
create index documents_period on lara.documents (tenant_id, entity_id, book_id, accounting_date);
-- Posted documents are terminal for content; projections (delivery, reporting,
-- settlement states) may still change. Material edits after submission
-- return the document to draft and drop approval.
create or replace function lara.documents_validate() returns trigger language plpgsql as $$
begin
 if tg_op = 'UPDATE' then
  if old.state = 'posted' and (new.net <> old.net or new.tax <> old.tax or new.gross <> old.gross or new.payload_hash <> old.payload_hash or new.party_id is distinct from old.party_id or new.document_date <> old.document_date or new.accounting_date <> old.accounting_date or new.kind <> old.kind or new.book_id <> old.book_id or new.branch_id <> old.branch_id or new.posted_entry_id <> old.posted_entry_id or new.official_number is distinct from old.official_number or new.series_id is distinct from old.series_id or new.approved_version <> old.approved_version or new.rule_profile_version <> old.rule_profile_version or new.currency <> old.currency) then
   raise exception 'STATE_CONFLICT: posted documents are immutable; corrections are new linked documents' using errcode = 'check_violation';
  end if;
  if old.state = 'cancelled' and new.state <> 'cancelled' then raise exception 'STATE_CONFLICT: cancelled documents stay cancelled' using errcode = 'check_violation'; end if;
  if new.state <> old.state and not (
   (old.state = 'draft' and new.state in ('submitted','cancelled')) or
   (old.state = 'submitted' and new.state in ('approved','changes_requested','cancelled','draft')) or
   (old.state = 'changes_requested' and new.state = 'draft') or
   (old.state = 'approved' and new.state in ('posted','draft'))) then
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
create trigger documents_validate before update on lara.documents for each row execute function lara.documents_validate();
create trigger documents_touch before update on lara.documents for each row execute function lara.touch_row();

create table lara.document_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 document_id uuid not null,
 line_no integer not null check (line_no >= 1),
 item_id uuid,
 description text not null check (length(btrim(description)) between 1 and 500),
 quantity numeric(24,6) not null check (quantity > 0),
 unit_price numeric(24,6) not null check (unit_price >= 0),
 discount numeric(24,6) not null default 0 check (discount >= 0),
 price_basis text not null check (price_basis in ('exclusive','inclusive')),
 account_id uuid not null,
 tax_code_id uuid,
 tax_rule_version_id uuid,
 tax_rate numeric(24,12) not null default 0 check (tax_rate >= 0 and tax_rate <= 1),
 net numeric(24,6) not null check (net >= 0),
 tax numeric(24,6) not null check (tax >= 0),
 gross numeric(24,6) not null check (gross >= 0),
 dimensions_json jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions_json) = 'object'),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, document_id, line_no),
 check (gross = net + tax),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, entity_id, tax_rule_version_id) references lara.tax_rule_versions (tenant_id, entity_id, id)
);
-- Lines of a posted document are immutable; header totals equal line sums at commit.
create or replace function lara.document_lines_guard() returns trigger language plpgsql as $$
declare st text;
begin
 if current_setting('lara.maintenance', true) = 'teardown' then return coalesce(new, old); end if;
 select state into st from lara.documents where id = coalesce(new.document_id, old.document_id);
 if st = 'posted' then raise exception 'STATE_CONFLICT: lines of a posted document are immutable' using errcode = 'check_violation'; end if;
 return coalesce(new, old);
end $$;
create trigger document_lines_guard before insert or update or delete on lara.document_lines for each row execute function lara.document_lines_guard();
create or replace function lara.document_totals_check() returns trigger language plpgsql as $$
declare d lara.documents%rowtype; n numeric(24,6); t numeric(24,6); g numeric(24,6); c integer; payload jsonb;
begin
 if current_setting('lara.maintenance', true) = 'teardown' then return null; end if;
 payload := to_jsonb(coalesce(new, old));
 select * into d from lara.documents where id = coalesce(payload->>'document_id', payload->>'id')::uuid;
 if d.id is null then return null; end if;
 select coalesce(sum(net),0), coalesce(sum(tax),0), coalesce(sum(gross),0), count(*) into n, t, g, c from lara.document_lines where document_id = d.id;
 if c > 0 and (d.net <> n or d.tax <> t or d.gross <> g) then
  raise exception 'VALIDATION_FAILED: document totals % / % / % differ from line sums % / % / %', d.net, d.tax, d.gross, n, t, g using errcode = 'check_violation';
 end if;
 return null;
end $$;
create constraint trigger document_lines_totals after insert or update or delete on lara.document_lines deferrable initially deferred for each row execute function lara.document_totals_check();
create constraint trigger documents_totals after insert or update of net, tax, gross on lara.documents deferrable initially deferred for each row execute function lara.document_totals_check();

create table lara.document_relations (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_id uuid not null,
 target_id uuid not null,
 relation text not null check (relation in ('correction','credit','replacement','order','receipt','reversal','advance_application')),
 amount numeric(24,6) check (amount is null or amount > 0),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, source_id, target_id, relation),
 check (source_id <> target_id),
 foreign key (tenant_id, entity_id, source_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, target_id) references lara.documents (tenant_id, entity_id, id)
);
create index document_relations_target on lara.document_relations (tenant_id, entity_id, target_id, relation);
create trigger document_relations_append_only before update or delete on lara.document_relations for each row execute function lara.reject_mutation();

-- Party identity as invoiced: later master edits never rewrite an issued document.
create table lara.party_snapshots (
 document_id uuid not null,
 tenant_id uuid not null,
 entity_id uuid not null,
 immutable_json jsonb not null check (jsonb_typeof(immutable_json) = 'object'),
 snapshot_hash text not null check (snapshot_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 primary key (document_id),
 unique (tenant_id, document_id),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id)
);
create trigger party_snapshots_append_only before update or delete on lara.party_snapshots for each row execute function lara.reject_mutation();

-- ---------------------------------------------------------------------------
-- Tax events: recognized per document/line and rule version; never twice for
-- the same recognition of the same line.
-- ---------------------------------------------------------------------------
create table lara.tax_events (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 document_id uuid not null,
 line_id uuid,
 tax_rule_version_id uuid not null,
 tax_point date not null,
 recognition text not null check (recognition in ('issue','accrual','payment','profile_event')),
 basis numeric(24,6) not null check (basis >= 0),
 amount numeric(24,6) not null check (amount >= 0),
 recognition_entry_id uuid,
 reversed_by uuid,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, document_id, line_id, tax_rule_version_id, recognition),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, line_id) references lara.document_lines (tenant_id, id),
 foreign key (tenant_id, entity_id, tax_rule_version_id) references lara.tax_rule_versions (tenant_id, entity_id, id),
 foreign key (tenant_id, reversed_by) references lara.tax_events (tenant_id, id)
);
create or replace function lara.tax_events_reverse_only() returns trigger language plpgsql as $$
begin
 if old.reversed_by is not null or new.reversed_by is null or new.amount <> old.amount or new.basis <> old.basis or new.document_id <> old.document_id or new.tax_rule_version_id <> old.tax_rule_version_id or new.recognition <> old.recognition or new.tax_point <> old.tax_point then
  raise exception 'APPEND_ONLY: tax events only record their reversal' using errcode = 'integrity_constraint_violation';
 end if;
 return new;
end $$;
create trigger tax_events_reverse_only before update on lara.tax_events for each row execute function lara.tax_events_reverse_only();
create trigger tax_events_no_delete before delete on lara.tax_events for each row execute function lara.reject_mutation();

-- ---------------------------------------------------------------------------
-- Open items, settlements and allocation events
-- ---------------------------------------------------------------------------
create table lara.open_items (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 document_id uuid not null,
 side text not null check (side in ('AR','AP')),
 party_id uuid not null,
 original_amount numeric(24,6) not null check (original_amount > 0),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 due_date date not null,
 status text not null default 'open' check (status in ('open','partially_settled','settled','written_off')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, document_id),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id)
);
create index open_items_party on lara.open_items (tenant_id, entity_id, party_id, side, status, due_date);
-- The original amount and identity never change; only the derived status does.
create or replace function lara.open_items_guard() returns trigger language plpgsql as $$
begin
 if new.original_amount <> old.original_amount or new.document_id <> old.document_id or new.party_id <> old.party_id or new.side <> old.side or new.currency <> old.currency then
  raise exception 'STATE_CONFLICT: open item identity and original amount are immutable' using errcode = 'check_violation';
 end if;
 new.version := old.version + 1; new.updated_at := now();
 return new;
end $$;
create trigger open_items_guard before update on lara.open_items for each row execute function lara.open_items_guard();

create table lara.settlements (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 direction text not null check (direction in ('receipt','payment')),
 party_id uuid not null,
 bank_account_id uuid,
 payment_method text not null check (payment_method in ('cash','transfer','check','wallet','card')),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 gross_amount numeric(24,6) not null check (gross_amount > 0),
 cash_amount numeric(24,6) not null check (cash_amount >= 0),
 withholding_amount numeric(24,6) not null default 0 check (withholding_amount >= 0),
 adjustment_amount numeric(24,6) not null default 0 check (adjustment_amount >= 0),
 state text not null default 'draft' check (state in ('draft','submitted','approved','posted','reversed','cancelled')),
 value_date date not null,
 bank_reference text,
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
 payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
 posted_entry_id uuid,
 reversal_entry_id uuid,
 submitted_by uuid,
 approved_by uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (gross_amount = cash_amount + withholding_amount + adjustment_amount),
 check (state <> 'posted' or posted_entry_id is not null),
 check (state <> 'reversed' or (posted_entry_id is not null and reversal_entry_id is not null)),
 check (approved_by is null or (approved_by <> created_by and approved_by is distinct from submitted_by)),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, posted_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, entity_id, book_id, reversal_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id)
);
create index settlements_party on lara.settlements (tenant_id, entity_id, party_id, direction, state, value_date);
create or replace function lara.settlements_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('posted','reversed') and (new.gross_amount <> old.gross_amount or new.cash_amount <> old.cash_amount or new.withholding_amount <> old.withholding_amount or new.adjustment_amount <> old.adjustment_amount or new.party_id <> old.party_id or new.value_date <> old.value_date or new.payload_hash <> old.payload_hash or new.posted_entry_id <> old.posted_entry_id) then
  raise exception 'STATE_CONFLICT: posted settlements are immutable; reverse them' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('submitted','cancelled')) or
  (old.state = 'submitted' and new.state in ('approved','draft','cancelled')) or
  (old.state = 'approved' and new.state in ('posted','draft')) or
  (old.state = 'posted' and new.state = 'reversed')) then
  raise exception 'STATE_CONFLICT: settlement cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if new.payload_hash <> old.payload_hash and new.state not in ('draft','cancelled') then
  raise exception 'STATE_CONFLICT: edited settlements return to draft before approval' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger settlements_validate before update on lara.settlements for each row execute function lara.settlements_validate();
create trigger settlements_touch before update on lara.settlements for each row execute function lara.touch_row();

-- Allocation events are the only source of outstanding balances. Each apply
-- is checked against the remaining amounts of both the item and the settlement
-- under row locks; a reverse references the apply it undoes exactly once.
create table lara.allocation_events (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 settlement_id uuid not null,
 open_item_id uuid not null,
 amount numeric(24,6) not null check (amount > 0),
 action text not null check (action in ('apply','reverse')),
 reverses_id uuid,
 command_id uuid,
 reason text,
 created_at timestamptz not null default now(),
 created_by uuid,
 primary key (id),
 unique (tenant_id, id),
 check ((action = 'reverse') = (reverses_id is not null)),
 check (action <> 'reverse' or reason is not null),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id),
 foreign key (tenant_id, open_item_id) references lara.open_items (tenant_id, id),
 foreign key (tenant_id, reverses_id) references lara.allocation_events (tenant_id, id)
);
create unique index allocation_events_one_reverse on lara.allocation_events (tenant_id, reverses_id) where reverses_id is not null;
create index allocation_events_item on lara.allocation_events (tenant_id, open_item_id, created_at);
create index allocation_events_settlement on lara.allocation_events (tenant_id, settlement_id, created_at);
create trigger allocation_events_append_only before update or delete on lara.allocation_events for each row execute function lara.reject_mutation();

create or replace function lara.open_item_allocated(p_tenant uuid, p_item uuid) returns numeric(24,6) language sql stable as $$
 select coalesce(sum(case when action = 'apply' then amount else -amount end), 0) from lara.allocation_events where tenant_id = p_tenant and open_item_id = p_item
$$;
create or replace function lara.settlement_allocated(p_tenant uuid, p_settlement uuid) returns numeric(24,6) language sql stable as $$
 select coalesce(sum(case when action = 'apply' then amount else -amount end), 0) from lara.allocation_events where tenant_id = p_tenant and settlement_id = p_settlement
$$;
create or replace function lara.allocation_events_guard() returns trigger language plpgsql as $$
declare item lara.open_items%rowtype; s lara.settlements%rowtype; original lara.allocation_events%rowtype; item_used numeric(24,6); settlement_used numeric(24,6);
begin
 -- Ordered locks: settlement, then open item.
 select * into s from lara.settlements where tenant_id = new.tenant_id and id = new.settlement_id for update;
 select * into item from lara.open_items where tenant_id = new.tenant_id and id = new.open_item_id for update;
 if s.id is null or item.id is null then raise exception 'NOT_FOUND: settlement or open item' using errcode = 'foreign_key_violation'; end if;
 if s.currency <> item.currency then raise exception 'VALIDATION_FAILED: settlement and open item currencies differ' using errcode = 'check_violation'; end if;
 if (s.direction = 'receipt') <> (item.side = 'AR') then raise exception 'VALIDATION_FAILED: receipts settle receivables and payments settle payables' using errcode = 'check_violation'; end if;
 if s.party_id <> item.party_id then raise exception 'VALIDATION_FAILED: settlement party differs from the open item party' using errcode = 'check_violation'; end if;
 if new.action = 'apply' then
  if s.state <> 'posted' then raise exception 'STATE_CONFLICT: only posted settlements allocate' using errcode = 'check_violation'; end if;
  item_used := lara.open_item_allocated(new.tenant_id, item.id);
  settlement_used := lara.settlement_allocated(new.tenant_id, s.id);
  if item_used + new.amount > item.original_amount then raise exception 'ALLOCATION_EXCEEDS_BALANCE: open item outstanding % is below %', item.original_amount - item_used, new.amount using errcode = 'check_violation'; end if;
  if settlement_used + new.amount > s.gross_amount then raise exception 'ALLOCATION_EXCEEDS_BALANCE: settlement unallocated % is below %', s.gross_amount - settlement_used, new.amount using errcode = 'check_violation'; end if;
 else
  select * into original from lara.allocation_events where tenant_id = new.tenant_id and id = new.reverses_id;
  if original.id is null or original.action <> 'apply' or original.open_item_id <> new.open_item_id or original.settlement_id <> new.settlement_id or original.amount <> new.amount then
   raise exception 'STATE_CONFLICT: a reverse must mirror one apply of the same settlement and item' using errcode = 'check_violation';
  end if;
 end if;
 return new;
end $$;
create trigger allocation_events_guard before insert on lara.allocation_events for each row execute function lara.allocation_events_guard();
-- Derived status on the open item after each event.
create or replace function lara.open_items_refresh() returns trigger language plpgsql as $$
declare item lara.open_items%rowtype; used numeric(24,6);
begin
 select * into item from lara.open_items where tenant_id = new.tenant_id and id = new.open_item_id;
 used := lara.open_item_allocated(new.tenant_id, item.id);
 update lara.open_items set status = case when used <= 0 then 'open' when used >= original_amount then 'settled' else 'partially_settled' end where tenant_id = new.tenant_id and id = item.id;
 return null;
end $$;
create trigger allocation_events_refresh after insert on lara.allocation_events for each row execute function lara.open_items_refresh();

-- ---------------------------------------------------------------------------
-- Credit limits and deliveries
-- ---------------------------------------------------------------------------
create table lara.credit_limits (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 party_id uuid not null,
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 limit_amount numeric(24,6) not null check (limit_amount >= 0),
 policy_version text not null check (length(policy_version) between 1 and 100),
 approved_by uuid,
 status text not null default 'draft' check (status in ('draft','approved','superseded')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 check (status <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);
create unique index credit_limits_one_approved on lara.credit_limits (tenant_id, entity_id, party_id, currency) where status = 'approved';
create trigger credit_limits_touch before update on lara.credit_limits for each row execute function lara.touch_row();

create table lara.deliveries (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 document_id uuid not null,
 recipient_hash text not null check (recipient_hash ~ '^[a-f0-9]{64}$'),
 template_version text not null check (length(template_version) between 1 and 100),
 state text not null default 'queued' check (state in ('queued','sent','delivered','failed')),
 provider_reference text,
 attempt integer not null default 0 check (attempt >= 0),
 last_error text,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id)
);
create index deliveries_document on lara.deliveries (tenant_id, entity_id, document_id, created_at);
create trigger deliveries_touch before update on lara.deliveries for each row execute function lara.touch_row();

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------
do $$
declare target text;
begin
 foreach target in array array['tax_rule_versions','document_series','number_events','payment_terms','documents','document_lines','document_relations','party_snapshots','tax_events','open_items','settlements','allocation_events','credit_limits','deliveries'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.tax_rule_versions, lara.document_series, lara.payment_terms, lara.documents, lara.document_lines, lara.open_items, lara.settlements, lara.credit_limits, lara.deliveries to lara_api;
grant delete on lara.document_lines to lara_api;
grant select, insert on lara.number_events, lara.document_relations, lara.party_snapshots, lara.tax_events, lara.allocation_events to lara_api;
grant update (reversed_by) on lara.tax_events to lara_api;
grant select on all tables in schema lara to lara_worker, lara_audit_reader;
grant insert, update on lara.deliveries to lara_worker;
grant update (delivery_state, reporting_state) on lara.documents to lara_worker;
grant execute on function lara.open_item_allocated(uuid, uuid), lara.settlement_allocated(uuid, uuid) to lara_api, lara_worker, lara_audit_reader;
