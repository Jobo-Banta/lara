grant usage on schema lara_demo to lara_api, lara_worker, lara_audit_reader;
grant select, insert, update on all tables in schema lara_demo to lara_api, lara_worker;
grant select on all tables in schema lara_demo to lara_audit_reader;
grant usage, select on all sequences in schema lara_demo to lara_api, lara_worker;

