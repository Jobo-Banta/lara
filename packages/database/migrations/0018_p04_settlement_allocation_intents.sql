-- Allocation intents on a receipt draft: the allocations the preparer asked
-- for, applied as guarded allocation events only when the receipt posts.
alter table lara.settlements add column allocation_intents jsonb not null default '[]'::jsonb check (jsonb_typeof(allocation_intents) = 'array');
