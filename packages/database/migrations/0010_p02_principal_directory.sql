-- Principal directory: the only pre-tenant lookup the API performs. It maps an
-- authenticated OIDC issuer/subject to the tenants where that principal is
-- active so the request transaction can bind tenant context before any
-- tenant table is read. It exposes nothing beyond that mapping and is kept in
-- step with lara.principals by trigger.
create table lara.principal_directory (
 oidc_issuer text not null,
 oidc_subject text not null,
 tenant_id uuid not null references lara.tenants(id),
 principal_id uuid not null,
 primary key (oidc_issuer, oidc_subject, tenant_id)
);
create or replace function lara.principal_directory_sync() returns trigger language plpgsql security definer set search_path = lara, pg_temp as $$
begin
 if tg_op = 'DELETE' then
  delete from lara.principal_directory where tenant_id = old.tenant_id and principal_id = old.id;
  return old;
 end if;
 if new.status = 'active' then
  insert into lara.principal_directory (oidc_issuer, oidc_subject, tenant_id, principal_id) values (new.oidc_issuer, new.oidc_subject, new.tenant_id, new.id)
   on conflict (oidc_issuer, oidc_subject, tenant_id) do update set principal_id = excluded.principal_id;
 else
  delete from lara.principal_directory where tenant_id = new.tenant_id and principal_id = new.id;
 end if;
 return new;
end $$;
revoke all on function lara.principal_directory_sync() from public;
create trigger principals_directory after insert or update or delete on lara.principals for each row execute function lara.principal_directory_sync();
grant select on lara.principal_directory to lara_api, lara_worker, lara_audit_reader;

-- System-generated exports are stored as restricted evidence and may be JSON;
-- uploads stay limited to the reviewed EvidenceUpload types.
alter table lara.evidence drop constraint evidence_mime_check;
alter table lara.evidence add constraint evidence_mime_check check (mime in ('application/pdf','image/jpeg','image/png','text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/json'));
