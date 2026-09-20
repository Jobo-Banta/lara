-- P14 accounting firm multi-client workspace: a firm and its staff live in
-- the firm's own tenant; a client grants the firm a mandate inside the
-- client's tenant (entities, permissions, expiry, evidence, approved by a
-- second client principal); the firm owner and its staff act in the client
-- tenant as delegated identities through assignments bounded by the mandate
-- and revoked with it; cross-tenant scope resolution and aggregate counts go
-- through restricted SECURITY DEFINER functions keyed by the caller's
-- identity, never through unrestricted financial joins; aggregate snapshots
-- carry the mandate and are invalidated the moment it is revoked.

create table lara.firms (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 name text not null check (length(btrim(name)) between 1 and 200),
 owner_principal_id uuid not null,
 plan jsonb not null default '{}'::jsonb check (jsonb_typeof(plan) = 'object'),
 status text not null default 'active' check (status in ('active','archived')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id),
 unique (tenant_id, id),
 foreign key (tenant_id) references lara.tenants (id),
 foreign key (tenant_id, owner_principal_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger firms_touch before update on lara.firms for each row execute function lara.touch_row();

create table lara.firm_staff (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 firm_id uuid not null,
 principal_id uuid not null,
 role text not null check (role in ('partner','manager','staff')),
 status text not null default 'active' check (status in ('active','revoked')),
 revoked_reason text,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, firm_id, principal_id),
 check (status <> 'revoked' or revoked_reason is not null),
 foreign key (tenant_id, firm_id) references lara.firms (tenant_id, id),
 foreign key (tenant_id, principal_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger firm_staff_touch before update on lara.firm_staff for each row execute function lara.touch_row();

-- Granted inside the client tenant. The firm is referenced by id; its name
-- is snapshotted so the client never reads the firm's tenant.
create table lara.client_mandates (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 firm_id uuid not null,
 firm_name text not null check (length(btrim(firm_name)) between 1 and 200),
 entity_ids uuid[] not null check (cardinality(entity_ids) >= 1),
 permissions text[] not null check (cardinality(permissions) >= 1),
 valid_from timestamptz not null default now(),
 valid_to timestamptz not null,
 evidence_ids jsonb not null check (jsonb_typeof(evidence_ids) = 'array' and jsonb_array_length(evidence_ids) >= 1),
 state text not null default 'draft' check (state in ('draft','approved','revoked','expired')),
 approved_by uuid,
 approved_at timestamptz,
 revoked_reason text,
 revoked_at timestamptz,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (valid_to > valid_from),
 check (state <> 'approved' or (approved_by is not null and approved_at is not null)),
 check (approved_by is null or approved_by <> created_by),
 check (state <> 'revoked' or revoked_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 -- The application never deletes a firm; the cascade exists for engineering teardown only.
 foreign key (firm_id) references lara.firms (id) on delete cascade,
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index client_mandates_one_live on lara.client_mandates (tenant_id, firm_id) where state in ('draft','approved');
create index client_mandates_queue on lara.client_mandates (tenant_id, state, valid_to);
create or replace function lara.client_mandates_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('revoked','expired') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % mandate is final', old.state using errcode = 'check_violation';
 end if;
 if old.state = 'approved' and (new.permissions <> old.permissions or new.entity_ids <> old.entity_ids or new.firm_id <> old.firm_id or new.valid_to > old.valid_to) then
  raise exception 'STATE_CONFLICT: an approved mandate never widens; revoke it and grant another' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('approved','revoked')) or
  (old.state = 'approved' and new.state in ('revoked','expired'))) then
  raise exception 'STATE_CONFLICT: mandate cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger client_mandates_validate before update on lara.client_mandates for each row execute function lara.client_mandates_validate();
create trigger client_mandates_touch before update on lara.client_mandates for each row execute function lara.touch_row();

-- The delegated identity: the staff member's principal in the client
-- tenant, bound to one mandate, a subset of its permissions and entities.
create table lara.client_assignments (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 mandate_id uuid not null,
 principal_id uuid not null,
 firm_principal_id uuid not null,
 firm_role text not null check (firm_role in ('partner','manager','staff')),
 entity_ids uuid[] not null check (cardinality(entity_ids) >= 1),
 permission_subset text[] not null check (cardinality(permission_subset) >= 1),
 state text not null default 'active' check (state in ('active','revoked')),
 revoked_reason text,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, mandate_id, principal_id),
 check (state <> 'revoked' or revoked_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, mandate_id) references lara.client_mandates (tenant_id, id),
 foreign key (tenant_id, principal_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index client_assignments_principal on lara.client_assignments (tenant_id, principal_id, state);
create trigger client_assignments_touch before update on lara.client_assignments for each row execute function lara.touch_row();

-- Aggregates the firm workspace shows: counts per client, keyed by the
-- mandate so a revocation invalidates them at once; monetary totals are
-- labelled by entity and currency and never summed across them.
create table lara.aggregate_snapshots (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 firm_id uuid not null,
 actor_principal_id uuid not null,
 mandate_id uuid not null,
 client_tenant_id uuid not null,
 client_entity_id uuid not null,
 scope_hash text not null check (scope_hash ~ '^[a-f0-9]{64}$'),
 as_of timestamptz not null default now(),
 counts jsonb not null check (jsonb_typeof(counts) = 'object'),
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, actor_principal_id, scope_hash),
 foreign key (tenant_id, firm_id) references lara.firms (tenant_id, id),
 foreign key (tenant_id, actor_principal_id) references lara.principals (tenant_id, id)
);
create index aggregate_snapshots_mandate on lara.aggregate_snapshots (mandate_id);

-- Global firm directory (no row security, like the principal directory):
-- the firm id, its tenant, name and owner, kept in sync from the firm row,
-- so a client can resolve a firm by id without reading the firm's tenant.
create table lara.firm_directory (
 firm_id uuid not null primary key,
 tenant_id uuid not null,
 name text not null,
 owner_principal_id uuid not null,
 status text not null
);
create or replace function lara.firm_directory_sync() returns trigger language plpgsql security definer set search_path = lara, pg_temp as $$
begin
 if tg_op = 'DELETE' then delete from lara.firm_directory where firm_id = old.id; return old; end if;
 insert into lara.firm_directory (firm_id, tenant_id, name, owner_principal_id, status) values (new.id, new.tenant_id, new.name, new.owner_principal_id, new.status)
  on conflict (firm_id) do update set name = excluded.name, owner_principal_id = excluded.owner_principal_id, status = excluded.status;
 return new;
end $$;
revoke all on function lara.firm_directory_sync() from public;
create trigger firms_directory after insert or update or delete on lara.firms for each row execute function lara.firm_directory_sync();
grant select on lara.firm_directory to lara_api, lara_worker, lara_audit_reader;

-- Restricted authorization service. Row security is forced on every tenant
-- table, so each function scopes itself to one tenant at a time with a
-- transaction-local setting and restores the caller's scope afterwards;
-- discovery runs through the two global directories only.
create or replace function lara.firm_scopes(p_issuer text, p_subject text)
returns table (client_tenant_id uuid, client_tenant_name text, client_entity_id uuid, client_entity_name text, mandate_id uuid, assignment_id uuid, principal_id uuid, firm_id uuid, permissions text[], valid_to timestamptz)
language plpgsql security definer set search_path = lara, pg_temp as $$
declare v_prev text := coalesce(current_setting('lara.tenant_id', true), ''); v_dir record;
begin
 for v_dir in select d.tenant_id, d.principal_id from lara.principal_directory d where d.oidc_issuer = p_issuer and d.oidc_subject = p_subject loop
  perform set_config('lara.tenant_id', v_dir.tenant_id::text, true);
  return query
   select a.tenant_id, t.name, e.id, e.legal_name, m.id, a.id, a.principal_id, m.firm_id,
    (select coalesce(array_agg(p), array[]::text[]) from unnest(a.permission_subset) p where p = any(m.permissions)), m.valid_to
   from lara.client_assignments a
   join lara.client_mandates m on m.tenant_id = a.tenant_id and m.id = a.mandate_id
   join lara.principals pr on pr.tenant_id = a.tenant_id and pr.id = a.principal_id
   join lara.tenants t on t.id = a.tenant_id
   join lara.entities e on e.tenant_id = a.tenant_id and e.id = any(a.entity_ids) and e.status <> 'archived'
   where a.tenant_id = v_dir.tenant_id and a.principal_id = v_dir.principal_id and pr.status = 'active'
    and a.state = 'active' and m.state = 'approved' and m.valid_from <= now() and m.valid_to > now() and t.status = 'active'
   order by t.name, e.legal_name;
 end loop;
 perform set_config('lara.tenant_id', v_prev, true);
end $$;
revoke all on function lara.firm_scopes(text, text) from public;
grant execute on function lara.firm_scopes(text, text) to lara_api;

-- Aggregate counts for one client scope, computed for the identity that
-- holds the assignment and only with the reads the assignment carries.
create or replace function lara.firm_aggregate(p_issuer text, p_subject text, p_tenant uuid, p_entity uuid)
returns jsonb language plpgsql security definer set search_path = lara, pg_temp as $$
declare v_prev text := coalesce(current_setting('lara.tenant_id', true), ''); v_scope record; v_perms text[]; v_result jsonb := '{}'::jsonb; v_tmp jsonb;
begin
 select * into v_scope from lara.firm_scopes(p_issuer, p_subject) s where s.client_tenant_id = p_tenant and s.client_entity_id = p_entity limit 1;
 if v_scope.mandate_id is null then raise exception 'FORBIDDEN: no delegated scope for that client' using errcode = 'insufficient_privilege'; end if;
 v_perms := v_scope.permissions;
 perform set_config('lara.tenant_id', p_tenant::text, true);
 if 'task.read' = any(v_perms) then
  select jsonb_build_object('openTasks', count(*)) into v_tmp from lara.tasks where tenant_id = p_tenant and entity_id = p_entity and status in ('open','assigned','in_progress','waiting_for_information');
  v_result := v_result || v_tmp;
 end if;
 if 'obligation.read' = any(v_perms) then
  select jsonb_build_object('openObligations', count(*), 'overdueObligations', count(*) filter (where due_at < now())) into v_tmp from lara.obligations where tenant_id = p_tenant and entity_id = p_entity and status in ('open','in_progress');
  v_result := v_result || v_tmp;
 end if;
 if 'open_item.read' = any(v_perms) then
  select jsonb_build_object('openItems', coalesce(jsonb_agg(jsonb_build_object('side', side, 'currency', currency, 'count', n, 'outstanding', outstanding)), '[]'::jsonb)) into v_tmp
  from (select side, currency, count(*) as n, sum(original_amount - lara.open_item_allocated(tenant_id, id))::text as outstanding from lara.open_items where tenant_id = p_tenant and entity_id = p_entity and status in ('open','partially_settled') group by side, currency order by side, currency) x;
  v_result := v_result || v_tmp;
 end if;
 if 'period.read' = any(v_perms) then
  select jsonb_build_object('openPeriods', count(*)) into v_tmp from lara.periods where tenant_id = p_tenant and entity_id = p_entity and status = 'open';
  v_result := v_result || v_tmp;
 end if;
 perform set_config('lara.tenant_id', v_prev, true);
 return v_result || jsonb_build_object('mandateId', v_scope.mandate_id, 'validTo', v_scope.valid_to, 'permissions', to_jsonb(v_perms));
end $$;
revoke all on function lara.firm_aggregate(text, text, uuid, uuid) from public;
grant execute on function lara.firm_aggregate(text, text, uuid, uuid) to lara_api;

-- Revocation reaches the firm's snapshots across tenants: they are deleted
-- by mandate id so nothing cached survives the mandate. Only the client
-- tenant that holds the mandate may call it.
create or replace function lara.firm_invalidate_snapshots(p_mandate uuid) returns integer
language plpgsql security definer set search_path = lara, pg_temp as $$
declare v_prev text := coalesce(current_setting('lara.tenant_id', true), ''); v_firm uuid; v_firm_tenant uuid; v_count integer := 0;
begin
 select m.firm_id into v_firm from lara.client_mandates m where m.id = p_mandate and m.tenant_id = lara.current_tenant();
 if v_firm is null then raise exception 'FORBIDDEN: mandate is not in the current tenant' using errcode = 'insufficient_privilege'; end if;
 select d.tenant_id into v_firm_tenant from lara.firm_directory d where d.firm_id = v_firm;
 if v_firm_tenant is null then return 0; end if;
 perform set_config('lara.tenant_id', v_firm_tenant::text, true);
 delete from lara.aggregate_snapshots where tenant_id = v_firm_tenant and mandate_id = p_mandate;
 get diagnostics v_count = row_count;
 perform set_config('lara.tenant_id', v_prev, true);
 return v_count;
end $$;
revoke all on function lara.firm_invalidate_snapshots(uuid) from public;
grant execute on function lara.firm_invalidate_snapshots(uuid) to lara_api;

-- The firm's identity record for a principal (issuer and subject), readable
-- by a client tenant that holds a draft or approved mandate for that firm,
-- so the client can create the delegated identity without joining the firm.
create or replace function lara.firm_identity(p_firm uuid, p_principal uuid)
returns table (oidc_issuer text, oidc_subject text, display_name text, firm_role text, firm_name text)
language plpgsql security definer set search_path = lara, pg_temp as $$
declare v_prev text := coalesce(current_setting('lara.tenant_id', true), ''); v_dir record;
begin
 select * into v_dir from lara.firm_directory d where d.firm_id = p_firm and d.status = 'active';
 if v_dir.firm_id is null then return; end if;
 if not exists (select 1 from lara.client_mandates m where m.tenant_id = lara.current_tenant() and m.firm_id = p_firm and m.state in ('draft','approved')) then return; end if;
 perform set_config('lara.tenant_id', v_dir.tenant_id::text, true);
 return query
  select p.oidc_issuer, p.oidc_subject, p.display_name, coalesce(s.role, case when v_dir.owner_principal_id = p.id then 'partner' end), v_dir.name
  from lara.principals p
  left join lara.firm_staff s on s.tenant_id = p.tenant_id and s.firm_id = p_firm and s.principal_id = p.id and s.status = 'active'
  where p.tenant_id = v_dir.tenant_id and p.id = p_principal and p.status = 'active' and (s.id is not null or v_dir.owner_principal_id = p.id);
 perform set_config('lara.tenant_id', v_prev, true);
end $$;
revoke all on function lara.firm_identity(uuid, uuid) from public;
grant execute on function lara.firm_identity(uuid, uuid) to lara_api;

-- A firm's name and owner for a client granting a mandate: by firm id only, never enumerable.
create or replace function lara.firm_lookup(p_firm uuid) returns table (id uuid, name text, owner_principal_id uuid)
language sql security definer set search_path = lara, pg_temp stable as $$
 select d.firm_id, d.name, d.owner_principal_id from lara.firm_directory d where d.firm_id = p_firm and d.status = 'active'
$$;
revoke all on function lara.firm_lookup(uuid) from public;
grant execute on function lara.firm_lookup(uuid) to lara_api;

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['firms','firm_staff','client_mandates','client_assignments','aggregate_snapshots'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.firms, lara.firm_staff, lara.client_mandates, lara.client_assignments to lara_api;
grant select, insert, delete on lara.aggregate_snapshots to lara_api;
grant select on lara.firms, lara.firm_staff, lara.client_mandates, lara.client_assignments, lara.aggregate_snapshots to lara_worker, lara_audit_reader;
