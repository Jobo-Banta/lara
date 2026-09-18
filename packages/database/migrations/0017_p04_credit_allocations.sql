-- P04 follow-up: document settlement states use the contract enumeration
-- (unpaid, partial, paid, credit_balance) and allocation events may come from
-- a posted credit note as well as from a posted settlement, so a credit reduces
-- the original open item through the same append-only balance path.
alter table lara.documents drop constraint documents_settlement_state_check;
alter table lara.documents add constraint documents_settlement_state_check check (settlement_state in ('unpaid','partial','paid','credit_balance'));

alter table lara.allocation_events alter column settlement_id drop not null;
alter table lara.allocation_events add column credit_document_id uuid;
alter table lara.allocation_events add constraint allocation_events_one_source check ((settlement_id is null) <> (credit_document_id is null));
alter table lara.allocation_events add foreign key (tenant_id, entity_id, credit_document_id) references lara.documents (tenant_id, entity_id, id);
create index allocation_events_credit on lara.allocation_events (tenant_id, credit_document_id, created_at) where credit_document_id is not null;

create or replace function lara.credit_allocated(p_tenant uuid, p_document uuid) returns numeric(24,6) language sql stable as $$
 select coalesce(sum(case when action = 'apply' then amount else -amount end), 0) from lara.allocation_events where tenant_id = p_tenant and credit_document_id = p_document
$$;
grant execute on function lara.credit_allocated(uuid, uuid) to lara_api, lara_worker, lara_audit_reader;

create or replace function lara.allocation_events_guard() returns trigger language plpgsql as $$
declare item lara.open_items%rowtype; s lara.settlements%rowtype; c lara.documents%rowtype; original lara.allocation_events%rowtype; item_used numeric(24,6); source_used numeric(24,6); source_total numeric(24,6); source_party uuid; source_currency text; source_side text;
begin
 -- Ordered locks: source (settlement or credit document), then open item.
 if new.settlement_id is not null then
  select * into s from lara.settlements where tenant_id = new.tenant_id and id = new.settlement_id for update;
  if s.id is null then raise exception 'NOT_FOUND: settlement' using errcode = 'foreign_key_violation'; end if;
  if new.action = 'apply' and s.state <> 'posted' then raise exception 'STATE_CONFLICT: only posted settlements allocate' using errcode = 'check_violation'; end if;
  source_party := s.party_id; source_currency := s.currency; source_side := case when s.direction = 'receipt' then 'AR' else 'AP' end; source_total := s.gross_amount;
  source_used := lara.settlement_allocated(new.tenant_id, s.id);
 else
  select * into c from lara.documents where tenant_id = new.tenant_id and id = new.credit_document_id for update;
  if c.id is null then raise exception 'NOT_FOUND: credit document' using errcode = 'foreign_key_violation'; end if;
  if c.kind <> 'credit_note' then raise exception 'VALIDATION_FAILED: only credit notes allocate against open items' using errcode = 'check_violation'; end if;
  if new.action = 'apply' and c.state <> 'posted' then raise exception 'STATE_CONFLICT: only posted credit notes allocate' using errcode = 'check_violation'; end if;
  source_party := c.party_id; source_currency := c.currency; source_side := 'AR'; source_total := c.gross;
  source_used := lara.credit_allocated(new.tenant_id, c.id);
 end if;
 select * into item from lara.open_items where tenant_id = new.tenant_id and id = new.open_item_id for update;
 if item.id is null then raise exception 'NOT_FOUND: open item' using errcode = 'foreign_key_violation'; end if;
 if source_currency <> item.currency then raise exception 'VALIDATION_FAILED: settlement and open item currencies differ' using errcode = 'check_violation'; end if;
 if source_side <> item.side then raise exception 'VALIDATION_FAILED: receipts settle receivables and payments settle payables' using errcode = 'check_violation'; end if;
 if source_party <> item.party_id then raise exception 'VALIDATION_FAILED: settlement party differs from the open item party' using errcode = 'check_violation'; end if;
 if new.action = 'apply' then
  item_used := lara.open_item_allocated(new.tenant_id, item.id);
  if item_used + new.amount > item.original_amount then raise exception 'ALLOCATION_EXCEEDS_BALANCE: open item outstanding % is below %', item.original_amount - item_used, new.amount using errcode = 'check_violation'; end if;
  if source_used + new.amount > source_total then raise exception 'ALLOCATION_EXCEEDS_BALANCE: settlement unallocated % is below %', source_total - source_used, new.amount using errcode = 'check_violation'; end if;
 else
  select * into original from lara.allocation_events where tenant_id = new.tenant_id and id = new.reverses_id;
  if original.id is null or original.action <> 'apply' or original.open_item_id <> new.open_item_id or original.settlement_id is distinct from new.settlement_id or original.credit_document_id is distinct from new.credit_document_id or original.amount <> new.amount then
   raise exception 'STATE_CONFLICT: a reverse must mirror one apply of the same settlement and item' using errcode = 'check_violation';
  end if;
 end if;
 return new;
end $$;
