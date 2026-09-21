-- P18 controlled extensibility and advanced assistance, four feature
-- releases behind their own capabilities: P18A report and custom-field
-- authoring (definitions over an allowlisted catalog compiled to
-- parameterized queries under a cost budget, published versions, custom
-- fields kept apart from statutory and accounting fields); P18B rule-change
-- proposals from cited issuances with an impact run over golden cases,
-- approved by an independent reviewer and never rewriting history; P18C
-- external draft tools under scoped, expiring grants that read authorized
-- reports and propose drafts or tasks only; P18D versioned industry packs
-- installed as reviewed configuration with profile snapshots for rollback.
-- No runtime tenant scripting engine exists.

insert into lara.capability_definitions (code, phase, title, depends_on) values
 ('report_authoring', 'P18A', 'Report and custom-field authoring', array['general_ledger']::text[]),
 ('rule_proposals', 'P18B', 'Rule impact and tax proposals', array['compliance']::text[]),
 ('client_tools', 'P18C', 'Client draft tools', array['ai_assistance']::text[]),
 ('industry_packs', 'P18D', 'Industry pack lifecycle', array['general_ledger']::text[]);

insert into lara.permission_definitions (code) values
 ('report_definition.run'),
 ('custom_field.create'), ('custom_field.read'), ('custom_field.publish'),
 ('tool.execute'),
 ('pack.read');

-- ---------------------------------------------------------------------------
-- P18A report definitions and custom fields
-- ---------------------------------------------------------------------------
create table lara.report_definitions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 name text not null check (length(btrim(name)) between 1 and 200),
 version_number integer not null default 1 check (version_number >= 1),
 metric_ids text[] not null check (cardinality(metric_ids) >= 1),
 dimension_ids text[] not null default '{}',
 filters jsonb not null default '[]'::jsonb check (jsonb_typeof(filters) = 'array'),
 sort jsonb not null default '[]'::jsonb check (jsonb_typeof(sort) = 'array'),
 ast jsonb not null check (jsonb_typeof(ast) = 'object'),
 ast_version text not null default 'ast-1' check (length(ast_version) between 1 and 20),
 state text not null default 'draft' check (state in ('draft','published','retired')),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 content_version bigint not null default 1 check (content_version >= 1),
 published_by uuid,
 published_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, name, version_number),
 check (state <> 'published' or (published_by is not null and published_at is not null)),
 check (published_by is null or published_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, published_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.report_definitions_validate() returns trigger language plpgsql as $$
begin
 if old.state = 'retired' and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a retired report definition is final' using errcode = 'check_violation';
 end if;
 if old.state = 'published' and (new.ast <> old.ast or new.content_hash <> old.content_hash) then
  raise exception 'STATE_CONFLICT: a published report definition is immutable; publish the next version' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not ((old.state = 'draft' and new.state in ('published','retired')) or (old.state = 'published' and new.state = 'retired')) then
  raise exception 'STATE_CONFLICT: report definition cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger report_definitions_validate before update on lara.report_definitions for each row execute function lara.report_definitions_validate();
create trigger report_definitions_touch before update on lara.report_definitions for each row execute function lara.touch_row();

-- Compiled runs: the scoped snapshot a run produced (checksum, row count,
-- cost) for reproducibility; rows are kept for the export window only.
create table lara.report_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 definition_id uuid not null,
 parameters jsonb not null default '{}'::jsonb check (jsonb_typeof(parameters) = 'object'),
 row_count integer not null check (row_count >= 0),
 cost integer not null check (cost >= 0),
 checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
 payload jsonb not null,
 scope_entity_ids uuid[] not null,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 foreign key (tenant_id, entity_id, definition_id) references lara.report_definitions (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index report_runs_definition on lara.report_runs (tenant_id, definition_id, created_at desc);
create trigger report_runs_append_only before update or delete on lara.report_runs for each row execute function lara.reject_mutation();

create table lara.custom_fields (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 resource_type text not null check (resource_type in ('party','document','journal','asset','project')),
 key text not null check (key ~ '^cf_[a-z][a-z0-9_]{1,31}$'),
 label text not null check (length(btrim(label)) between 1 and 100),
 field_type text not null check (field_type in ('text','number','date','boolean','choice')),
 validation jsonb not null default '{}'::jsonb check (jsonb_typeof(validation) = 'object'),
 visibility text not null default 'internal' check (visibility in ('internal','portal','masked')),
 state text not null default 'draft' check (state in ('draft','published','retired')),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 published_by uuid,
 published_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, resource_type, key),
 check (state <> 'published' or (published_by is not null and published_at is not null)),
 check (published_by is null or published_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, published_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger custom_fields_touch before update on lara.custom_fields for each row execute function lara.touch_row();

-- ---------------------------------------------------------------------------
-- P18B rule proposals
-- ---------------------------------------------------------------------------
create table lara.rule_proposals (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_evidence_ids jsonb not null check (jsonb_typeof(source_evidence_ids) = 'array' and jsonb_array_length(source_evidence_ids) >= 1),
 affected_profile_ids jsonb not null check (jsonb_typeof(affected_profile_ids) = 'array' and jsonb_array_length(affected_profile_ids) >= 1),
 proposed_rule_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(proposed_rule_ids) = 'array'),
 golden_case_ids jsonb not null check (jsonb_typeof(golden_case_ids) = 'array' and jsonb_array_length(golden_case_ids) >= 1),
 summary text,
 impact jsonb,
 impact_hash text check (impact_hash ~ '^[a-f0-9]{64}$'),
 impact_passed boolean,
 state text not null default 'draft' check (state in ('draft','assessed','approved','rejected','superseded')),
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
 check (state not in ('assessed','approved') or (impact is not null and impact_hash is not null and impact_passed is not null)),
 check (state <> 'approved' or (approved_by is not null and approved_at is not null and impact_passed)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.rule_proposals_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('rejected','superseded') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % proposal is final', old.state using errcode = 'check_violation';
 end if;
 if old.state = 'approved' and (new.state <> 'superseded' or new.content_hash <> old.content_hash) then
  raise exception 'STATE_CONFLICT: an approved proposal is immutable' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('assessed','rejected')) or
  (old.state = 'assessed' and new.state in ('draft','assessed','approved','rejected')) or
  (old.state = 'approved' and new.state = 'superseded')) then
  raise exception 'STATE_CONFLICT: proposal cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger rule_proposals_validate before update on lara.rule_proposals for each row execute function lara.rule_proposals_validate();
create trigger rule_proposals_touch before update on lara.rule_proposals for each row execute function lara.touch_row();

-- ---------------------------------------------------------------------------
-- P18C tool grants and runs
-- ---------------------------------------------------------------------------
create table lara.tool_grants (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 client_id uuid not null,
 tools text[] not null check (cardinality(tools) >= 1 and tools <@ array['read_report','read_evidence','propose_draft','propose_task']::text[]),
 entity_ids uuid[] not null check (cardinality(entity_ids) >= 1),
 expires_at timestamptz not null,
 rate_limit_per_minute integer not null default 60 check (rate_limit_per_minute between 1 and 600),
 state text not null default 'draft' check (state in ('draft','approved','revoked','expired')),
 revoked_reason text,
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
 check (state <> 'revoked' or revoked_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, client_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index tool_grants_client on lara.tool_grants (tenant_id, client_id, state);
create or replace function lara.tool_grants_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('revoked','expired') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % grant is final', old.state using errcode = 'check_violation';
 end if;
 if old.state = 'approved' and (new.tools <> old.tools or new.entity_ids <> old.entity_ids or new.expires_at > old.expires_at) then
  raise exception 'STATE_CONFLICT: an approved grant never widens; revoke it and grant another' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not ((old.state = 'draft' and new.state in ('approved','revoked')) or (old.state = 'approved' and new.state in ('revoked','expired'))) then
  raise exception 'STATE_CONFLICT: grant cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger tool_grants_validate before update on lara.tool_grants for each row execute function lara.tool_grants_validate();
create trigger tool_grants_touch before update on lara.tool_grants for each row execute function lara.touch_row();

-- Every tool request: the grant, the tool, the request hash and the
-- outcome; denied requests are kept as evidence. Append-only.
create table lara.tool_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 grant_id uuid not null,
 tool text not null check (length(tool) between 1 and 64),
 request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
 outcome text not null check (outcome in ('served','proposed','denied','rate_limited')),
 reason text,
 result_resource_type text,
 result_resource_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 foreign key (tenant_id, entity_id, grant_id) references lara.tool_grants (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index tool_runs_grant on lara.tool_runs (tenant_id, grant_id, created_at desc);
create trigger tool_runs_append_only before update or delete on lara.tool_runs for each row execute function lara.reject_mutation();

-- ---------------------------------------------------------------------------
-- P18D industry pack versions
-- ---------------------------------------------------------------------------
create table lara.pack_versions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 pack_id text not null check (pack_id ~ '^[a-z][a-z0-9-]{1,63}$'),
 version text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
 manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
 manifest_hash text not null check (manifest_hash ~ '^[a-f0-9]{64}$'),
 dependencies jsonb not null default '[]'::jsonb check (jsonb_typeof(dependencies) = 'array'),
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
 applied jsonb not null default '{}'::jsonb check (jsonb_typeof(applied) = 'object'),
 state text not null default 'installing' check (state in ('installing','installed','failed','superseded','rolled_back')),
 failure_reason text,
 job_id uuid,
 previous_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version_no bigint not null default 1 check (version_no >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, pack_id, version),
 check (state <> 'failed' or failure_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, previous_id) references lara.pack_versions (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index pack_versions_one_installed on lara.pack_versions (tenant_id, entity_id, pack_id) where state = 'installed';
create or replace function lara.pack_versions_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('failed','rolled_back') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % pack version is final', old.state using errcode = 'check_violation';
 end if;
 if new.manifest_hash <> old.manifest_hash or new.snapshot <> old.snapshot and old.state <> 'installing' then
  raise exception 'STATE_CONFLICT: a pack version keeps its manifest and snapshot' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not ((old.state = 'installing' and new.state in ('installed','failed')) or (old.state = 'installed' and new.state in ('superseded','rolled_back')) or (old.state = 'superseded' and new.state = 'installed')) then
  raise exception 'STATE_CONFLICT: pack version cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger pack_versions_validate before update on lara.pack_versions for each row execute function lara.pack_versions_validate();
create or replace function lara.pack_versions_touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.version_no := old.version_no + 1; return new; end $$;
create trigger pack_versions_touch before update on lara.pack_versions for each row execute function lara.pack_versions_touch();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['report_definitions','report_runs','custom_fields','rule_proposals','tool_grants','tool_runs','pack_versions'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.report_definitions, lara.custom_fields, lara.rule_proposals, lara.tool_grants, lara.pack_versions to lara_api;
grant select, insert on lara.report_runs, lara.tool_runs to lara_api;
grant select, update on lara.pack_versions to lara_worker;
-- The worker applies and rolls back packs: settings drafts and report definitions under the installer's identity.
grant insert, update on lara.settings_versions, lara.report_definitions to lara_worker;
grant insert, update on lara.approval_requests to lara_worker;
grant select on lara.report_definitions, lara.report_runs, lara.custom_fields, lara.rule_proposals, lara.tool_grants, lara.tool_runs, lara.pack_versions to lara_worker, lara_audit_reader;
