-- Closing entries carry no dimensions: they aggregate income and expense
-- balances across every dimension into retained earnings.
-- The posting service. Validates period, accounts and dimensions after taking
-- locks, computes totals server-side and inserts header and lines. Retrying
-- the same source version with identical lines returns the existing entry;
-- different lines for the same source version are a duplicate-source conflict.
create or replace function lara.post_journal_entry(p jsonb) returns uuid
language plpgsql security definer set search_path = lara, pg_temp as $$
declare
 v_tenant uuid := (p->>'tenantId')::uuid; v_entity uuid := (p->>'entityId')::uuid; v_book uuid := (p->>'bookId')::uuid;
 v_date date := (p->>'accountingDate')::date; v_currency text := coalesce(p->>'currency','PHP');
 v_purpose text := coalesce(p->>'purpose','posting'); v_manual boolean := coalesce((p->>'manual')::boolean, false);
 v_allow_soft boolean := coalesce((p->>'allowSoftClosed')::boolean, false);
 v_period lara.periods%rowtype; v_book_row lara.books%rowtype; v_acct lara.accounts%rowtype; v_branch uuid;
 v_line jsonb; v_no integer := 0; v_debit numeric(24,6); v_credit numeric(24,6); v_td numeric(24,6) := 0; v_tc numeric(24,6) := 0;
 v_hash text; v_existing lara.journal_entries%rowtype; v_id uuid; v_dim text; v_required text; v_children integer;
begin
 if nullif(current_setting('lara.tenant_id', true), '')::uuid is distinct from v_tenant then raise exception 'FORBIDDEN: posting outside the bound tenant' using errcode = 'insufficient_privilege'; end if;
 if jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') < 2 then raise exception 'UNBALANCED_ENTRY: at least two lines are required' using errcode = 'check_violation'; end if;
 select * into v_book_row from lara.books where tenant_id = v_tenant and entity_id = v_entity and id = v_book;
 if v_book_row.id is null then raise exception 'NOT_FOUND: book' using errcode = 'foreign_key_violation'; end if;
 if v_book_row.status <> 'active' then raise exception 'STATE_CONFLICT: book is not active' using errcode = 'check_violation'; end if;
 -- Lock the period FOR SHARE so a concurrent close waits for or excludes this posting.
 select * into v_period from lara.periods where tenant_id = v_tenant and entity_id = v_entity and book_id = v_book and v_date between starts_on and ends_on for share;
 if v_period.id is null then raise exception 'PERIOD_LOCKED: no open period covers %', v_date using errcode = 'check_violation'; end if;
 -- Locked periods refuse every posting except the fiscal-year closing entry,
 -- which the close command issues once after all periods of the year are locked.
 if v_period.status = 'locked' and v_purpose <> 'closing' then raise exception 'PERIOD_LOCKED: period is locked' using errcode = 'check_violation'; end if;
 if v_period.status = 'soft_closed' and not v_allow_soft and v_purpose <> 'closing' then raise exception 'PERIOD_LOCKED: period is soft closed; use the adjustment workflow' using errcode = 'check_violation'; end if;
 -- Canonical hash of the lines as supplied (order preserved).
 v_hash := encode(sha256(convert_to((p->'lines')::text || '|' || v_date::text || '|' || v_currency, 'UTF8')), 'hex');
 select * into v_existing from lara.journal_entries where tenant_id = v_tenant and entity_id = v_entity and book_id = v_book and source_type = p->>'sourceType' and source_id = (p->>'sourceId')::uuid and source_version = (p->>'sourceVersion')::bigint and purpose = v_purpose;
 if v_existing.id is not null then
  if v_existing.lines_hash = v_hash then return v_existing.id; end if;
  raise exception 'DUPLICATE_SOURCE: this source version already posted different lines' using errcode = 'unique_violation';
 end if;
 for v_line in select * from jsonb_array_elements(p->'lines') loop
  v_no := v_no + 1;
  v_debit := coalesce((v_line->>'debit')::numeric, 0); v_credit := coalesce((v_line->>'credit')::numeric, 0);
  if v_debit < 0 or v_credit < 0 or (v_debit > 0) = (v_credit > 0) then raise exception 'UNBALANCED_ENTRY: line % must have exactly one positive side', v_no using errcode = 'check_violation'; end if;
  select * into v_acct from lara.accounts where tenant_id = v_tenant and entity_id = v_entity and book_id = v_book and id = (v_line->>'accountId')::uuid for share;
  if v_acct.id is null then raise exception 'NOT_FOUND: account on line %', v_no using errcode = 'foreign_key_violation'; end if;
  if v_acct.status <> 'active' then raise exception 'STATE_CONFLICT: account % is %', v_acct.code, v_acct.status using errcode = 'check_violation'; end if;
  select count(*) into v_children from lara.accounts where tenant_id = v_tenant and parent_id = v_acct.id and status <> 'archived';
  if v_children > 0 then raise exception 'STATE_CONFLICT: account % is not a leaf', v_acct.code using errcode = 'check_violation'; end if;
  if v_manual and not v_acct.allow_manual then raise exception 'STATE_CONFLICT: account % accepts postings only from its owning module', v_acct.code using errcode = 'check_violation'; end if;
  select id into v_branch from lara.branches where tenant_id = v_tenant and entity_id = v_entity and id = (v_line->>'branchId')::uuid and status = 'active';
  if v_branch is null then raise exception 'NOT_FOUND: active branch on line %', v_no using errcode = 'foreign_key_violation'; end if;
  -- Closing entries aggregate balances across dimensions and carry none.
  for v_required in select dimension_type from lara.account_dimension_rules r where r.tenant_id = v_tenant and r.account_id = v_acct.id and r.required and v_purpose <> 'closing' loop
   v_dim := v_line->'dimensions'->>v_required;
   if v_dim is null or not exists (select 1 from lara.dimensions d where d.tenant_id = v_tenant and d.entity_id = v_entity and d.type = v_required and d.id = v_dim::uuid and d.status = 'active') then
    raise exception 'VALIDATION_FAILED: account % requires dimension %', v_acct.code, v_required using errcode = 'check_violation';
   end if;
  end loop;
  v_td := v_td + v_debit; v_tc := v_tc + v_credit;
 end loop;
 if v_td <> v_tc then raise exception 'UNBALANCED_ENTRY: debits % differ from credits %', v_td, v_tc using errcode = 'check_violation'; end if;
 if v_currency <> v_book_row.functional_currency then raise exception 'FEATURE_NOT_ENABLED: foreign-currency journals arrive with separate books' using errcode = 'check_violation'; end if;
 insert into lara.journal_entries (tenant_id, entity_id, book_id, source_type, source_id, source_version, purpose, accounting_date, document_date, description, period_id, transaction_currency, functional_currency, reversal_of, posting_actor, command_id, lines_hash, line_count, total_debit, total_credit)
  values (v_tenant, v_entity, v_book, p->>'sourceType', (p->>'sourceId')::uuid, (p->>'sourceVersion')::bigint, v_purpose, v_date, (p->>'documentDate')::date, p->>'description', v_period.id, v_currency, v_book_row.functional_currency, (p->>'reversalOf')::uuid, (p->>'postingActor')::uuid, (p->>'commandId')::uuid, v_hash, v_no, v_td, v_tc)
  returning id into v_id;
 v_no := 0;
 for v_line in select * from jsonb_array_elements(p->'lines') loop
  v_no := v_no + 1;
  v_debit := coalesce((v_line->>'debit')::numeric, 0); v_credit := coalesce((v_line->>'credit')::numeric, 0);
  insert into lara.journal_lines (tenant_id, entity_id, book_id, entry_id, line_no, account_id, branch_id, txn_debit, txn_credit, func_debit, func_credit, dimensions_json)
   values (v_tenant, v_entity, v_book, v_id, v_no, (v_line->>'accountId')::uuid, (v_line->>'branchId')::uuid, v_debit, v_credit, v_debit, v_credit, coalesce(v_line->'dimensions', '{}'::jsonb));
 end loop;
 return v_id;
end $$;
