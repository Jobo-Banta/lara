-- P07 tax compliance and e-invoicing: regulatory profiles and their reviewed
-- schema artifacts (form mappings and e-invoice schemas as evidence with a
-- hash), return runs with deterministic lines and source links, filing
-- records, transmission jobs and append-only attempts for e-invoice reporting,
-- and registration cases whose packs never stand for the authority's decision.
-- No live credentials or certified schemas are seeded.

create table lara.regulatory_profiles (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 jurisdiction text not null check (jurisdiction ~ '^[A-Z]{2}$'),
 version_number integer not null check (version_number >= 1),
 coverage jsonb not null check (jsonb_typeof(coverage) = 'array'),
 valid_from date not null,
 valid_to date,
 source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
 evidence_ids jsonb not null check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 status text not null default 'draft' check (status in ('draft','approved','active','superseded','rejected')),
 approved_by uuid,
 activated_by uuid,
 activated_at timestamptz,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, jurisdiction, version_number),
 check (valid_to is null or valid_to >= valid_from),
 check (status not in ('approved','active','superseded') or approved_by is not null),
 check (status <> 'active' or (activated_by is not null and activated_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, activated_by) references lara.principals (tenant_id, id)
);
create unique index regulatory_profiles_one_active on lara.regulatory_profiles (tenant_id, entity_id, jurisdiction) where status = 'active';
create or replace function lara.regulatory_profiles_validate() returns trigger language plpgsql as $$
begin
 if old.status in ('approved','active','superseded') and (new.coverage <> old.coverage or new.source_hash <> old.source_hash or new.valid_from <> old.valid_from or new.valid_to is distinct from old.valid_to or new.evidence_ids <> old.evidence_ids) then
  raise exception 'STATE_CONFLICT: approved regulatory profiles are immutable; a change is a new version' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not (
  (old.status = 'draft' and new.status in ('approved','rejected')) or
  (old.status = 'approved' and new.status in ('active','superseded')) or
  (old.status = 'active' and new.status = 'superseded')) then
  raise exception 'STATE_CONFLICT: regulatory profile cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 if new.status = 'active' and new.activated_by = new.created_by then
  raise exception 'SELF_APPROVAL: the profile author cannot activate it' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger regulatory_profiles_validate before update on lara.regulatory_profiles for each row execute function lara.regulatory_profiles_validate();
create trigger regulatory_profiles_touch before update on lara.regulatory_profiles for each row execute function lara.touch_row();

-- Reviewed artifacts: a form mapping or an e-invoice schema imported as
-- evidence, identified by its hash; one artifact per profile, type, code and version.
create table lara.schema_artifacts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 profile_id uuid not null,
 artifact_type text not null check (artifact_type in ('form_mapping','einvoice_schema','certificate_layout')),
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 version_label text not null check (length(version_label) between 1 and 100),
 hash text not null check (hash ~ '^[a-f0-9]{64}$'),
 evidence_id uuid not null,
 golden_case_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(golden_case_ids) = 'array'),
 status text not null default 'draft' check (status in ('draft','approved','superseded')),
 approved_by uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, profile_id, artifact_type, code, version_label),
 check (status <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, profile_id) references lara.regulatory_profiles (tenant_id, id),
 foreign key (tenant_id, evidence_id) references lara.evidence (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);
create unique index schema_artifacts_one_approved on lara.schema_artifacts (tenant_id, profile_id, artifact_type, code) where status = 'approved';
create or replace function lara.schema_artifacts_validate() returns trigger language plpgsql as $$
begin
 if old.status <> 'draft' and (new.hash <> old.hash or new.evidence_id <> old.evidence_id or new.code <> old.code) then
  raise exception 'STATE_CONFLICT: approved artifacts are immutable; import a new version' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not ((old.status = 'draft' and new.status = 'approved') or (old.status = 'approved' and new.status = 'superseded')) then
  raise exception 'STATE_CONFLICT: artifact cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger schema_artifacts_validate before update on lara.schema_artifacts for each row execute function lara.schema_artifacts_validate();
create trigger schema_artifacts_touch before update on lara.schema_artifacts for each row execute function lara.touch_row();

-- Return runs: draft → prepared → approved → filed; a rejected review returns
-- to draft; prepared content is frozen at its cutoff and identified by hash.
create table lara.return_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 form_code text not null check (form_code ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
 period_start date not null,
 period_end date not null,
 profile_version text not null check (length(profile_version) between 1 and 100),
 data_cutoff timestamptz not null,
 regulatory_profile_id uuid,
 artifact_id uuid,
 state text not null default 'draft' check (state in ('draft','prepared','approved','filed','superseded')),
 snapshot_hash text check (snapshot_hash ~ '^[a-f0-9]{64}$'),
 tie_out jsonb not null default '{}'::jsonb check (jsonb_typeof(tie_out) = 'object'),
 line_count integer not null default 0 check (line_count >= 0),
 total_basis numeric(24,6) not null default 0,
 total_amount numeric(24,6) not null default 0,
 prepared_by uuid,
 approved_by uuid,
 supersedes_id uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (period_end >= period_start),
 check (state not in ('prepared','approved','filed') or (snapshot_hash is not null and prepared_by is not null)),
 check (state not in ('approved','filed') or approved_by is not null),
 check (approved_by is null or (approved_by <> created_by and approved_by is distinct from prepared_by)),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, regulatory_profile_id) references lara.regulatory_profiles (tenant_id, id),
 foreign key (tenant_id, artifact_id) references lara.schema_artifacts (tenant_id, id),
 foreign key (tenant_id, entity_id, supersedes_id) references lara.return_runs (tenant_id, entity_id, id)
);
create index return_runs_queue on lara.return_runs (tenant_id, entity_id, form_code, period_start, state, id);
create or replace function lara.return_runs_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('approved','filed') and (new.snapshot_hash <> old.snapshot_hash or new.form_code <> old.form_code or new.period_start <> old.period_start or new.period_end <> old.period_end or new.data_cutoff <> old.data_cutoff or new.profile_version <> old.profile_version or new.tie_out <> old.tie_out) then
  raise exception 'STATE_CONFLICT: approved returns are immutable; a correction is a new run linked to this one' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state = 'prepared') or
  (old.state = 'prepared' and new.state in ('approved','draft')) or
  (old.state = 'approved' and new.state in ('filed','draft')) or
  (old.state in ('approved','filed') and new.state = 'superseded')) then
  raise exception 'STATE_CONFLICT: return run cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger return_runs_validate before update on lara.return_runs for each row execute function lara.return_runs_validate();
create trigger return_runs_touch before update on lara.return_runs for each row execute function lara.touch_row();
create table lara.return_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 run_id uuid not null,
 line_code text not null check (line_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 description text not null check (length(description) between 1 and 500),
 basis numeric(24,6) not null,
 amount numeric(24,6) not null,
 source_query_version text not null check (length(source_query_version) between 1 and 100),
 event_count integer not null default 0 check (event_count >= 0),
 primary key (id),
 unique (tenant_id, run_id, line_code),
 foreign key (tenant_id, run_id) references lara.return_runs (tenant_id, id)
);
create table lara.return_source_links (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 run_id uuid not null,
 tax_event_id uuid not null,
 line_code text not null,
 sign integer not null check (sign in (-1, 1)),
 primary key (id),
 unique (tenant_id, run_id, tax_event_id, line_code),
 foreign key (tenant_id, run_id) references lara.return_runs (tenant_id, id),
 foreign key (tenant_id, tax_event_id) references lara.tax_events (tenant_id, id)
);
create index return_source_links_event on lara.return_source_links (tenant_id, tax_event_id);
-- Lines and links of an approved or filed run are frozen; a draft re-prepares by replacing them.
create or replace function lara.return_lines_guard() returns trigger language plpgsql as $$
declare run_state text; rid uuid;
begin
 if tg_op = 'DELETE' and current_setting('lara.maintenance', true) = 'teardown' and (exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper)) or exists (select 1 from pg_tables where schemaname = tg_table_schema and tablename = tg_table_name and tableowner = current_user)) then return old; end if;
 rid := coalesce(new.run_id, old.run_id);
 select state into run_state from lara.return_runs where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = rid;
 if run_state in ('approved','filed','superseded') then raise exception 'STATE_CONFLICT: lines of an approved return are frozen' using errcode = 'check_violation'; end if;
 if tg_op = 'DELETE' then return old; end if;
 return new;
end $$;
create trigger return_lines_guard before insert or update or delete on lara.return_lines for each row execute function lara.return_lines_guard();
create trigger return_source_links_guard before insert or update or delete on lara.return_source_links for each row execute function lara.return_lines_guard();
create table lara.filing_records (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 run_id uuid not null,
 external_reference text not null check (length(btrim(external_reference)) between 1 and 200),
 filed_at timestamptz not null,
 evidence_ids jsonb not null check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 recorded_by uuid not null,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, run_id),
 foreign key (tenant_id, run_id) references lara.return_runs (tenant_id, id)
);
create trigger filing_records_append_only before update or delete on lara.filing_records for each row execute function lara.reject_mutation();

-- E-invoice reporting: one transmission job per document and payload
-- version; attempts are append-only with their request hash so an unknown
-- outcome is reconciled by status query before any resend.
create table lara.transmission_jobs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 document_id uuid not null,
 destination text not null check (length(destination) between 1 and 100),
 payload_version integer not null check (payload_version >= 1),
 payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
 payload_json jsonb not null check (jsonb_typeof(payload_json) = 'object'),
 signature text,
 profile_version text not null check (length(profile_version) between 1 and 100),
 state text not null default 'queued' check (state in ('queued','sending','accepted','rejected','unknown','retry_wait','superseded')),
 rejection_class text check (rejection_class in ('envelope','financial')),
 rejection_reason text,
 deadline_at timestamptz,
 remote_id text,
 attempt_count integer not null default 0 check (attempt_count >= 0),
 next_attempt_at timestamptz,
 reason text,
 created_at timestamptz not null default now(),
 created_by uuid,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, document_id, payload_version, destination),
 check (state <> 'rejected' or rejection_class is not null),
 check (state <> 'accepted' or remote_id is not null),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id)
);
create index transmission_jobs_queue on lara.transmission_jobs (tenant_id, entity_id, state, deadline_at, id);
create or replace function lara.transmission_jobs_validate() returns trigger language plpgsql as $$
begin
 if new.payload_hash <> old.payload_hash or new.payload_json <> old.payload_json or new.document_id <> old.document_id or new.payload_version <> old.payload_version then
  raise exception 'STATE_CONFLICT: transmission payloads are immutable; a re-encoding is a new payload version' using errcode = 'check_violation';
 end if;
 if old.state = 'accepted' and new.state <> 'accepted' and new.state <> 'superseded' then
  raise exception 'STATE_CONFLICT: an accepted transmission is final' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'queued' and new.state in ('sending','retry_wait','superseded')) or
  (old.state = 'sending' and new.state in ('accepted','rejected','unknown','retry_wait')) or
  (old.state = 'retry_wait' and new.state in ('sending','superseded')) or
  (old.state = 'unknown' and new.state in ('accepted','rejected','sending')) or
  (old.state = 'rejected' and new.state = 'superseded') or
  (old.state = 'accepted' and new.state = 'superseded')) then
  raise exception 'STATE_CONFLICT: transmission cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger transmission_jobs_validate before update on lara.transmission_jobs for each row execute function lara.transmission_jobs_validate();
create trigger transmission_jobs_touch before update on lara.transmission_jobs for each row execute function lara.touch_row();
create table lara.transmission_attempts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 job_id uuid not null,
 attempt integer not null check (attempt >= 1),
 request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
 sent_at timestamptz not null default now(),
 outcome text not null check (outcome in ('accepted','rejected','unknown','error','status_query')),
 response_evidence_id uuid,
 response_json jsonb not null default '{}'::jsonb check (jsonb_typeof(response_json) = 'object'),
 primary key (id),
 unique (tenant_id, job_id, attempt),
 foreign key (tenant_id, job_id) references lara.transmission_jobs (tenant_id, id),
 foreign key (tenant_id, response_evidence_id) references lara.evidence (tenant_id, id)
);
create trigger transmission_attempts_append_only before update or delete on lara.transmission_attempts for each row execute function lara.reject_mutation();

-- Registration cases: a generated pack is evidence for an application; the
-- authority's decision is recorded separately with its own evidence.
create table lara.registration_cases (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 authority text not null check (length(authority) between 1 and 100),
 scope text not null check (length(scope) between 1 and 200),
 status text not null default 'open' check (status in ('open','pack_generated','submitted','approved','denied','withdrawn')),
 pack_evidence_id uuid,
 pack_hash text check (pack_hash ~ '^[a-f0-9]{64}$'),
 submitted_at timestamptz,
 decision_reference text,
 decision_evidence_id uuid,
 decided_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (status not in ('approved','denied') or (decision_reference is not null and decision_evidence_id is not null and decided_at is not null)),
 check (status <> 'pack_generated' or pack_evidence_id is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, pack_evidence_id) references lara.evidence (tenant_id, id),
 foreign key (tenant_id, decision_evidence_id) references lara.evidence (tenant_id, id)
);
create or replace function lara.registration_cases_validate() returns trigger language plpgsql as $$
begin
 if old.status in ('approved','denied','withdrawn') and new.status <> old.status then
  raise exception 'STATE_CONFLICT: registration case is terminal in state %', old.status using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not (
  (old.status = 'open' and new.status in ('pack_generated','withdrawn')) or
  (old.status = 'pack_generated' and new.status in ('submitted','withdrawn','pack_generated')) or
  (old.status = 'submitted' and new.status in ('approved','denied','withdrawn'))) then
  raise exception 'STATE_CONFLICT: registration case cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger registration_cases_validate before update on lara.registration_cases for each row execute function lara.registration_cases_validate();
create trigger registration_cases_touch before update on lara.registration_cases for each row execute function lara.touch_row();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['regulatory_profiles','schema_artifacts','return_runs','return_lines','return_source_links','filing_records','transmission_jobs','transmission_attempts','registration_cases'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.regulatory_profiles, lara.schema_artifacts, lara.return_runs, lara.transmission_jobs, lara.registration_cases to lara_api;
grant select, insert, delete on lara.return_lines, lara.return_source_links to lara_api;
grant select, insert on lara.filing_records, lara.transmission_attempts to lara_api;
grant select on lara.regulatory_profiles, lara.schema_artifacts, lara.return_runs, lara.return_lines, lara.return_source_links, lara.filing_records, lara.transmission_jobs, lara.transmission_attempts, lara.registration_cases to lara_worker, lara_audit_reader;
grant update on lara.transmission_jobs to lara_worker;
grant insert, update on lara.registration_cases to lara_worker;
grant insert on lara.transmission_attempts to lara_worker;
