-- P15 intercompany and consolidation: a group is owned by its reporting
-- (parent) entity and names wholly-owned members under the full method;
-- account mappings translate member charts to group accounts per approved
-- mapping version; rate sets carry the closing, average and historical rate
-- per member currency for one period end, approved by a second principal on
-- source evidence; intercompany pairs tie a source document in one entity to
-- an accepted target draft in another and track each side's posting as a
-- saga (an issued first side is never rolled back; a failed second side is
-- an exception); consolidation runs consume approved member statement
-- snapshots, translate, eliminate and produce a deterministic result whose
-- hash is stable for the same inputs; publishing writes a report snapshot in
-- the parent's reporting book. Subsidiary ledgers are never written.

create table lara.groups (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 name text not null check (length(btrim(name)) between 1 and 200),
 reporting_currency text not null check (reporting_currency ~ '^[A-Z]{3}$'),
 book_id uuid not null,
 translation_reserve_code text not null default '3900' check (translation_reserve_code ~ '^[A-Za-z0-9._-]{1,32}$'),
 state text not null default 'draft' check (state in ('draft','active','archived')),
 activated_by uuid,
 activated_at timestamptz,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state <> 'active' or (activated_by is not null and activated_at is not null)),
 check (activated_by is null or activated_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, activated_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index groups_one_per_parent on lara.groups (tenant_id, entity_id) where state <> 'archived';
create or replace function lara.groups_validate() returns trigger language plpgsql as $$
begin
 if old.state = 'archived' and new.state <> old.state then
  raise exception 'STATE_CONFLICT: an archived group is final' using errcode = 'check_violation';
 end if;
 if old.state = 'active' and (new.reporting_currency <> old.reporting_currency or new.book_id <> old.book_id) then
  raise exception 'STATE_CONFLICT: an active group keeps its reporting currency and book; archive it and define another' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not ((old.state = 'draft' and new.state in ('active','archived')) or (old.state = 'active' and new.state = 'archived')) then
  raise exception 'STATE_CONFLICT: group cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger groups_validate before update on lara.groups for each row execute function lara.groups_validate();
create trigger groups_touch before update on lara.groups for each row execute function lara.touch_row();

-- Members: entities of the same tenant, wholly owned under the full method.
-- Partial ownership or the equity method is an approved extension (not in
-- this release): the check keeps the pilot boundary in the database.
create table lara.group_members (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 group_id uuid not null,
 entity_id uuid not null,
 ownership_pct numeric(9,6) not null check (ownership_pct > 0 and ownership_pct <= 100),
 method text not null check (method in ('full')),
 effective_from date not null,
 effective_to date,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, group_id, entity_id),
 check (method <> 'full' or ownership_pct = 100),
 check (effective_to is null or effective_to >= effective_from),
 foreign key (tenant_id, group_id) references lara.groups (tenant_id, id) on delete cascade,
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);

-- Mapping versions: member account → group account (code, name, category)
-- with the intercompany and reserve roles the eliminations and translation
-- rely on; approved by a second principal; approved versions are immutable.
create table lara.group_mapping_versions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 group_id uuid not null,
 mapping_version text not null check (mapping_version ~ '^[A-Za-z0-9._-]{1,64}$'),
 state text not null default 'draft' check (state in ('draft','approved','rejected')),
 entry_count integer not null default 0 check (entry_count >= 0),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 approved_by uuid,
 approved_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, group_id, mapping_version),
 check (state <> 'approved' or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id, group_id) references lara.groups (tenant_id, entity_id, id) on delete cascade,
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.group_mapping_versions_validate() returns trigger language plpgsql as $$
begin
 if old.state = 'approved' and (new.content_hash <> old.content_hash or new.state <> old.state) then
  raise exception 'STATE_CONFLICT: an approved mapping version is immutable; add a new version' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (old.state = 'draft' and new.state in ('approved','rejected')) then
  raise exception 'STATE_CONFLICT: mapping version cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger group_mapping_versions_validate before update on lara.group_mapping_versions for each row execute function lara.group_mapping_versions_validate();
create trigger group_mapping_versions_touch before update on lara.group_mapping_versions for each row execute function lara.touch_row();

create table lara.group_account_mappings (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 mapping_version_id uuid not null,
 member_entity_id uuid not null,
 account_id uuid not null,
 group_account_code text not null check (group_account_code ~ '^[A-Za-z0-9._-]{1,32}$'),
 group_account_name text not null check (length(btrim(group_account_name)) between 1 and 200),
 group_category text not null check (group_category in ('asset','liability','equity','income','expense')),
 role text check (role in ('intercompany_receivable','intercompany_payable','intercompany_revenue','intercompany_expense','translation_reserve','retained_earnings')),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, mapping_version_id, member_entity_id, account_id),
 foreign key (tenant_id, mapping_version_id) references lara.group_mapping_versions (tenant_id, id) on delete cascade,
 foreign key (tenant_id, member_entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, account_id) references lara.accounts (tenant_id, id)
);
create index group_account_mappings_version on lara.group_account_mappings (tenant_id, mapping_version_id, member_entity_id);

-- Rate sets: closing, average and historical rates per currency (units of
-- the reporting currency per one unit of the member currency) for one
-- period end, from source evidence, approved by a second principal.
create table lara.consolidation_rate_sets (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 code text not null check (code ~ '^[A-Za-z0-9._-]{1,64}$'),
 period_end date not null,
 reporting_currency text not null check (reporting_currency ~ '^[A-Z]{3}$'),
 income_policy text not null default 'period_average' check (income_policy in ('period_average','transaction_rate')),
 rates jsonb not null check (jsonb_typeof(rates) = 'array'),
 source_evidence_id uuid not null,
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
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, code),
 check (state <> 'approved' or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, source_evidence_id) references lara.evidence (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.consolidation_rate_sets_validate() returns trigger language plpgsql as $$
begin
 if old.state = 'approved' and (new.content_hash <> old.content_hash or new.state <> old.state) then
  raise exception 'STATE_CONFLICT: an approved rate set is immutable; a correction is a new rate set' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (old.state = 'draft' and new.state in ('approved','rejected')) then
  raise exception 'STATE_CONFLICT: rate set cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger consolidation_rate_sets_validate before update on lara.consolidation_rate_sets for each row execute function lara.consolidation_rate_sets_validate();
create trigger consolidation_rate_sets_touch before update on lara.consolidation_rate_sets for each row execute function lara.touch_row();

-- Intercompany pairs: the source document in the source entity and the
-- target draft the target entity accepts into its own books under its own
-- authority. Posting is tracked per side: a posted first side stays posted;
-- a failed or refused second side leaves the pair in exception.
create table lara.intercompany_pairs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_entity_id uuid not null,
 target_entity_id uuid not null,
 source_document_id uuid not null,
 target_document_id uuid,
 shared_reference text not null check (shared_reference ~ '^ICP-[0-9]{6}$'),
 target_draft jsonb not null check (jsonb_typeof(target_draft) = 'object'),
 state text not null default 'draft' check (state in ('draft','accepted','posted','exception','rejected')),
 source_posted_at timestamptz,
 target_posted_at timestamptz,
 exception_reason text,
 decided_by uuid,
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, shared_reference),
 unique (tenant_id, source_document_id),
 check (entity_id = source_entity_id),
 check (source_entity_id <> target_entity_id),
 check (state <> 'accepted' or target_document_id is not null),
 check (state <> 'posted' or (source_posted_at is not null and target_posted_at is not null)),
 check (state <> 'exception' or exception_reason is not null),
 check (state <> 'rejected' or exception_reason is not null),
 foreign key (tenant_id, source_entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, target_entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, source_entity_id, source_document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, target_entity_id, target_document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, decided_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index intercompany_pairs_target on lara.intercompany_pairs (tenant_id, target_entity_id, state);
create or replace function lara.intercompany_pairs_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('posted','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % pair is final', old.state using errcode = 'check_violation';
 end if;
 if old.source_posted_at is not null and new.source_posted_at is distinct from old.source_posted_at then
  raise exception 'APPEND_ONLY: an issued source side is never rolled back' using errcode = 'check_violation';
 end if;
 if old.target_posted_at is not null and new.target_posted_at is distinct from old.target_posted_at then
  raise exception 'APPEND_ONLY: a posted target side is never rolled back' using errcode = 'check_violation';
 end if;
 if old.state <> 'draft' and (new.target_draft <> old.target_draft or new.source_document_id <> old.source_document_id or new.target_entity_id <> old.target_entity_id) then
  raise exception 'STATE_CONFLICT: an accepted pair keeps its documents' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('accepted','rejected')) or
  (old.state = 'accepted' and new.state in ('posted','exception')) or
  (old.state = 'exception' and new.state in ('accepted','posted','exception'))) then
  raise exception 'STATE_CONFLICT: pair cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger intercompany_pairs_validate before update on lara.intercompany_pairs for each row execute function lara.intercompany_pairs_validate();
create trigger intercompany_pairs_touch before update on lara.intercompany_pairs for each row execute function lara.touch_row();

-- Consolidation runs in the parent entity. The member snapshot ids, rate set
-- and mapping version are the whole input; the result and its hash are
-- computed from them alone. Same inputs → same hash; a new run for the same
-- group and period end is the next version and supersedes the earlier one
-- when published.
create table lara.consolidation_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 group_id uuid not null,
 period_end date not null,
 version_number integer not null check (version_number >= 1),
 member_snapshot_ids uuid[] not null check (cardinality(member_snapshot_ids) >= 1),
 rate_set_id uuid not null,
 mapping_version text not null check (mapping_version ~ '^[A-Za-z0-9._-]{1,64}$'),
 state text not null default 'draft' check (state in ('draft','previewed','approved','published','superseded','rejected')),
 result jsonb,
 result_hash text check (result_hash ~ '^[a-f0-9]{64}$'),
 unresolved_count integer not null default 0 check (unresolved_count >= 0),
 approved_by uuid,
 approved_at timestamptz,
 published_snapshot_id uuid,
 published_at timestamptz,
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, group_id, period_end, version_number),
 check (state not in ('previewed','approved','published','superseded') or (result is not null and result_hash is not null)),
 check (state not in ('approved','published','superseded') or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 check (state not in ('published','superseded') or (published_snapshot_id is not null and published_at is not null)),
 foreign key (tenant_id, entity_id, group_id) references lara.groups (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, rate_set_id) references lara.consolidation_rate_sets (tenant_id, entity_id, id),
 foreign key (tenant_id, published_snapshot_id) references lara.report_snapshots (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index consolidation_runs_one_published on lara.consolidation_runs (tenant_id, group_id, period_end) where state = 'published';
create or replace function lara.consolidation_runs_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('superseded','rejected') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % run is final', old.state using errcode = 'check_violation';
 end if;
 if old.state in ('approved','published','superseded') and (new.result_hash <> old.result_hash or new.member_snapshot_ids <> old.member_snapshot_ids or new.rate_set_id <> old.rate_set_id or new.mapping_version <> old.mapping_version) then
  raise exception 'STATE_CONFLICT: an approved run keeps its inputs and result; start a new run' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('previewed','rejected')) or
  (old.state = 'previewed' and new.state in ('draft','previewed','approved','rejected')) or
  (old.state = 'approved' and new.state in ('published','rejected')) or
  (old.state = 'published' and new.state = 'superseded')) then
  raise exception 'STATE_CONFLICT: consolidation run cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger consolidation_runs_validate before update on lara.consolidation_runs for each row execute function lara.consolidation_runs_validate();
create trigger consolidation_runs_touch before update on lara.consolidation_runs for each row execute function lara.touch_row();

-- Eliminations per run: derived from posted pairs between members, or
-- entered by hand with a reason and evidence. Amounts are positive in the
-- reporting currency; an unbalanced entry carries its unresolved difference
-- instead of a plug.
create table lara.elimination_entries (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 run_id uuid not null,
 kind text not null check (kind in ('pair','manual')),
 pair_id uuid,
 lines jsonb not null check (jsonb_typeof(lines) = 'array'),
 amount numeric(20,6) not null check (amount >= 0),
 difference numeric(20,6) not null default 0,
 reason text not null check (length(btrim(reason)) between 1 and 500),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 check (kind <> 'pair' or pair_id is not null),
 check (kind <> 'manual' or jsonb_array_length(evidence_ids) >= 1),
 foreign key (tenant_id, entity_id, run_id) references lara.consolidation_runs (tenant_id, entity_id, id) on delete cascade,
 foreign key (tenant_id, pair_id) references lara.intercompany_pairs (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index elimination_entries_run on lara.elimination_entries (tenant_id, run_id);

-- Translation adjustments per run and member: the source (balance sheet
-- at closing, income at the policy rate, equity at historical), the policy,
-- the rate used and the difference booked to the translation reserve.
create table lara.translation_adjustments (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 run_id uuid not null,
 member_entity_id uuid not null,
 source text not null check (source in ('balance_sheet','income','equity')),
 policy text not null check (policy in ('closing','period_average','transaction_rate','historical')),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 rate numeric(24,12) not null check (rate > 0),
 amount numeric(20,6) not null,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, run_id, member_entity_id, source),
 foreign key (tenant_id, entity_id, run_id) references lara.consolidation_runs (tenant_id, entity_id, id) on delete cascade,
 foreign key (tenant_id, member_entity_id) references lara.entities (tenant_id, id)
);

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['groups','group_members','group_mapping_versions','group_account_mappings','consolidation_rate_sets','intercompany_pairs','consolidation_runs','elimination_entries','translation_adjustments'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.groups, lara.group_mapping_versions, lara.consolidation_rate_sets, lara.intercompany_pairs, lara.consolidation_runs to lara_api;
grant select, insert, delete on lara.group_members, lara.group_account_mappings, lara.elimination_entries, lara.translation_adjustments to lara_api;
grant select on lara.groups, lara.group_members, lara.group_mapping_versions, lara.group_account_mappings, lara.consolidation_rate_sets, lara.intercompany_pairs, lara.consolidation_runs, lara.elimination_entries, lara.translation_adjustments to lara_worker, lara_audit_reader;
