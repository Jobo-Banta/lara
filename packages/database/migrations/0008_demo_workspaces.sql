-- Synthetic aggregates only. One locked row is the transaction boundary for a
-- browser session; production books never use this representation.
create table lara_demo.workspaces (
 owner_subject text not null,
 session_id text not null,
 state jsonb not null,
 updated_at timestamptz not null default now(),
 primary key(owner_subject,session_id),
 check (jsonb_typeof(state) = 'object')
);
alter table lara_demo.workspaces enable row level security;
alter table lara_demo.workspaces force row level security;
create policy owned_session on lara_demo.workspaces using (
 owner_subject = nullif(current_setting('lara.subject',true),'')
 and session_id = nullif(current_setting('lara.session',true),'')
 and exists(select 1 from lara_demo.runs where owner_subject = current_setting('lara.subject',true))
) with check (
 owner_subject = nullif(current_setting('lara.subject',true),'')
 and session_id = nullif(current_setting('lara.session',true),'')
 and exists(select 1 from lara_demo.runs where owner_subject = current_setting('lara.subject',true))
);
grant select,insert,update on lara_demo.workspaces to lara_api;
grant select on lara_demo.workspaces to lara_audit_reader;
