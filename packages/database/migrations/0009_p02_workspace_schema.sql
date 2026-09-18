-- P02 finance workspace: production organization, security, party, evidence,
-- task, obligation, approval and durable operation tables.
-- Conventions: docs/development/05-data-and-accounting.md. Tenant rows carry
-- id/tenant_id/created_at/created_by/updated_at/version and unique
-- (tenant_id,id); entity rows add entity_id and unique (tenant_id,entity_id,id).
-- Runtime roles see only the tenant set in lara.tenant_id; nothing here touches
-- the lara_demo prototype schema. Only definitions and role templates are seeded.

-- ---------------------------------------------------------------------------
-- Session context and shared trigger functions
-- ---------------------------------------------------------------------------
create or replace function lara.current_tenant() returns uuid language sql stable as $$
 select nullif(current_setting('lara.tenant_id', true), '')::uuid
$$;
create or replace function lara.current_principal() returns uuid language sql stable as $$
 select nullif(current_setting('lara.principal_id', true), '')::uuid
$$;

-- Every update advances the row version and timestamp; clients express
-- optimistic concurrency through `where version = $expected`, never by writing
-- the version themselves.
create or replace function lara.touch_row() returns trigger language plpgsql as $$
begin
 new.version := old.version + 1;
 new.updated_at := now();
 new.created_at := old.created_at;
 new.created_by := old.created_by;
 new.tenant_id := old.tenant_id;
 return new;
end $$;

-- Append-only guard. Runtime roles never own tables and are NOBYPASSRLS, so
-- they can never pass the maintenance branch; the table owner or a superuser
-- may remove rows only after explicitly setting lara.maintenance for a
-- restore or test teardown.
create or replace function lara.reject_mutation() returns trigger language plpgsql as $$
begin
 if tg_op = 'DELETE' and current_setting('lara.maintenance', true) = 'teardown' and (
  exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper))
  or exists (select 1 from pg_tables where schemaname = tg_table_schema and tablename = tg_table_name and tableowner = current_user)) then
  return old;
 end if;
 raise exception 'APPEND_ONLY: % rows cannot be % by the application', tg_table_name, lower(tg_op)
  using errcode = 'integrity_constraint_violation';
end $$;

create or replace function lara.jsonb_text_array(value jsonb) returns boolean language sql immutable as $$
 select jsonb_typeof(value) = 'array'
  and not exists (select 1 from jsonb_array_elements(value) e where jsonb_typeof(e) <> 'string')
$$;

-- ---------------------------------------------------------------------------
-- Global definitions (seeded, not tenant data)
-- ---------------------------------------------------------------------------
create table lara.permission_definitions (
 code text primary key check (code ~ '^[a-z_]+\.[a-z_]+$'),
 created_at timestamptz not null default now()
);

create table lara.capability_definitions (
 code text primary key check (code ~ '^[a-z_]+$'),
 phase text not null check (phase ~ '^P[0-9]{2}[A-Z]?$'),
 title text not null,
 depends_on text[] not null default '{}'
);

create table lara.role_templates (
 code text primary key check (code ~ '^[a-z_]+$'),
 name text not null,
 permissions jsonb not null check (lara.jsonb_text_array(permissions) and jsonb_array_length(permissions) > 0),
 protected boolean not null default true
);

create or replace function lara.check_permission_codes(value jsonb) returns boolean language sql stable as $$
 select lara.jsonb_text_array(value)
  and not exists (
   select 1 from jsonb_array_elements_text(value) p
   where not exists (select 1 from lara.permission_definitions d where d.code = p)
  )
$$;

-- ---------------------------------------------------------------------------
-- Tenancy and organization
-- ---------------------------------------------------------------------------
create table lara.tenants (
 id uuid primary key default gen_random_uuid(),
 slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 mode text not null check (mode in ('demo','live')),
 status text not null default 'active' check (status in ('active','suspended','archived')),
 created_at timestamptz not null default now(),
 created_by uuid,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1)
);
create or replace function lara.tenant_mode_immutable() returns trigger language plpgsql as $$
begin
 if new.mode <> old.mode then raise exception 'STATE_CONFLICT: tenant mode is immutable' using errcode = 'check_violation'; end if;
 return new;
end $$;
create trigger tenants_touch before update on lara.tenants for each row execute function lara.touch_row();
create trigger tenants_mode before update on lara.tenants for each row execute function lara.tenant_mode_immutable();

create table lara.entities (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null references lara.tenants(id),
 legal_name text not null check (length(btrim(legal_name)) between 1 and 500),
 registration_profile_id uuid,
 tax_id_encrypted text,
 fiscal_year_start_month integer not null check (fiscal_year_start_month between 1 and 12),
 base_currency text not null check (base_currency ~ '^[A-Z]{3}$'),
 timezone text not null check (length(timezone) between 1 and 64),
 status text not null default 'draft' check (status in ('draft','pending_activation','active','suspended','archived')),
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id)
);
create index entities_tenant_status on lara.entities (tenant_id, status, created_at, id);
create trigger entities_touch before update on lara.entities for each row execute function lara.touch_row();

create table lara.branches (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 address_json jsonb not null default '{}'::jsonb check (jsonb_typeof(address_json) = 'object'),
 status text not null default 'active' check (status in ('active','archived')),
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, code),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id)
);
create trigger branches_touch before update on lara.branches for each row execute function lara.touch_row();

create table lara.books (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
 kind text not null check (kind in ('primary','separate')),
 functional_currency text not null check (functional_currency ~ '^[A-Z]{3}$'),
 source_owner text not null default 'lara' check (length(source_owner) between 1 and 100),
 status text not null default 'draft' check (status in ('draft','active','archived')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, code),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id)
);
create unique index books_one_primary on lara.books (tenant_id, entity_id) where kind = 'primary' and status <> 'archived';
create trigger books_touch before update on lara.books for each row execute function lara.touch_row();

-- ---------------------------------------------------------------------------
-- Security: principals, roles, memberships, delegation, approval policies
-- ---------------------------------------------------------------------------
create table lara.principals (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null references lara.tenants(id),
 oidc_issuer text not null check (length(oidc_issuer) between 1 and 500),
 oidc_subject text not null check (length(oidc_subject) between 1 and 500),
 display_name text not null check (length(btrim(display_name)) between 1 and 200),
 status text not null default 'active' check (status in ('active','disabled')),
 revocation_version bigint not null default 1 check (revocation_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, oidc_issuer, oidc_subject)
);
create trigger principals_touch before update on lara.principals for each row execute function lara.touch_row();

create table lara.roles (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null references lara.tenants(id),
 code text not null check (code ~ '^[a-z][a-z0-9_]{0,63}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 permissions jsonb not null check (lara.jsonb_text_array(permissions) and jsonb_array_length(permissions) > 0),
 protected boolean not null default false,
 status text not null default 'draft' check (status in ('draft','pending_approval','approved','archived')),
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, code)
);
create or replace function lara.roles_validate() returns trigger language plpgsql as $$
begin
 if not lara.check_permission_codes(new.permissions) then
  raise exception 'VALIDATION_FAILED: role permissions must be published permission codes' using errcode = 'check_violation';
 end if;
 if tg_op = 'UPDATE' and old.status = 'approved' and new.permissions <> old.permissions and new.status = 'approved' then
  raise exception 'STATE_CONFLICT: approved role permissions change only through a new approval' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger roles_validate before insert or update on lara.roles for each row execute function lara.roles_validate();
create trigger roles_touch before update on lara.roles for each row execute function lara.touch_row();

create table lara.memberships (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null references lara.tenants(id),
 principal_id uuid not null,
 entity_id uuid,
 branch_id uuid,
 role_id uuid not null,
 valid_from timestamptz not null default now(),
 valid_to timestamptz,
 status text not null default 'active' check (status in ('active','revoked')),
 revoked_reason text,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 check (valid_to is null or valid_to > valid_from),
 check (branch_id is null or entity_id is not null),
 check (status <> 'revoked' or revoked_reason is not null),
 foreign key (tenant_id, principal_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id),
 foreign key (tenant_id, role_id) references lara.roles (tenant_id, id)
);
create index memberships_principal on lara.memberships (tenant_id, principal_id, status, valid_to);
create index memberships_entity on lara.memberships (tenant_id, entity_id, status);
-- Every membership change advances the principal revocation version so cached
-- sessions, queued exports and jobs recheck authorization.
create or replace function lara.memberships_revoke_version() returns trigger language plpgsql as $$
begin
 update lara.principals set revocation_version = revocation_version + 1 where tenant_id = new.tenant_id and id = new.principal_id;
 if tg_op = 'UPDATE' and old.principal_id <> new.principal_id then
  update lara.principals set revocation_version = revocation_version + 1 where tenant_id = old.tenant_id and id = old.principal_id;
 end if;
 return null;
end $$;
create trigger memberships_touch before update on lara.memberships for each row execute function lara.touch_row();
create trigger memberships_revocation after insert or update on lara.memberships for each row execute function lara.memberships_revoke_version();

create table lara.delegation (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null references lara.tenants(id),
 principal_id uuid not null,
 delegate_id uuid not null,
 permission_scope jsonb not null check (lara.jsonb_text_array(permission_scope) and jsonb_array_length(permission_scope) > 0),
 valid_from timestamptz not null,
 valid_to timestamptz not null,
 approved_by uuid not null,
 status text not null default 'active' check (status in ('active','revoked','expired')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 check (principal_id <> delegate_id),
 check (approved_by <> delegate_id),
 check (valid_to > valid_from),
 foreign key (tenant_id, principal_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, delegate_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);
create or replace function lara.delegation_validate() returns trigger language plpgsql as $$
begin
 if not lara.check_permission_codes(new.permission_scope) then
  raise exception 'VALIDATION_FAILED: delegation scope must be published permission codes' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger delegation_validate before insert or update on lara.delegation for each row execute function lara.delegation_validate();
create trigger delegation_touch before update on lara.delegation for each row execute function lara.touch_row();

create table lara.approval_policies (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 type text not null check (type ~ '^[a-z][a-z0-9_]{0,63}$'),
 version_number integer not null check (version_number >= 1),
 conditions_json jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions_json) = 'object'),
 required_steps_json jsonb not null check (jsonb_typeof(required_steps_json) = 'array' and jsonb_array_length(required_steps_json) > 0),
 effective_from date not null,
 approved_by uuid,
 status text not null default 'draft' check (status in ('draft','pending_approval','approved','active','superseded','rejected')),
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, type, version_number),
 check (status not in ('approved','active','superseded') or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);
create unique index approval_policies_one_active on lara.approval_policies (tenant_id, entity_id, type) where status = 'active';
-- Approved policy versions are immutable; changes are new version numbers.
create or replace function lara.approval_policies_immutable() returns trigger language plpgsql as $$
begin
 if old.status in ('approved','active','superseded') and (
  new.conditions_json <> old.conditions_json or new.required_steps_json <> old.required_steps_json
  or new.effective_from <> old.effective_from or new.type <> old.type or new.version_number <> old.version_number
  or new.content_hash <> old.content_hash or new.approved_by <> old.approved_by) then
  raise exception 'STATE_CONFLICT: approved approval policy versions are immutable' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger approval_policies_immutable before update on lara.approval_policies for each row execute function lara.approval_policies_immutable();
create trigger approval_policies_touch before update on lara.approval_policies for each row execute function lara.touch_row();

create table lara.capability_activations (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 capability text not null references lara.capability_definitions (code),
 status text not null default 'requested' check (status in ('requested','approved','active','disabled','rejected')),
 profile_version text not null check (length(profile_version) between 1 and 100),
 evidence_manifest jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_manifest) = 'array'),
 approved_by uuid,
 activated_at timestamptz,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, capability),
 check (status <> 'active' or (approved_by is not null and activated_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);
-- Activation requires every declared dependency to be active on the same entity.
create or replace function lara.capability_dependencies() returns trigger language plpgsql as $$
declare missing text;
begin
 if new.status = 'active' then
  select d into missing from lara.capability_definitions c, unnest(c.depends_on) d
   where c.code = new.capability
   and not exists (select 1 from lara.capability_activations a where a.tenant_id = new.tenant_id and a.entity_id = new.entity_id and a.capability = d and a.status = 'active')
   limit 1;
  if missing is not null then
   raise exception 'FEATURE_NOT_ENABLED: capability % requires % to be active', new.capability, missing using errcode = 'check_violation';
  end if;
 end if;
 return new;
end $$;
create trigger capability_activations_dependencies before insert or update on lara.capability_activations for each row execute function lara.capability_dependencies();
create trigger capability_activations_touch before update on lara.capability_activations for each row execute function lara.touch_row();

create table lara.onboarding_checks (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 check_code text not null check (check_code ~ '^[a-z][a-z0-9_]{0,63}$'),
 status text not null default 'pending' check (status in ('pending','passed','failed','waived')),
 evidence_id uuid,
 waiver_reason text,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, check_code),
 check (status <> 'waived' or waiver_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id)
);
create trigger onboarding_checks_touch before update on lara.onboarding_checks for each row execute function lara.touch_row();

create table lara.settings_versions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
 version_number integer not null check (version_number >= 1),
 payload jsonb not null check (jsonb_typeof(payload) = 'object'),
 payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
 approved_by uuid,
 effective_at timestamptz,
 status text not null default 'draft' check (status in ('draft','pending_approval','approved','superseded','rejected')),
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, kind, version_number),
 check (status not in ('approved','superseded') or (approved_by is not null and effective_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);
create or replace function lara.settings_versions_immutable() returns trigger language plpgsql as $$
begin
 if old.status in ('approved','superseded') and (new.payload <> old.payload or new.payload_hash <> old.payload_hash or new.approved_by <> old.approved_by or new.effective_at <> old.effective_at) then
  raise exception 'STATE_CONFLICT: approved settings versions are immutable' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger settings_versions_immutable before update on lara.settings_versions for each row execute function lara.settings_versions_immutable();
create trigger settings_versions_touch before update on lara.settings_versions for each row execute function lara.touch_row();

-- Live entities activate only with an approved registration profile and no
-- failed or pending onboarding check; demo tenants may activate freely.
create or replace function lara.entities_activation_gate() returns trigger language plpgsql as $$
declare tenant_mode text;
begin
 if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active') then
  select mode into tenant_mode from lara.tenants where id = new.tenant_id;
  if tenant_mode = 'live' then
   if new.registration_profile_id is null then
    raise exception 'RULE_PROFILE_NOT_APPROVED: live entity activation requires an approved registration profile' using errcode = 'check_violation';
   end if;
   if exists (select 1 from lara.onboarding_checks c where c.tenant_id = new.tenant_id and c.entity_id = new.id and c.status in ('pending','failed')) then
    raise exception 'STATE_CONFLICT: onboarding checks must pass or be waived before activation' using errcode = 'check_violation';
   end if;
  end if;
 end if;
 return new;
end $$;
create trigger entities_activation before insert or update on lara.entities for each row execute function lara.entities_activation_gate();

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------
create table lara.party (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 legal_name text not null check (length(btrim(legal_name)) between 1 and 500),
 normalized_name text generated always as (lower(regexp_replace(legal_name, '\s+', ' ', 'g'))) stored,
 tax_id_encrypted text,
 identity_status text not null check (identity_status in ('known','unknown','not_applicable')),
 address_json jsonb not null default '{}'::jsonb check (jsonb_typeof(address_json) = 'object'),
 status text not null default 'active' check (status in ('draft','active','archived')),
 merged_into uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (identity_status <> 'known' or tax_id_encrypted is not null),
 check (merged_into is null or (status = 'archived' and merged_into <> id)),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, merged_into) references lara.party (tenant_id, entity_id, id)
);
create index party_search on lara.party (tenant_id, entity_id, normalized_name);
create index party_list on lara.party (tenant_id, entity_id, status, created_at, id);
create trigger party_touch before update on lara.party for each row execute function lara.touch_row();

create table lara.party_roles (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 party_id uuid not null,
 role text not null check (role in ('customer','supplier','employee','bank')),
 terms_id uuid,
 control_account_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, party_id, role),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id)
);
create trigger party_roles_touch before update on lara.party_roles for each row execute function lara.touch_row();

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------
create table lara.evidence (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 object_key text not null check (length(object_key) between 1 and 1024),
 filename text not null check (length(filename) between 1 and 500),
 sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
 mime text not null check (mime in ('application/pdf','image/jpeg','image/png','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
 byte_count bigint not null check (byte_count between 1 and 20971520),
 status text not null default 'quarantined' check (status in ('quarantined','scanning','available','rejected')),
 classification text not null check (classification in ('internal','confidential','restricted')),
 retention_policy_id uuid,
 legal_hold boolean not null default false,
 rejection_reason text,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (object_key),
 check (status <> 'rejected' or rejection_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id)
);
create index evidence_list on lara.evidence (tenant_id, entity_id, status, created_at, id);
-- Published state machine: quarantined → scanning|rejected; scanning → available|rejected.
create or replace function lara.evidence_transition() returns trigger language plpgsql as $$
begin
 if new.status <> old.status and not (
  (old.status = 'quarantined' and new.status in ('scanning','rejected')) or
  (old.status = 'scanning' and new.status in ('available','rejected'))) then
  raise exception 'STATE_CONFLICT: evidence cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 if new.sha256 <> old.sha256 or new.byte_count <> old.byte_count or new.object_key <> old.object_key or new.mime <> old.mime then
  raise exception 'STATE_CONFLICT: evidence identity is immutable' using errcode = 'check_violation';
 end if;
 if old.legal_hold and not new.legal_hold and new.status = 'rejected' then
  raise exception 'STATE_CONFLICT: evidence under legal hold cannot be rejected' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger evidence_transition before update on lara.evidence for each row execute function lara.evidence_transition();
create trigger evidence_touch before update on lara.evidence for each row execute function lara.touch_row();

create table lara.party_bank_accounts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 party_id uuid not null,
 encrypted_account text not null check (length(encrypted_account) between 1 and 2000),
 bank_code text not null check (bank_code ~ '^[A-Z0-9]{3,20}$'),
 verification_evidence_id uuid,
 approved_by uuid,
 status text not null default 'pending' check (status in ('pending','approved','superseded','rejected')),
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (status <> 'approved' or (approved_by is not null and verification_evidence_id is not null)),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, verification_evidence_id) references lara.evidence (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id)
);
-- Approved beneficiary details never change in place; a change is a new row and
-- the prior approval is superseded.
create or replace function lara.party_bank_accounts_immutable() returns trigger language plpgsql as $$
begin
 if old.status in ('approved','superseded') and (new.encrypted_account <> old.encrypted_account or new.bank_code <> old.bank_code or new.content_hash <> old.content_hash or new.party_id <> old.party_id) then
  raise exception 'STATE_CONFLICT: approved bank account details are immutable' using errcode = 'check_violation';
 end if;
 if old.status = 'approved' and new.status = 'pending' then
  raise exception 'STATE_CONFLICT: approved bank accounts move only to superseded' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger party_bank_accounts_immutable before update on lara.party_bank_accounts for each row execute function lara.party_bank_accounts_immutable();
create trigger party_bank_accounts_touch before update on lara.party_bank_accounts for each row execute function lara.touch_row();

create table lara.evidence_links (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 evidence_id uuid not null,
 resource_type text not null check (resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
 resource_id uuid not null,
 resource_version bigint not null check (resource_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, evidence_id, resource_type, resource_id, resource_version),
 foreign key (tenant_id, entity_id, evidence_id) references lara.evidence (tenant_id, entity_id, id)
);
create index evidence_links_resource on lara.evidence_links (tenant_id, entity_id, resource_type, resource_id);
create trigger evidence_links_append_only before update or delete on lara.evidence_links for each row execute function lara.reject_mutation();

-- ---------------------------------------------------------------------------
-- Tasks and obligations
-- ---------------------------------------------------------------------------
create table lara.tasks (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
 source_type text not null check (source_type ~ '^[a-z][a-z0-9_]{0,63}$'),
 source_id uuid not null,
 owner_id uuid,
 due_at timestamptz,
 status text not null default 'open' check (status in ('open','assigned','in_progress','waiting_for_information','resolved','cancelled')),
 severity text not null default 'normal' check (severity in ('low','normal','high','critical')),
 cause_key text not null default 'default' check (cause_key ~ '^[a-z0-9][a-z0-9_.:-]{0,199}$'),
 reason text not null check (length(btrim(reason)) between 1 and 2000),
 resolution text,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (status not in ('assigned','in_progress','waiting_for_information') or owner_id is not null),
 check (status <> 'waiting_for_information' or due_at is not null),
 check (status <> 'resolved' or resolution is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, owner_id) references lara.principals (tenant_id, id)
);
create unique index tasks_one_active_cause on lara.tasks (tenant_id, entity_id, source_type, source_id, kind, cause_key) where status not in ('resolved','cancelled');
create index tasks_queue on lara.tasks (tenant_id, entity_id, owner_id, status, due_at, id);
create index tasks_source on lara.tasks (tenant_id, entity_id, source_type, source_id);
create trigger tasks_touch before update on lara.tasks for each row execute function lara.touch_row();

create table lara.task_comments (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 task_id uuid not null,
 body text not null check (length(btrim(body)) between 1 and 4000),
 evidence_id uuid,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 primary key (id),
 unique (tenant_id, id),
 foreign key (tenant_id, entity_id, task_id) references lara.tasks (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, evidence_id) references lara.evidence (tenant_id, entity_id, id)
);
create index task_comments_task on lara.task_comments (tenant_id, entity_id, task_id, created_at, id);
create trigger task_comments_append_only before update or delete on lara.task_comments for each row execute function lara.reject_mutation();

create table lara.obligations (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
 period_key text not null check (period_key ~ '^[0-9]{4}(-[0-9]{2}){0,2}(-Q[1-4])?$'),
 rule_profile text not null default 'default' check (length(rule_profile) between 1 and 100),
 rule_version text not null check (length(rule_version) between 1 and 100),
 due_at timestamptz not null,
 owner_id uuid not null,
 status text not null default 'open' check (status in ('open','in_progress','completed','waived')),
 evidence_id uuid,
 completed_at timestamptz,
 completed_by uuid,
 waiver_reason text,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, kind, period_key, rule_profile),
 check (status <> 'completed' or (evidence_id is not null and completed_at is not null and completed_by is not null)),
 check (status <> 'waived' or waiver_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, owner_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, completed_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, entity_id, evidence_id) references lara.evidence (tenant_id, entity_id, id)
);
create index obligations_calendar on lara.obligations (tenant_id, entity_id, status, due_at, id);
-- Completion evidence is retained when templates change; a completed obligation
-- keeps its evidence and rule version.
create or replace function lara.obligations_retain_completion() returns trigger language plpgsql as $$
begin
 if old.status = 'completed' and (new.evidence_id <> old.evidence_id or new.rule_version <> old.rule_version or new.completed_at <> old.completed_at or new.completed_by <> old.completed_by or new.status <> 'completed') then
  raise exception 'STATE_CONFLICT: completed obligations retain their completion evidence' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger obligations_retain before update on lara.obligations for each row execute function lara.obligations_retain_completion();
create trigger obligations_touch before update on lara.obligations for each row execute function lara.touch_row();

-- ---------------------------------------------------------------------------
-- Approval requests and decisions
-- ---------------------------------------------------------------------------
create table lara.approval_requests (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 resource_type text not null check (resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
 resource_id uuid not null,
 content_version bigint not null check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 policy_id uuid,
 policy_version integer not null check (policy_version >= 1),
 step integer not null check (step >= 1),
 required_role_id uuid,
 status text not null default 'pending' check (status in ('pending','approved','rejected','invalidated','expired')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, resource_type, resource_id, content_version, step),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, policy_id) references lara.approval_policies (tenant_id, entity_id, id),
 foreign key (tenant_id, required_role_id) references lara.roles (tenant_id, id)
);
create index approval_requests_resource on lara.approval_requests (tenant_id, entity_id, resource_type, resource_id, status);
create or replace function lara.approval_requests_immutable() returns trigger language plpgsql as $$
begin
 if new.resource_type <> old.resource_type or new.resource_id <> old.resource_id or new.content_version <> old.content_version or new.content_hash <> old.content_hash or new.policy_version <> old.policy_version or new.step <> old.step then
  raise exception 'STATE_CONFLICT: approval requests bind an immutable content version' using errcode = 'check_violation';
 end if;
 if old.status <> 'pending' and new.status <> old.status then
  raise exception 'STATE_CONFLICT: approval request % is terminal', old.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger approval_requests_immutable before update on lara.approval_requests for each row execute function lara.approval_requests_immutable();
create trigger approval_requests_touch before update on lara.approval_requests for each row execute function lara.touch_row();

create table lara.approval_decisions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 request_id uuid not null,
 actor_id uuid not null,
 decision text not null check (decision in ('approve','reject')),
 reason text,
 decided_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, request_id, actor_id),
 check (decision <> 'reject' or reason is not null),
 foreign key (tenant_id, entity_id, request_id) references lara.approval_requests (tenant_id, entity_id, id),
 foreign key (tenant_id, actor_id) references lara.principals (tenant_id, id)
);
-- Maker-checker: the principal who raised the request never decides it, and a
-- decision applies only to a pending request whose content is unchanged.
create or replace function lara.approval_decisions_guard() returns trigger language plpgsql as $$
declare req lara.approval_requests%rowtype;
begin
 select * into req from lara.approval_requests r where r.tenant_id = new.tenant_id and r.entity_id = new.entity_id and r.id = new.request_id for update;
 if req.id is null then raise exception 'NOT_FOUND: approval request' using errcode = 'foreign_key_violation'; end if;
 if req.created_by = new.actor_id then raise exception 'SELF_APPROVAL: the requesting principal cannot decide' using errcode = 'check_violation'; end if;
 if req.status <> 'pending' then raise exception 'STATE_CONFLICT: approval request is %', req.status using errcode = 'check_violation'; end if;
 return new;
end $$;
create trigger approval_decisions_guard before insert on lara.approval_decisions for each row execute function lara.approval_decisions_guard();
create trigger approval_decisions_append_only before update or delete on lara.approval_decisions for each row execute function lara.reject_mutation();

-- ---------------------------------------------------------------------------
-- Durable operations: command receipts, outbox, inbox, jobs
-- ---------------------------------------------------------------------------
create table lara.command_receipts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null references lara.tenants(id),
 entity_id uuid,
 actor_id uuid not null,
 client_id text,
 operation text not null check (operation ~ '^[a-z][a-z0-9_]{0,99}$'),
 idempotency_key text not null check (length(idempotency_key) between 1 and 200),
 request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
 status text not null default 'pending' check (status in ('pending','committed','failed')),
 response_json jsonb,
 resource_type text,
 resource_id uuid,
 trace_id text,
 created_at timestamptz not null default now(),
 completed_at timestamptz,
 primary key (id),
 unique (tenant_id, id),
 check (status <> 'committed' or (resource_type is not null and resource_id is not null and completed_at is not null))
);
create unique index command_receipts_scoped_key on lara.command_receipts (tenant_id, coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid), idempotency_key);
create index command_receipts_resource on lara.command_receipts (tenant_id, resource_type, resource_id);
-- A receipt may only progress out of pending; committed effects are never rewritten.
create or replace function lara.command_receipts_progress() returns trigger language plpgsql as $$
begin
 if old.status <> 'pending' then raise exception 'STATE_CONFLICT: command receipt is final' using errcode = 'check_violation'; end if;
 if new.idempotency_key <> old.idempotency_key or new.request_hash <> old.request_hash or new.operation <> old.operation or new.actor_id <> old.actor_id or new.tenant_id <> old.tenant_id then
  raise exception 'STATE_CONFLICT: command identity is immutable' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger command_receipts_progress before update on lara.command_receipts for each row execute function lara.command_receipts_progress();
create trigger command_receipts_no_delete before delete on lara.command_receipts for each row execute function lara.reject_mutation();

create table lara.outbox_events (
 event_id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references lara.tenants(id),
 entity_id uuid,
 aggregate_type text not null check (aggregate_type ~ '^[a-z][a-z0-9_]{0,63}$'),
 aggregate_id uuid not null,
 aggregate_version bigint not null check (aggregate_version >= 1),
 event_type text not null check (event_type ~ '^[a-z][a-z0-9_.]*\.v[0-9]+$'),
 schema_version integer not null default 1 check (schema_version >= 1),
 payload jsonb not null check (jsonb_typeof(payload) = 'object'),
 trace_id text,
 created_at timestamptz not null default now(),
 published_at timestamptz,
 unique (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type)
);
create index outbox_pending on lara.outbox_events (created_at, event_id) where published_at is null;
create or replace function lara.outbox_publish_only() returns trigger language plpgsql as $$
begin
 if old.published_at is not null or new.published_at is null
  or new.event_id <> old.event_id or new.tenant_id <> old.tenant_id or new.aggregate_type <> old.aggregate_type or new.aggregate_id <> old.aggregate_id
  or new.aggregate_version <> old.aggregate_version or new.event_type <> old.event_type or new.schema_version <> old.schema_version or new.payload <> old.payload or new.created_at <> old.created_at then
  raise exception 'APPEND_ONLY: outbox events only record publication' using errcode = 'integrity_constraint_violation';
 end if;
 return new;
end $$;
create trigger outbox_publish_only before update on lara.outbox_events for each row execute function lara.outbox_publish_only();
create trigger outbox_no_delete before delete on lara.outbox_events for each row execute function lara.reject_mutation();

create table lara.inbox_receipts (
 consumer text not null check (consumer ~ '^[a-z][a-z0-9_.-]{0,99}$'),
 event_id uuid not null references lara.outbox_events (event_id),
 received_at timestamptz not null default now(),
 primary key (consumer, event_id)
);
create trigger inbox_receipts_append_only before update or delete on lara.inbox_receipts for each row execute function lara.reject_mutation();

create table lara.jobs (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null references lara.tenants(id),
 entity_id uuid,
 kind text not null check (kind ~ '^[a-z][a-z0-9_.]{0,99}$'),
 payload_ref jsonb not null default '{}'::jsonb check (jsonb_typeof(payload_ref) = 'object'),
 state text not null default 'queued' check (state in ('queued','running','retry_wait','succeeded','failed','dead_letter','cancelled')),
 run_after timestamptz not null default now(),
 attempt integer not null default 0 check (attempt >= 0),
 lease_owner text,
 lease_until timestamptz,
 error_code text,
 requested_by uuid,
 revocation_version bigint,
 trace_id text,
 result_resource_type text,
 result_resource_id uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 check (state <> 'running' or (lease_owner is not null and lease_until is not null))
);
create index jobs_claim on lara.jobs (state, run_after, id) where state in ('queued','retry_wait','running');
create index jobs_scope on lara.jobs (tenant_id, entity_id, state, created_at, id);
create or replace function lara.jobs_transition() returns trigger language plpgsql as $$
begin
 if new.state <> old.state and not (
  (old.state = 'queued' and new.state in ('running','cancelled')) or
  (old.state = 'running' and new.state in ('succeeded','retry_wait','failed','dead_letter')) or
  (old.state = 'retry_wait' and new.state in ('running','cancelled'))) then
  raise exception 'STATE_CONFLICT: job cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 new.version := old.version + 1;
 new.updated_at := now();
 return new;
end $$;
create trigger jobs_transition before update on lara.jobs for each row execute function lara.jobs_transition();

-- ---------------------------------------------------------------------------
-- Immutable audit chain
-- ---------------------------------------------------------------------------
create table lara.audit_chain_heads (
 tenant_id uuid not null references lara.tenants(id),
 entity_id uuid not null,
 sequence bigint not null default 0,
 hash text not null default repeat('0', 64),
 primary key (tenant_id, entity_id)
);

create table lara.audit_events (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null references lara.tenants(id),
 entity_id uuid not null default '00000000-0000-0000-0000-000000000000',
 sequence bigint not null,
 actor_id uuid,
 delegation_id uuid,
 action text not null check (action ~ '^[a-z][a-z0-9_.]{0,99}$'),
 resource_type text not null check (resource_type ~ '^[a-z][a-z0-9_]{0,63}$'),
 resource_id uuid,
 resource_version bigint,
 before_ref text,
 after_ref text,
 reason text,
 trace_id text not null check (length(trace_id) between 1 and 128),
 occurred_at timestamptz not null default now(),
 previous_hash text not null check (previous_hash ~ '^[a-f0-9]{64}$'),
 hash text not null check (hash ~ '^[a-f0-9]{64}$'),
 primary key (id),
 unique (tenant_id, entity_id, sequence)
);
create index audit_events_resource on lara.audit_events (tenant_id, entity_id, resource_type, resource_id, sequence);
-- The database assigns sequence, previous hash and hash while holding the
-- per-entity chain head lock, so application code cannot fork or skip the chain.
create or replace function lara.audit_events_chain() returns trigger language plpgsql as $$
declare head lara.audit_chain_heads%rowtype;
begin
 insert into lara.audit_chain_heads (tenant_id, entity_id) values (new.tenant_id, new.entity_id) on conflict do nothing;
 select * into head from lara.audit_chain_heads h where h.tenant_id = new.tenant_id and h.entity_id = new.entity_id for update;
 new.sequence := head.sequence + 1;
 new.previous_hash := head.hash;
 new.occurred_at := coalesce(new.occurred_at, now());
 new.hash := encode(sha256(convert_to(
  head.hash || '|' || new.tenant_id::text || '|' || new.entity_id::text || '|' || new.sequence::text || '|' || coalesce(new.actor_id::text, '') || '|' || coalesce(new.delegation_id::text, '') || '|' ||
  new.action || '|' || new.resource_type || '|' || coalesce(new.resource_id::text, '') || '|' || coalesce(new.resource_version::text, '') || '|' ||
  coalesce(new.before_ref, '') || '|' || coalesce(new.after_ref, '') || '|' || coalesce(new.reason, '') || '|' || new.trace_id || '|' || to_char(new.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'UTF8')), 'hex');
 update lara.audit_chain_heads set sequence = new.sequence, hash = new.hash where tenant_id = new.tenant_id and entity_id = new.entity_id;
 return new;
end $$;
create trigger audit_events_chain before insert on lara.audit_events for each row execute function lara.audit_events_chain();
create trigger audit_events_append_only before update or delete on lara.audit_events for each row execute function lara.reject_mutation();
create trigger audit_chain_heads_no_delete before delete on lara.audit_chain_heads for each row execute function lara.reject_mutation();

-- ---------------------------------------------------------------------------
-- Row-level security: runtime roles see only the tenant bound to the session.
-- Workers may claim jobs and publish outbox events across tenants.
-- ---------------------------------------------------------------------------
alter table lara.tenants enable row level security;
alter table lara.tenants force row level security;
create policy tenant_self on lara.tenants using (id = lara.current_tenant()) with check (id = lara.current_tenant());

do $$
declare target text;
begin
 foreach target in array array[
  'entities','branches','books','principals','roles','memberships','delegation','approval_policies','capability_activations',
  'onboarding_checks','settings_versions','party','party_roles','party_bank_accounts','evidence','evidence_links','tasks','task_comments',
  'obligations','approval_requests','approval_decisions','command_receipts','audit_chain_heads','audit_events'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
 foreach target in array array['outbox_events','jobs'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant() or current_user = ''lara_worker'') with check (tenant_id = lara.current_tenant() or current_user = ''lara_worker'')', target);
 end loop;
end $$;
alter table lara.inbox_receipts enable row level security;
alter table lara.inbox_receipts force row level security;
create policy worker_inbox on lara.inbox_receipts using (current_user = 'lara_worker' or exists (select 1 from lara.outbox_events o where o.event_id = inbox_receipts.event_id and o.tenant_id = lara.current_tenant())) with check (current_user = 'lara_worker');

-- ---------------------------------------------------------------------------
-- Grants: no runtime delete anywhere; masters archive, facts append.
-- ---------------------------------------------------------------------------
grant usage on schema lara to lara_api, lara_worker, lara_audit_reader;
grant select on lara.permission_definitions, lara.capability_definitions, lara.role_templates to lara_api, lara_worker, lara_audit_reader;
grant select, insert, update on lara.tenants, lara.entities, lara.branches, lara.books, lara.principals, lara.roles, lara.memberships, lara.delegation,
 lara.approval_policies, lara.capability_activations, lara.onboarding_checks, lara.settings_versions, lara.party, lara.party_roles, lara.party_bank_accounts,
 lara.evidence, lara.tasks, lara.obligations, lara.approval_requests, lara.command_receipts, lara.audit_chain_heads to lara_api;
grant select, insert on lara.evidence_links, lara.task_comments, lara.approval_decisions, lara.audit_events, lara.outbox_events, lara.jobs to lara_api;
grant update on lara.jobs to lara_api;
grant select on all tables in schema lara to lara_worker;
grant insert, update on lara.jobs, lara.evidence, lara.tasks, lara.command_receipts, lara.audit_chain_heads to lara_worker;
grant insert on lara.audit_events, lara.outbox_events, lara.inbox_receipts, lara.evidence_links to lara_worker;
grant update (published_at) on lara.outbox_events to lara_worker;
grant select on all tables in schema lara to lara_audit_reader;

-- ---------------------------------------------------------------------------
-- Seeds: published permission codes (docs/development/contracts/permissions.json),
-- capability graph (docs/development/01-delivery-plan.md) and role templates
-- (docs/development/06-api-and-workflows.md). No tenant, party or rule data.
-- ---------------------------------------------------------------------------
insert into lara.permission_definitions (code) values
 ('account.create'),
 ('account.edit'),
 ('account.read'),
 ('allocation.reverse'),
 ('allocation_run.approve'),
 ('allocation_run.create'),
 ('allocation_run.edit'),
 ('allocation_run.post'),
 ('allocation_run.preview'),
 ('allocation_run.read'),
 ('approval_policy.activate'),
 ('approval_policy.approve'),
 ('approval_policy.create'),
 ('approval_policy.edit'),
 ('approval_policy.read'),
 ('asset.approve'),
 ('asset.create'),
 ('asset.edit'),
 ('asset.events'),
 ('asset.read'),
 ('assistant.read'),
 ('assistant.review'),
 ('assistant.suggest'),
 ('bank_account.approve'),
 ('bank_account.create'),
 ('bank_account.edit'),
 ('bank_account.read'),
 ('bank_match.confirm'),
 ('bank_match.create'),
 ('bank_match.edit'),
 ('bank_match.read'),
 ('bank_match.reverse'),
 ('bill.approve'),
 ('bill.correct'),
 ('bill.edit'),
 ('bill.post'),
 ('bill.prepare'),
 ('bill.read'),
 ('bill.submit'),
 ('book.activate'),
 ('book.create'),
 ('book.edit'),
 ('book.read'),
 ('branch.create'),
 ('branch.edit'),
 ('branch.read'),
 ('budget.activate'),
 ('budget.approve'),
 ('budget.create'),
 ('budget.edit'),
 ('budget.read'),
 ('capability.activate'),
 ('cash_session.close'),
 ('cash_session.count'),
 ('cash_session.create'),
 ('cash_session.edit'),
 ('cash_session.handover'),
 ('cash_session.read'),
 ('check.clear'),
 ('check.create'),
 ('check.deposit'),
 ('check.dishonor'),
 ('check.edit'),
 ('check.read'),
 ('check.release'),
 ('collection.allocate'),
 ('collection.approve'),
 ('collection.create'),
 ('collection.edit'),
 ('collection.post'),
 ('collection.read'),
 ('collection.reverse'),
 ('collection.submit'),
 ('command.read'),
 ('consolidation.approve'),
 ('consolidation.create'),
 ('consolidation.edit'),
 ('consolidation.preview'),
 ('consolidation.publish'),
 ('consolidation.read'),
 ('demo.feedback'),
 ('demo.reset'),
 ('demo.select'),
 ('discount_eligibility.approve'),
 ('discount_eligibility.create'),
 ('discount_eligibility.edit'),
 ('discount_eligibility.read'),
 ('entity.activate'),
 ('entity.create'),
 ('entity.edit'),
 ('entity.read'),
 ('evidence.export'),
 ('evidence.read'),
 ('evidence.upload'),
 ('expense_claim.approve'),
 ('expense_claim.edit'),
 ('expense_claim.post'),
 ('expense_claim.prepare'),
 ('expense_claim.read'),
 ('expense_claim.submit'),
 ('firm_assignment.create'),
 ('firm_assignment.edit'),
 ('firm_assignment.read'),
 ('firm_mandate.approve'),
 ('firm_mandate.create'),
 ('firm_mandate.edit'),
 ('firm_mandate.read'),
 ('firm_mandate.revoke'),
 ('fx_rate.approve'),
 ('fx_rate.create'),
 ('fx_rate.edit'),
 ('fx_rate.read'),
 ('group.activate'),
 ('group.create'),
 ('group.edit'),
 ('group.read'),
 ('health.read'),
 ('import.approve'),
 ('import.commit'),
 ('import.create'),
 ('import.edit'),
 ('import.read'),
 ('import.validate'),
 ('intercompany_pair.accept'),
 ('intercompany_pair.create'),
 ('intercompany_pair.edit'),
 ('intercompany_pair.post'),
 ('intercompany_pair.read'),
 ('invoice.approve'),
 ('invoice.correct'),
 ('invoice.deliver'),
 ('invoice.edit'),
 ('invoice.post'),
 ('invoice.prepare'),
 ('invoice.read'),
 ('invoice.submit'),
 ('item.create'),
 ('item.edit'),
 ('item.read'),
 ('job.read'),
 ('journal.approve'),
 ('journal.edit'),
 ('journal.post'),
 ('journal.prepare'),
 ('journal.read'),
 ('journal.reverse'),
 ('journal.submit'),
 ('landed_cost.approve'),
 ('landed_cost.create'),
 ('landed_cost.edit'),
 ('landed_cost.post'),
 ('landed_cost.preview'),
 ('landed_cost.read'),
 ('lease.approve'),
 ('lease.create'),
 ('lease.edit'),
 ('lease.read'),
 ('membership.create'),
 ('membership.edit'),
 ('membership.read'),
 ('membership.revoke'),
 ('message_request.create'),
 ('message_request.edit'),
 ('message_request.read'),
 ('message_request.send'),
 ('obligation.complete'),
 ('obligation.create'),
 ('obligation.edit'),
 ('obligation.read'),
 ('open_item.read'),
 ('pack.install'),
 ('party.archive'),
 ('party.create'),
 ('party.edit'),
 ('party.read'),
 ('payment.authorize'),
 ('payment.create'),
 ('payment.edit'),
 ('payment.read'),
 ('payment.release'),
 ('payment.return'),
 ('payment.settle'),
 ('payment.submit'),
 ('payment_link.cancel'),
 ('payment_link.create'),
 ('payment_link.edit'),
 ('payment_link.read'),
 ('period.create'),
 ('period.edit'),
 ('period.lock'),
 ('period.read'),
 ('period.reopen'),
 ('period.soft_close'),
 ('portal_invite.create'),
 ('portal_invite.edit'),
 ('portal_invite.read'),
 ('portal_invite.revoke'),
 ('project.create'),
 ('project.edit'),
 ('project.progress_billing'),
 ('project.read'),
 ('purchase_order.approve'),
 ('purchase_order.cancel'),
 ('purchase_order.create'),
 ('purchase_order.edit'),
 ('purchase_order.read'),
 ('purchase_order.submit'),
 ('registration.prepare'),
 ('report.generate'),
 ('report_definition.create'),
 ('report_definition.edit'),
 ('report_definition.publish'),
 ('report_definition.read'),
 ('return.approve'),
 ('return.create'),
 ('return.edit'),
 ('return.filed'),
 ('return.prepare'),
 ('return.read'),
 ('revaluation.approve'),
 ('revaluation.create'),
 ('revaluation.edit'),
 ('revaluation.post'),
 ('revaluation.preview'),
 ('revaluation.read'),
 ('role.approve'),
 ('role.create'),
 ('role.edit'),
 ('role.read'),
 ('rule_proposal.approve'),
 ('rule_proposal.create'),
 ('rule_proposal.edit'),
 ('rule_proposal.impact'),
 ('rule_proposal.read'),
 ('sales_order.approve'),
 ('sales_order.convert'),
 ('sales_order.create'),
 ('sales_order.edit'),
 ('sales_order.read'),
 ('sales_order.submit'),
 ('schedule.approve'),
 ('schedule.create'),
 ('schedule.edit'),
 ('schedule.execute'),
 ('schedule.pause'),
 ('schedule.read'),
 ('session.read'),
 ('settlements.create'),
 ('settlements.edit'),
 ('settlements.read'),
 ('settlements.submit'),
 ('source_ownership.approve'),
 ('source_ownership.create'),
 ('source_ownership.edit'),
 ('source_ownership.read'),
 ('stock_count.approve'),
 ('stock_count.create'),
 ('stock_count.edit'),
 ('stock_count.post'),
 ('stock_count.read'),
 ('stock_movement.approve'),
 ('stock_movement.create'),
 ('stock_movement.edit'),
 ('stock_movement.post'),
 ('stock_movement.read'),
 ('stock_movement.submit'),
 ('task.assign'),
 ('task.comments'),
 ('task.create'),
 ('task.edit'),
 ('task.read'),
 ('task.resolve'),
 ('tax_rule.activate'),
 ('tax_rule.approve'),
 ('tax_rule.create'),
 ('tax_rule.edit'),
 ('tax_rule.read'),
 ('tool_grant.approve'),
 ('tool_grant.create'),
 ('tool_grant.edit'),
 ('tool_grant.read'),
 ('tool_grant.revoke'),
 ('transfer.approve'),
 ('transfer.create'),
 ('transfer.edit'),
 ('transfer.post'),
 ('transfer.read'),
 ('transfer.submit'),
 ('transmission.read'),
 ('transmission.reconcile'),
 ('transmission.retry');

insert into lara.capability_definitions (code, phase, title, depends_on) values
 ('workspace', 'P02', 'Finance workspace', array[]::text[]),
 ('general_ledger', 'P03', 'General ledger and close', array['workspace']::text[]),
 ('sales', 'P04', 'Sales invoicing and receivables', array['general_ledger']::text[]),
 ('purchasing', 'P05', 'Purchasing payables and expenses', array['sales']::text[]),
 ('treasury', 'P06', 'Treasury cash and bank reconciliation', array['purchasing']::text[]),
 ('compliance', 'P07', 'Tax compliance and e-invoicing', array['treasury']::text[]),
 ('fi_coexistence', 'P08', 'Financial institution coexistence', array['compliance']::text[]),
 ('multi_currency', 'P09', 'Multiple currencies and separate books', array['fi_coexistence']::text[]),
 ('inventory', 'P10', 'Inventory costing and three-way matching', array['treasury']::text[]),
 ('assets', 'P11', 'Assets recurring work and recognition schedules', array['general_ledger', 'purchasing']::text[]),
 ('ai_assistance', 'P12', 'Evidence-backed AI assistance', array['compliance']::text[]),
 ('portals', 'P13', 'Customer and supplier portals and messaging', array['sales', 'purchasing', 'treasury', 'compliance']::text[]),
 ('firm_workspace', 'P14', 'Accounting firm multi-client workspace', array['compliance']::text[]),
 ('group_accounting', 'P15', 'Intercompany and consolidation', array['multi_currency', 'assets']::text[]),
 ('planning', 'P16', 'Budgets cost allocation and project accounting', array['inventory', 'assets']::text[]);

insert into lara.role_templates (code, name, permissions, protected) values
 ('clerk', 'Clerk', '["bill.edit", "bill.prepare", "bill.read", "bill.submit", "branch.read", "command.read", "entity.read", "evidence.read", "evidence.upload", "expense_claim.edit", "expense_claim.prepare", "expense_claim.read", "expense_claim.submit", "health.read", "invoice.edit", "invoice.prepare", "invoice.read", "invoice.submit", "job.read", "journal.read", "obligation.read", "open_item.read", "party.create", "party.edit", "party.read", "session.read", "task.comments", "task.create", "task.edit", "task.read", "task.resolve"]'::jsonb, true),
 ('billing', 'Billing', '["branch.read", "collection.create", "collection.edit", "collection.read", "collection.submit", "command.read", "entity.read", "evidence.read", "evidence.upload", "health.read", "invoice.deliver", "invoice.edit", "invoice.prepare", "invoice.read", "invoice.submit", "job.read", "journal.read", "obligation.read", "open_item.read", "party.create", "party.edit", "party.read", "payment_link.create", "payment_link.edit", "payment_link.read", "sales_order.create", "sales_order.edit", "sales_order.read", "sales_order.submit", "session.read", "task.comments", "task.create", "task.edit", "task.read", "task.resolve"]'::jsonb, true),
 ('accountant', 'Accountant', '["account.create", "account.edit", "account.read", "allocation.reverse", "bank_match.confirm", "bank_match.create", "bank_match.edit", "bank_match.read", "bank_match.reverse", "bill.approve", "bill.correct", "bill.post", "bill.read", "branch.read", "collection.allocate", "collection.approve", "collection.post", "collection.read", "collection.reverse", "command.read", "entity.read", "evidence.read", "evidence.upload", "expense_claim.approve", "expense_claim.post", "expense_claim.read", "health.read", "import.create", "import.edit", "import.read", "import.validate", "invoice.approve", "invoice.correct", "invoice.post", "invoice.read", "job.read", "journal.approve", "journal.edit", "journal.post", "journal.prepare", "journal.read", "journal.reverse", "journal.submit", "obligation.edit", "obligation.read", "open_item.read", "party.read", "period.create", "period.edit", "period.read", "period.soft_close", "report.generate", "session.read", "settlements.read", "task.assign", "task.comments", "task.create", "task.edit", "task.read", "task.resolve"]'::jsonb, true),
 ('treasury', 'Treasury', '["bank_account.create", "bank_account.edit", "bank_account.read", "bank_match.confirm", "bank_match.create", "bank_match.edit", "bank_match.read", "bill.read", "branch.read", "cash_session.close", "cash_session.count", "cash_session.create", "cash_session.edit", "cash_session.handover", "cash_session.read", "check.clear", "check.create", "check.deposit", "check.dishonor", "check.edit", "check.read", "check.release", "collection.allocate", "collection.create", "collection.edit", "collection.read", "collection.submit", "command.read", "entity.read", "evidence.read", "evidence.upload", "health.read", "invoice.read", "job.read", "obligation.read", "open_item.read", "party.read", "payment.create", "payment.edit", "payment.read", "payment.release", "payment.return", "payment.settle", "payment.submit", "session.read", "settlements.create", "settlements.edit", "settlements.read", "settlements.submit", "task.comments", "task.create", "task.edit", "task.read", "task.resolve", "transfer.create", "transfer.edit", "transfer.read", "transfer.submit"]'::jsonb, true),
 ('tax', 'Tax', '["bill.correct", "bill.read", "branch.read", "command.read", "entity.read", "evidence.read", "evidence.upload", "health.read", "invoice.correct", "invoice.read", "job.read", "journal.read", "obligation.complete", "obligation.create", "obligation.edit", "obligation.read", "party.read", "registration.prepare", "report.generate", "return.create", "return.edit", "return.filed", "return.prepare", "return.read", "session.read", "task.comments", "task.create", "task.edit", "task.read", "task.resolve", "tax_rule.create", "tax_rule.edit", "tax_rule.read", "transmission.read", "transmission.reconcile", "transmission.retry"]'::jsonb, true),
 ('controller', 'Controller', '["account.read", "allocation_run.read", "approval_policy.activate", "approval_policy.approve", "approval_policy.create", "approval_policy.edit", "approval_policy.read", "asset.read", "assistant.read", "bank_account.approve", "bank_account.read", "bank_match.confirm", "bank_match.read", "bill.approve", "bill.read", "book.activate", "book.create", "book.edit", "book.read", "branch.create", "branch.edit", "branch.read", "budget.read", "capability.activate", "cash_session.read", "check.read", "collection.approve", "collection.read", "command.read", "consolidation.read", "discount_eligibility.read", "entity.activate", "entity.create", "entity.edit", "entity.read", "evidence.export", "evidence.read", "evidence.upload", "expense_claim.approve", "expense_claim.read", "firm_assignment.read", "firm_mandate.read", "fx_rate.approve", "fx_rate.read", "group.read", "health.read", "import.approve", "import.commit", "import.read", "intercompany_pair.read", "invoice.approve", "invoice.read", "item.read", "job.read", "journal.approve", "journal.post", "journal.read", "journal.reverse", "landed_cost.read", "lease.read", "membership.read", "message_request.read", "obligation.complete", "obligation.create", "obligation.edit", "obligation.read", "open_item.read", "party.read", "payment.authorize", "payment.read", "payment_link.read", "period.create", "period.edit", "period.lock", "period.read", "period.reopen", "period.soft_close", "portal_invite.read", "project.read", "purchase_order.approve", "purchase_order.read", "registration.prepare", "report.generate", "report_definition.read", "return.approve", "return.read", "revaluation.read", "role.approve", "role.read", "rule_proposal.read", "sales_order.read", "schedule.read", "session.read", "settlements.read", "source_ownership.approve", "source_ownership.read", "stock_count.read", "stock_movement.read", "task.assign", "task.comments", "task.create", "task.edit", "task.read", "task.resolve", "tax_rule.activate", "tax_rule.approve", "tax_rule.read", "tool_grant.read", "transfer.read", "transmission.read"]'::jsonb, true),
 ('auditor', 'Auditor', '["account.read", "allocation_run.read", "approval_policy.read", "asset.read", "assistant.read", "bank_account.read", "bank_match.read", "bill.read", "book.read", "branch.read", "budget.read", "cash_session.read", "check.read", "collection.read", "command.read", "consolidation.read", "discount_eligibility.read", "entity.read", "evidence.export", "evidence.read", "expense_claim.read", "firm_assignment.read", "firm_mandate.read", "fx_rate.read", "group.read", "health.read", "import.read", "intercompany_pair.read", "invoice.read", "item.read", "job.read", "journal.read", "landed_cost.read", "lease.read", "membership.read", "message_request.read", "obligation.read", "open_item.read", "party.read", "payment.read", "payment_link.read", "period.read", "portal_invite.read", "project.read", "purchase_order.read", "report.generate", "report_definition.read", "return.read", "revaluation.read", "role.read", "rule_proposal.read", "sales_order.read", "schedule.read", "session.read", "settlements.read", "source_ownership.read", "stock_count.read", "stock_movement.read", "task.comments", "task.create", "task.read", "tax_rule.read", "tool_grant.read", "transfer.read", "transmission.read"]'::jsonb, true),
 ('security_admin', 'Security admin', '["branch.read", "command.read", "entity.read", "evidence.read", "health.read", "job.read", "membership.create", "membership.edit", "membership.read", "membership.revoke", "party.read", "portal_invite.read", "portal_invite.revoke", "role.create", "role.edit", "role.read", "session.read", "task.comments", "task.read", "tool_grant.read", "tool_grant.revoke"]'::jsonb, true),
 ('operations', 'Operations', '["command.read", "health.read", "job.read", "session.read", "transmission.read", "transmission.retry"]'::jsonb, true);
