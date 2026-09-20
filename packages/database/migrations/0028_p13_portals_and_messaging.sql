-- P13 customer and supplier portals and messaging: scoped invites bound to
-- one party and entity, external portal memberships separate from internal
-- memberships, expiring share grants over opaque tokens, message requests
-- drafted, authorized by a named principal and sent once with delivery
-- receipts per attempt, provider payment intents keyed once per invoice and
-- amount, and webhook receipts deduplicated per provider event with the
-- signature verdict. Settlement of a paid intent still runs the normal
-- collection command; nothing here posts.

create table lara.portal_invites (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 party_id uuid not null,
 email_hash text not null check (email_hash ~ '^[a-f0-9]{64}$'),
 email_masked text not null check (length(email_masked) between 3 and 320),
 role text not null check (role in ('customer','supplier')),
 token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz not null,
 state text not null default 'pending' check (state in ('pending','accepted','revoked','expired')),
 accepted_principal_id uuid,
 accepted_at timestamptz,
 revoked_reason text,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, token_hash),
 check (state <> 'accepted' or (accepted_principal_id is not null and accepted_at is not null)),
 check (state <> 'revoked' or revoked_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, accepted_principal_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index portal_invites_queue on lara.portal_invites (tenant_id, entity_id, state, expires_at);
create or replace function lara.portal_invites_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('revoked','expired') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % invite is final', old.state using errcode = 'check_violation';
 end if;
 if old.state = 'accepted' and new.state not in ('accepted','revoked') then
  raise exception 'STATE_CONFLICT: an accepted invite is revoked, never reopened' using errcode = 'check_violation';
 end if;
 if new.state = 'accepted' and old.state = 'pending' and old.expires_at <= now() then
  raise exception 'STATE_CONFLICT: the invite expired before acceptance' using errcode = 'check_violation';
 end if;
 if old.state = 'pending' and new.state = 'pending' and (new.party_id <> old.party_id or new.role <> old.role or new.email_hash <> old.email_hash) and new.content_version = old.content_version then
  raise exception 'STATE_CONFLICT: invite scope changes bump the content version' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger portal_invites_validate before update on lara.portal_invites for each row execute function lara.portal_invites_validate();
create trigger portal_invites_touch before update on lara.portal_invites for each row execute function lara.touch_row();

-- External identities: one principal, one party, one entity, one role and the
-- resource kinds the portal may show. The same email at two companies is two
-- memberships with no cross-access.
create table lara.portal_memberships (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 principal_id uuid not null,
 party_id uuid not null,
 invite_id uuid,
 role text not null check (role in ('customer','supplier')),
 allowed_kinds text[] not null check (cardinality(allowed_kinds) >= 1),
 expires_at timestamptz,
 status text not null default 'active' check (status in ('active','revoked','expired')),
 revoked_reason text,
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, principal_id, party_id),
 check (status <> 'revoked' or revoked_reason is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, principal_id) references lara.principals (tenant_id, id),
 foreign key (tenant_id, entity_id, party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, invite_id) references lara.portal_invites (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index portal_memberships_principal on lara.portal_memberships (tenant_id, principal_id, status);
create trigger portal_memberships_touch before update on lara.portal_memberships for each row execute function lara.touch_row();

-- Share grants: an opaque token exposes minimal approved fields of one
-- resource until it expires or is revoked; never enumerable.
create table lara.share_grants (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 resource_type text not null check (resource_type in ('document','statement','certificate','evidence')),
 resource_id uuid not null,
 recipient_party_id uuid,
 token_hash text not null check (token_hash ~ '^[a-f0-9]{64}$'),
 scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object'),
 expires_at timestamptz not null,
 state text not null default 'active' check (state in ('active','revoked','expired')),
 access_count integer not null default 0 check (access_count >= 0),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, token_hash),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, recipient_party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index share_grants_resource on lara.share_grants (tenant_id, entity_id, resource_type, resource_id, state);
create trigger share_grants_touch before update on lara.share_grants for each row execute function lara.touch_row();

create table lara.message_requests (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 source_type text not null check (source_type in ('document','statement','certificate_request','portal_invite','reminder','balance_confirmation')),
 source_id uuid not null,
 recipient_party_id uuid not null,
 channel text not null check (channel in ('portal','email','qualified_chat')),
 template_version text not null check (length(template_version) between 1 and 100),
 state text not null default 'draft' check (state in ('draft','authorized','sending','sent','failed','cancelled')),
 authorized_by uuid,
 authorized_at timestamptz,
 send_key text,
 attempts integer not null default 0 check (attempts >= 0),
 provider_reference text,
 last_error text,
 share_grant_id uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, send_key),
 check (state not in ('authorized','sending','sent') or (authorized_by is not null and authorized_at is not null and send_key is not null)),
 check (authorized_by is null or authorized_by <> created_by),
 check (state <> 'sent' or provider_reference is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, recipient_party_id) references lara.party (tenant_id, entity_id, id),
 foreign key (tenant_id, authorized_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, share_grant_id) references lara.share_grants (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index message_requests_queue on lara.message_requests (tenant_id, entity_id, state, created_at);
create or replace function lara.message_requests_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('sent','cancelled') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: a % message is final', old.state using errcode = 'check_violation';
 end if;
 if old.state <> 'draft' and (new.content_hash <> old.content_hash or new.recipient_party_id <> old.recipient_party_id or new.channel <> old.channel or new.source_id <> old.source_id) then
  raise exception 'STATE_CONFLICT: an authorized message never changes; cancel it and draft another' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('authorized','cancelled')) or
  (old.state = 'authorized' and new.state in ('sending','failed','cancelled')) or
  (old.state = 'sending' and new.state in ('sent','failed','authorized')) or
  (old.state = 'failed' and new.state in ('sending','cancelled'))) then
  raise exception 'STATE_CONFLICT: message cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger message_requests_validate before update on lara.message_requests for each row execute function lara.message_requests_validate();
create trigger message_requests_touch before update on lara.message_requests for each row execute function lara.touch_row();

create table lara.delivery_receipts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 message_request_id uuid not null,
 attempt integer not null check (attempt >= 1),
 provider text not null check (length(provider) between 1 and 100),
 outcome text not null check (outcome in ('sent','failed')),
 provider_reference text,
 error text,
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, message_request_id, attempt),
 check (outcome <> 'sent' or provider_reference is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, message_request_id) references lara.message_requests (tenant_id, entity_id, id)
);
create trigger delivery_receipts_append_only before update or delete on lara.delivery_receipts for each row execute function lara.reject_mutation();

create table lara.provider_payment_intents (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 document_id uuid not null,
 amount numeric(24,6) not null check (amount > 0),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 provider text not null check (length(provider) between 1 and 100),
 provider_key text not null check (length(provider_key) between 1 and 200),
 expires_at timestamptz not null,
 status text not null default 'created' check (status in ('created','pending','paid','settled','expired','cancelled','failed')),
 customer_claimed_at timestamptz,
 paid_at timestamptz,
 provider_amount numeric(24,6),
 provider_currency text,
 settlement_id uuid,
 cancel_reason text,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, provider, provider_key),
 check (status <> 'paid' or paid_at is not null),
 check (status <> 'settled' or settlement_id is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, settlement_id) references lara.settlements (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index provider_payment_intents_one_live on lara.provider_payment_intents (tenant_id, document_id) where status in ('created','pending','paid');
create index provider_payment_intents_queue on lara.provider_payment_intents (tenant_id, entity_id, status, expires_at);
create or replace function lara.provider_payment_intents_validate() returns trigger language plpgsql as $$
begin
 if old.status in ('settled','expired','cancelled','failed') and new.status <> old.status then
  raise exception 'STATE_CONFLICT: a % payment intent is final', old.status using errcode = 'check_violation';
 end if;
 if old.status <> 'created' and (new.amount <> old.amount or new.currency <> old.currency or new.document_id <> old.document_id or new.provider_key <> old.provider_key) then
  raise exception 'STATE_CONFLICT: a live payment intent never changes its amount, currency, invoice or key' using errcode = 'check_violation';
 end if;
 if new.status <> old.status and not (
  (old.status = 'created' and new.status in ('pending','paid','expired','cancelled','failed')) or
  (old.status = 'pending' and new.status in ('paid','expired','cancelled','failed')) or
  (old.status = 'paid' and new.status = 'settled')) then
  raise exception 'STATE_CONFLICT: payment intent cannot move from % to %', old.status, new.status using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger provider_payment_intents_validate before update on lara.provider_payment_intents for each row execute function lara.provider_payment_intents_validate();
create trigger provider_payment_intents_touch before update on lara.provider_payment_intents for each row execute function lara.touch_row();

create table lara.webhook_receipts (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 provider text not null check (length(provider) between 1 and 100),
 event_id text not null check (length(event_id) between 1 and 200),
 payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
 signature_state text not null check (signature_state in ('valid','invalid','stale','replayed')),
 event_type text,
 intent_id uuid,
 outcome text not null check (outcome in ('applied','ignored','rejected')),
 reason text,
 received_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, provider, event_id),
 foreign key (tenant_id) references lara.tenants (id),
 foreign key (tenant_id, intent_id) references lara.provider_payment_intents (tenant_id, id)
);
create trigger webhook_receipts_append_only before update or delete on lara.webhook_receipts for each row execute function lara.reject_mutation();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['portal_invites','portal_memberships','share_grants','message_requests','delivery_receipts','provider_payment_intents','webhook_receipts'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.portal_invites, lara.portal_memberships, lara.share_grants, lara.message_requests, lara.provider_payment_intents to lara_api;
grant select, insert on lara.delivery_receipts, lara.webhook_receipts to lara_api;
grant select on lara.portal_invites, lara.portal_memberships, lara.share_grants, lara.message_requests, lara.delivery_receipts, lara.provider_payment_intents, lara.webhook_receipts to lara_worker, lara_audit_reader;
-- The worker sends authorized messages (once), rotates the invite token it delivers and records the receipts.
grant update on lara.message_requests, lara.portal_invites to lara_worker;
grant insert on lara.delivery_receipts to lara_worker;
