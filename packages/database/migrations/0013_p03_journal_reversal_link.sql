-- A reversal is prepared as a reviewed draft linked to the posted entry it
-- reverses; posting it records the link on the immutable entry. One reversal
-- draft per posted entry may be open at a time.
alter table lara.journal_drafts add column reversal_of uuid;
alter table lara.journal_drafts add constraint journal_drafts_reversal_fk foreign key (tenant_id, entity_id, book_id, reversal_of) references lara.journal_entries (tenant_id, entity_id, book_id, id);
create unique index journal_drafts_one_open_reversal on lara.journal_drafts (tenant_id, entity_id, book_id, reversal_of) where reversal_of is not null and status not in ('posted','cancelled');
