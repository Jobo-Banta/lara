-- P12 evidence-backed AI assistance: per-tenant feature configurations that
-- enable only behind a passing, Finance-accepted evaluation of the exact
-- model and prompt versions, runs that record the model, prompt and tool
-- schema versions, the permission context, minimized input references, the
-- scope, cost and every tool call (allowed or denied), suggestions with
-- per-field evidence and uncertainty that a named reviewer accepts, edits or
-- rejects, and append-only evaluation sets and results. No table here holds
-- a financial fact; deterministic controls remain authoritative.

create table lara.evaluation_sets (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 feature text not null check (feature in ('capture','coding','matching','explain','ask_books','close_draft','audit_pack','registration_draft')),
 version text not null check (length(version) between 1 and 100),
 hash text not null check (hash ~ '^[a-f0-9]{64}$'),
 consent_basis text not null check (length(btrim(consent_basis)) between 1 and 2000),
 item_count integer not null check (item_count >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, feature, version),
 foreign key (tenant_id) references lara.tenants (id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger evaluation_sets_append_only before update or delete on lara.evaluation_sets for each row execute function lara.reject_mutation();

create table lara.evaluation_results (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 evaluation_set_id uuid not null,
 feature text not null check (feature in ('capture','coding','matching','explain','ask_books','close_draft','audit_pack','registration_draft')),
 model_version text not null check (length(model_version) between 1 and 100),
 prompt_version text not null check (length(prompt_version) between 1 and 100),
 metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
 thresholds jsonb not null check (jsonb_typeof(thresholds) = 'object'),
 failures jsonb not null default '[]'::jsonb check (jsonb_typeof(failures) = 'array'),
 item_count integer not null check (item_count >= 1),
 passed boolean not null,
 accepted_by uuid,
 evaluated_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 check (accepted_by is null or accepted_by <> created_by),
 foreign key (tenant_id, evaluation_set_id) references lara.evaluation_sets (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, accepted_by) references lara.principals (tenant_id, id)
);
create index evaluation_results_lookup on lara.evaluation_results (tenant_id, feature, model_version, prompt_version, passed);
-- Results are append-only except for Finance's acceptance, recorded once.
create or replace function lara.evaluation_results_validate() returns trigger language plpgsql as $$
begin
 if tg_op = 'DELETE' then
  if current_setting('lara.maintenance', true) = 'teardown' and (exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper)) or exists (select 1 from pg_tables where schemaname = tg_table_schema and tablename = tg_table_name and tableowner = current_user)) then return old; end if;
  raise exception 'APPEND_ONLY: evaluation_results rows cannot be deleted by the application' using errcode = 'integrity_constraint_violation';
 end if;
 if old.accepted_by is not null or new.accepted_by is null or new.metrics <> old.metrics or new.passed <> old.passed or new.model_version <> old.model_version or new.prompt_version <> old.prompt_version or new.item_count <> old.item_count or new.failures <> old.failures or new.thresholds <> old.thresholds then
  raise exception 'APPEND_ONLY: evaluation results change only by Finance acceptance, once' using errcode = 'integrity_constraint_violation';
 end if;
 return new;
end $$;
create trigger evaluation_results_validate before update or delete on lara.evaluation_results for each row execute function lara.evaluation_results_validate();

create table lara.model_feature_configs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 feature text not null check (feature in ('capture','coding','matching','explain','ask_books','close_draft','audit_pack','registration_draft')),
 enabled boolean not null default false,
 budget_minor bigint not null default 0 check (budget_minor >= 0),
 spent_minor bigint not null default 0 check (spent_minor >= 0),
 budget_month date not null default date_trunc('month', now())::date,
 provider_policy jsonb not null default '{}'::jsonb check (jsonb_typeof(provider_policy) = 'object'),
 model_version text not null check (length(model_version) between 1 and 100),
 prompt_version text not null check (length(prompt_version) between 1 and 100),
 tool_schema_version text not null check (length(tool_schema_version) between 1 and 100),
 evaluation_result_id uuid,
 approved_by uuid,
 reason text,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, feature),
 foreign key (tenant_id) references lara.tenants (id),
 foreign key (tenant_id, evaluation_result_id) references lara.evaluation_results (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);
-- A feature enables only behind a passing, accepted evaluation of the exact
-- model and prompt versions (capture readers need at least 200 held-out
-- items) and an approver other than the configuring principal. A model or
-- prompt update on an enabled feature needs its own evaluation.
create or replace function lara.model_feature_configs_gate() returns trigger language plpgsql as $$
declare v_eval lara.evaluation_results;
begin
 if new.enabled then
  if new.approved_by is null or new.approved_by = new.created_by then
   raise exception 'SELF_APPROVAL: enabling an AI feature needs an approver other than the configuring principal' using errcode = 'check_violation';
  end if;
  select * into v_eval from lara.evaluation_results r where r.tenant_id = new.tenant_id and r.id = new.evaluation_result_id;
  if v_eval.id is null or v_eval.feature <> new.feature or v_eval.model_version <> new.model_version or v_eval.prompt_version <> new.prompt_version or not v_eval.passed or v_eval.accepted_by is null then
   raise exception 'RULE_PROFILE_NOT_APPROVED: evaluation required — feature % with model % prompt % has no passing, accepted evaluation', new.feature, new.model_version, new.prompt_version using errcode = 'check_violation';
  end if;
  if new.feature = 'capture' and v_eval.item_count < 200 then
   raise exception 'RULE_PROFILE_NOT_APPROVED: evaluation required — capture readers need at least 200 held-out items (% evaluated)', v_eval.item_count using errcode = 'check_violation';
  end if;
 end if;
 return new;
end $$;
create trigger model_feature_configs_gate before insert or update on lara.model_feature_configs for each row execute function lara.model_feature_configs_gate();
create trigger model_feature_configs_touch before update on lara.model_feature_configs for each row execute function lara.touch_row();

create table lara.ai_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 feature text not null check (feature in ('capture','coding','matching','explain','ask_books','close_draft','audit_pack','registration_draft')),
 model_version text not null check (length(model_version) between 1 and 100),
 prompt_version text not null check (length(prompt_version) between 1 and 100),
 tool_schema_version text not null check (length(tool_schema_version) between 1 and 100),
 input_refs jsonb not null check (jsonb_typeof(input_refs) = 'object'),
 scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
 permission_context jsonb not null default '{}'::jsonb check (jsonb_typeof(permission_context) = 'object'),
 tool_calls jsonb not null default '[]'::jsonb check (jsonb_typeof(tool_calls) = 'array'),
 status text not null default 'queued' check (status in ('queued','running','succeeded','abstained','failed','revoked')),
 error_code text,
 cost_minor bigint not null default 0 check (cost_minor >= 0),
 started_at timestamptz,
 completed_at timestamptz,
 requested_by uuid not null,
 revocation_version bigint not null,
 job_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (status not in ('succeeded','abstained','failed','revoked') or completed_at is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, requested_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index ai_runs_queue on lara.ai_runs (tenant_id, entity_id, status, created_at);
create or replace function lara.ai_runs_validate() returns trigger language plpgsql as $$
begin
 if old.status in ('succeeded','abstained','failed','revoked') and (new.status <> old.status or new.tool_calls <> old.tool_calls or new.cost_minor <> old.cost_minor) then
  raise exception 'STATE_CONFLICT: a completed AI run is immutable' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not (
  (old.status = 'queued' and new.status in ('running','failed','revoked')) or
  (old.status = 'running' and new.status in ('succeeded','abstained','failed','revoked'))) then
  raise exception 'STATE_CONFLICT: AI run cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger ai_runs_validate before update on lara.ai_runs for each row execute function lara.ai_runs_validate();
create trigger ai_runs_touch before update on lara.ai_runs for each row execute function lara.touch_row();

create table lara.ai_suggestions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 run_id uuid not null,
 feature text not null check (feature in ('capture','coding','matching','explain','ask_books','close_draft','audit_pack','registration_draft')),
 fields_json jsonb not null default '[]'::jsonb check (jsonb_typeof(fields_json) = 'array'),
 source_spans jsonb not null default '[]'::jsonb check (jsonb_typeof(source_spans) = 'array'),
 uncertainty text not null check (uncertainty in ('low','medium','high','unknown')),
 answer text,
 report_ref jsonb check (report_ref is null or jsonb_typeof(report_ref) = 'object'),
 model_version text not null check (length(model_version) between 1 and 100),
 state text not null default 'proposed' check (state in ('proposed','accepted','edited','rejected','abstained')),
 review_decision text check (review_decision is null or review_decision in ('accept','edit','reject')),
 field_changes jsonb not null default '[]'::jsonb check (jsonb_typeof(field_changes) = 'array'),
 reviewer_id uuid,
 review_reason text,
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, run_id),
 check (state not in ('accepted','edited','rejected') or (reviewer_id is not null and review_decision is not null and reviewed_at is not null)),
 check (state <> 'rejected' or review_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, run_id) references lara.ai_runs (tenant_id, entity_id, id),
 foreign key (tenant_id, reviewer_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index ai_suggestions_queue on lara.ai_suggestions (tenant_id, entity_id, state, created_at);
create or replace function lara.ai_suggestions_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('accepted','edited','rejected','abstained') then
  raise exception 'STATE_CONFLICT: a reviewed or abstained suggestion is immutable' using errcode = 'check_violation';
 end if;
 if new.fields_json <> old.fields_json or new.answer is distinct from old.answer or new.model_version <> old.model_version or new.run_id <> old.run_id then
  raise exception 'STATE_CONFLICT: the proposal never changes; edits are recorded as field changes' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (old.state = 'proposed' and new.state in ('accepted','edited','rejected')) then
  raise exception 'STATE_CONFLICT: suggestion cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger ai_suggestions_validate before update on lara.ai_suggestions for each row execute function lara.ai_suggestions_validate();
create trigger ai_suggestions_touch before update on lara.ai_suggestions for each row execute function lara.touch_row();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['evaluation_sets','evaluation_results','model_feature_configs','ai_runs','ai_suggestions'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.model_feature_configs, lara.ai_runs, lara.ai_suggestions to lara_api;
grant select, insert on lara.evaluation_sets to lara_api;
grant select, insert, update on lara.evaluation_results to lara_api;
grant select on lara.evaluation_sets, lara.evaluation_results, lara.model_feature_configs, lara.ai_runs, lara.ai_suggestions to lara_worker, lara_audit_reader;
-- The worker executes runs: it completes the run, records the cost and the tool calls and writes the suggestion.
grant update on lara.ai_runs, lara.model_feature_configs to lara_worker;
grant insert on lara.ai_suggestions to lara_worker;
