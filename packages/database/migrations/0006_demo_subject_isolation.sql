alter table lara_demo.runs add column owner_subject text;
create unique index demo_run_subject on lara_demo.runs(owner_subject) where owner_subject is not null;
alter table lara_demo.runs enable row level security;
alter table lara_demo.runs force row level security;
create policy subject_run on lara_demo.runs for select using (owner_subject = nullif(current_setting('lara.subject', true), ''));
revoke insert, update on lara_demo.runs from lara_api, lara_worker;
do $$
declare target text;
begin
 foreach target in array array['tasks','invoices','bills','reconciliation_lines','close_tasks','compliance_items','evidence','feedback'] loop
  execute format('alter table lara_demo.%I enable row level security', target);
  execute format('alter table lara_demo.%I force row level security', target);
  execute format('create policy subject_scope on lara_demo.%I using (run_id in (select id from lara_demo.runs)) with check (run_id in (select id from lara_demo.runs))', target);
 end loop;
end $$;
