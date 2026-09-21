-- A resource may be re-submitted for the same content version after an earlier
-- request was invalidated or rejected. Only one request per content version and
-- step may be pending; terminal requests remain as history.
do $$
declare name text;
begin
 select conname into name from pg_constraint
  where conrelid = 'lara.approval_requests'::regclass and contype = 'u'
  and conkey = (select array_agg(attnum order by ord) from unnest(array['tenant_id','entity_id','resource_type','resource_id','content_version','step']) with ordinality as c(col, ord)
   join pg_attribute a on a.attrelid = 'lara.approval_requests'::regclass and a.attname = c.col);
 if name is null then raise exception 'approval_requests content-version unique constraint not found'; end if;
 execute format('alter table lara.approval_requests drop constraint %I', name);
end $$;
create unique index approval_requests_one_pending on lara.approval_requests (tenant_id, entity_id, resource_type, resource_id, content_version, step) where status = 'pending';
