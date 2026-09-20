-- P05 follow-up: a posted credit note raised against a bill is a supplier
-- credit and reduces the bill's payable (side AP) rather than a receivable; the
-- amount it can apply is its gross net of recognized withholding, the same
-- residual a payment settles. Sales credits keep applying to receivables.
create or replace function lara.allocation_events_guard() returns trigger language plpgsql as $$
declare item lara.open_items%rowtype; s lara.settlements%rowtype; c lara.documents%rowtype; original lara.allocation_events%rowtype; item_used numeric(24,6); source_used numeric(24,6); source_total numeric(24,6); source_party uuid; source_currency text; source_side text; source_kind text;
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
  select kind into source_kind from lara.documents where tenant_id = c.tenant_id and id = c.source_document_id;
  source_party := c.party_id; source_currency := c.currency; source_side := case when source_kind = 'bill' then 'AP' else 'AR' end; source_total := c.gross - c.withholding;
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

-- A settled payment may still be returned by the bank; only failed, returned
-- and cancelled orders are terminal.
create or replace function lara.payment_orders_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('failed','returned','cancelled') and new.state <> old.state then
  raise exception 'STATE_CONFLICT: payment order is terminal in state %', old.state using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('submitted','cancelled')) or
  (old.state = 'submitted' and new.state in ('authorized','draft','cancelled')) or
  (old.state = 'authorized' and new.state in ('released','release_unknown','draft','cancelled')) or
  (old.state = 'release_unknown' and new.state in ('released','failed')) or
  (old.state = 'released' and new.state in ('settled','failed','returned')) or
  (old.state = 'settled' and new.state = 'returned')) then
  raise exception 'STATE_CONFLICT: payment order cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if old.state in ('released','settled') and (new.release_reference <> old.release_reference or new.release_channel <> old.release_channel or new.release_evidence_ids <> old.release_evidence_ids) then
  raise exception 'STATE_CONFLICT: release evidence is immutable' using errcode = 'check_violation';
 end if;
 if old.state = 'settled' and (new.settle_reference <> old.settle_reference or new.settled_at <> old.settled_at or new.settle_value_date <> old.settle_value_date or new.settle_evidence_ids <> old.settle_evidence_ids) then
  raise exception 'STATE_CONFLICT: settlement evidence is immutable' using errcode = 'check_violation';
 end if;
 if (new.settlement_id <> old.settlement_id or new.beneficiary_version_id <> old.beneficiary_version_id) and old.state not in ('draft','submitted') then
  raise exception 'STATE_CONFLICT: an authorized payment cannot change its settlement or beneficiary; it returns to draft first' using errcode = 'check_violation';
 end if;
 return new;
end $$;
