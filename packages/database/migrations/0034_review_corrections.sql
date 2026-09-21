-- Corrections from the P02–P18 branch review. Each change keeps the reviewed
-- semantics and removes a constraint or gap that made a supported operation
-- impossible:
--  * tool runs on a granted entity other than the grant's home entity could
--    not be recorded (the run's foreign key pinned the entity to the grant's);
--  * sales order conversions linked billed quantities by the invoice line
--    number, which edits renumber; the source line is now kept on the line;
--  * settlements carried no branch, so a cashier's expected float included
--    every branch's cash of the day;
--  * the worker delivers share links but could not rotate the share token it
--    delivers (the token exists only at creation);
--  * a failed or rolled-back pack version blocked every later attempt at the
--    same version on the entity.

-- P18C: a tool run is scoped to the tenant's grant; the entity is one of the
-- grant's entity_ids, checked by the domain.
alter table lara.tool_runs drop constraint tool_runs_tenant_id_entity_id_grant_id_fkey;
alter table lara.tool_runs add constraint tool_runs_grant_fk foreign key (tenant_id, grant_id) references lara.tool_grants (tenant_id, id);

-- P04: a converted line remembers the order line it bills; edits keep the
-- link by line identity, and a line without one bills nothing on the order.
alter table lara.document_lines add column source_line_no integer check (source_line_no >= 1);

-- P06: the branch whose drawer or account received or paid the settlement;
-- null keeps the earlier behaviour (the entity's first active branch).
alter table lara.settlements add column branch_id uuid;
alter table lara.settlements add constraint settlements_branch_fk foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id);

-- P13: the worker rotates the share token at every delivery, as it does the invite token.
grant update on lara.share_grants to lara_worker;

-- P18D: a version attempt is unique while it is installing, installed or
-- superseded; failed and rolled-back attempts stay as history.
alter table lara.pack_versions drop constraint pack_versions_tenant_id_entity_id_pack_id_version_key;
create unique index pack_versions_one_attempt on lara.pack_versions (tenant_id, entity_id, pack_id, version) where state in ('installing','installed','superseded');
