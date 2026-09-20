-- P10 inventory costing and three-way matching: warehouses, items with a
-- cost method fixed before the first movement, stock movements reviewed and
-- posted once, valuation layers consumed oldest first (FIFO) or through the
-- running average, append-only allocations, per item and warehouse balances
-- locked in sorted order so concurrent issues never produce negative stock,
-- lot and serial tracking (a serial exists in one warehouse), count sessions
-- with frozen expected quantities, and landed cost runs allocated to receipts
-- with the sold portion to cost of sales. Every financial effect posts through
-- lara.post_journal_entry.

create table lara.warehouses (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 branch_id uuid not null,
 code text not null check (code ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
 name text not null check (length(btrim(name)) between 1 and 200),
 status text not null default 'active' check (status in ('active','archived')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, code),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, branch_id) references lara.branches (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger warehouses_touch before update on lara.warehouses for each row execute function lara.touch_row();

create table lara.items (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 sku text not null check (sku ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 description text not null check (length(btrim(description)) between 1 and 500),
 uom text not null check (length(btrim(uom)) between 1 and 20),
 cost_method text not null check (cost_method in ('fifo','moving_average')),
 tracking text not null default 'none' check (tracking in ('none','batch','serial')),
 stock_account_id uuid not null,
 cogs_account_id uuid not null,
 status text not null default 'active' check (status in ('active','archived')),
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 unique (tenant_id, entity_id, sku),
 check (stock_account_id <> cogs_account_id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, stock_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, cogs_account_id) references lara.accounts (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger items_touch before update on lara.items for each row execute function lara.touch_row();

create table lara.stock_movements (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 kind text not null check (kind in ('receipt','issue','transfer','return','adjustment')),
 warehouse_id uuid not null,
 to_warehouse_id uuid,
 accounting_date date not null,
 source_document_id uuid,
 count_session_id uuid,
 reason text,
 state text not null default 'draft' check (state in ('draft','submitted','approved','posted','rejected')),
 approved_by uuid,
 posted_entry_id uuid,
 recost_entry_id uuid,
 recost_json jsonb,
 content_version bigint not null default 1 check (content_version >= 1),
 content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (kind <> 'transfer' or (to_warehouse_id is not null and to_warehouse_id <> warehouse_id)),
 check (kind = 'transfer' or to_warehouse_id is null),
 check (state <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, warehouse_id) references lara.warehouses (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, to_warehouse_id) references lara.warehouses (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, source_document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, posted_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, entity_id, book_id, recost_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create index stock_movements_queue on lara.stock_movements (tenant_id, entity_id, state, accounting_date);
create index stock_movements_source on lara.stock_movements (tenant_id, source_document_id) where source_document_id is not null;
create or replace function lara.stock_movements_validate() returns trigger language plpgsql as $$
begin
 if old.state = 'posted' and (new.state <> 'posted' or new.content_hash <> old.content_hash or new.kind <> old.kind or new.warehouse_id <> old.warehouse_id or new.to_warehouse_id is distinct from old.to_warehouse_id or new.accounting_date <> old.accounting_date or new.posted_entry_id is distinct from old.posted_entry_id) then
  raise exception 'STATE_CONFLICT: posted stock movements are immutable; a correction is a new linked movement' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('submitted','rejected')) or
  (old.state = 'submitted' and new.state in ('approved','rejected','draft')) or
  (old.state = 'approved' and new.state in ('posted','draft'))) then
  raise exception 'STATE_CONFLICT: stock movement cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if new.state in ('approved','posted') and old.state in ('submitted','approved') and new.content_hash <> old.content_hash then
  raise exception 'STATE_CONFLICT: approved stock movement content changed' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger stock_movements_validate before update on lara.stock_movements for each row execute function lara.stock_movements_validate();
create trigger stock_movements_touch before update on lara.stock_movements for each row execute function lara.touch_row();

create table lara.stock_movement_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 movement_id uuid not null,
 line_no integer not null check (line_no >= 1),
 item_id uuid not null,
 quantity numeric(24,6) not null check (quantity > 0),
 unit_cost numeric(24,6) check (unit_cost is null or unit_cost >= 0),
 lot_or_serial text check (lot_or_serial is null or length(lot_or_serial) between 1 and 100),
 cost numeric(24,6),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, movement_id, line_no),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, movement_id) references lara.stock_movements (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, item_id) references lara.items (tenant_id, entity_id, id)
);
create or replace function lara.stock_movement_lines_guard() returns trigger language plpgsql as $$
declare m_state text;
begin
 if tg_op = 'DELETE' and current_setting('lara.maintenance', true) = 'teardown' and (exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper)) or exists (select 1 from pg_tables where schemaname = tg_table_schema and tablename = tg_table_name and tableowner = current_user)) then return old; end if;
 select state into m_state from lara.stock_movements where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.movement_id, old.movement_id);
 if tg_op = 'DELETE' and m_state <> 'draft' then raise exception 'STATE_CONFLICT: lines of a submitted movement are frozen' using errcode = 'check_violation'; end if;
 if tg_op = 'INSERT' and m_state <> 'draft' then raise exception 'STATE_CONFLICT: lines of a submitted movement are frozen' using errcode = 'check_violation'; end if;
 if tg_op = 'UPDATE' and m_state = 'posted' and (new.quantity <> old.quantity or new.item_id <> old.item_id or new.unit_cost is distinct from old.unit_cost or new.cost is distinct from old.cost) then raise exception 'STATE_CONFLICT: lines of a posted movement are immutable' using errcode = 'check_violation'; end if;
 if tg_op = 'UPDATE' and m_state in ('submitted','approved') and (new.quantity <> old.quantity or new.item_id <> old.item_id or new.unit_cost is distinct from old.unit_cost) then raise exception 'STATE_CONFLICT: lines of a submitted movement are frozen' using errcode = 'check_violation'; end if;
 if tg_op = 'DELETE' then return old; end if;
 return new;
end $$;
create trigger stock_movement_lines_guard before insert or update or delete on lara.stock_movement_lines for each row execute function lara.stock_movement_lines_guard();

-- Balances: one row per item and warehouse, locked in sorted order by the
-- posting code; the check makes negative stock impossible at the database.
create table lara.stock_balances (
 tenant_id uuid not null,
 entity_id uuid not null,
 item_id uuid not null,
 warehouse_id uuid not null,
 quantity numeric(24,6) not null default 0 check (quantity >= 0),
 value numeric(24,6) not null default 0 check (value >= 0),
 updated_at timestamptz not null default now(),
 primary key (tenant_id, item_id, warehouse_id),
 check (quantity > 0 or value = 0),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, item_id) references lara.items (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, warehouse_id) references lara.warehouses (tenant_id, entity_id, id)
);

-- Valuation layers: one per receipt line (and per transfer-in or count gain),
-- consumed oldest first by effective date then receipt id; value adjusts only
-- through landed cost allocations.
create table lara.valuation_layers (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 item_id uuid not null,
 warehouse_id uuid not null,
 receipt_line_id uuid not null,
 effective_date date not null,
 seq bigint generated always as identity,
 qty_received numeric(24,6) not null check (qty_received > 0),
 qty_remaining numeric(24,6) not null check (qty_remaining >= 0),
 unit_cost numeric(24,12) not null check (unit_cost >= 0),
 currency text not null check (currency ~ '^[A-Z]{3}$'),
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 check (qty_remaining <= qty_received),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, item_id) references lara.items (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, warehouse_id) references lara.warehouses (tenant_id, entity_id, id),
 foreign key (tenant_id, receipt_line_id) references lara.stock_movement_lines (tenant_id, id)
);
create index valuation_layers_fifo on lara.valuation_layers (tenant_id, item_id, warehouse_id, effective_date, seq) where qty_remaining > 0;
create or replace function lara.valuation_layers_validate() returns trigger language plpgsql as $$
begin
 if new.item_id <> old.item_id or new.warehouse_id <> old.warehouse_id or new.qty_received <> old.qty_received or new.effective_date <> old.effective_date or new.receipt_line_id <> old.receipt_line_id then
  raise exception 'STATE_CONFLICT: valuation layer identity is immutable' using errcode = 'check_violation';
 end if;
 return new;
end $$;
create trigger valuation_layers_validate before update on lara.valuation_layers for each row execute function lara.valuation_layers_validate();

create table lara.stock_allocations (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 issue_line_id uuid not null,
 layer_id uuid not null,
 quantity numeric(24,6) not null check (quantity > 0),
 cost numeric(24,6) not null check (cost >= 0),
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, issue_line_id) references lara.stock_movement_lines (tenant_id, id),
 foreign key (tenant_id, layer_id) references lara.valuation_layers (tenant_id, id)
);
create index stock_allocations_layer on lara.stock_allocations (tenant_id, layer_id);
create trigger stock_allocations_append_only before update or delete on lara.stock_allocations for each row execute function lara.reject_mutation();

-- Lots and serials: a serial is one unit in one warehouse.
create table lara.lot_serials (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 item_id uuid not null,
 code text not null check (length(code) between 1 and 100),
 kind text not null check (kind in ('batch','serial')),
 warehouse_id uuid,
 quantity numeric(24,6) not null default 0 check (quantity >= 0),
 status text not null default 'in_stock' check (status in ('in_stock','issued')),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, item_id, code),
 check (kind <> 'serial' or quantity <= 1),
 check (status <> 'in_stock' or quantity = 0 or warehouse_id is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, item_id) references lara.items (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, warehouse_id) references lara.warehouses (tenant_id, entity_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create trigger lot_serials_touch before update on lara.lot_serials for each row execute function lara.touch_row();

-- Count sessions: expected quantities freeze at the cutoff; the observed
-- quantity is reviewed and the variance posts once with independent approval.
create table lara.count_sessions (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 warehouse_id uuid not null,
 cutoff_at timestamptz not null,
 evidence_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_ids) = 'array'),
 state text not null default 'draft' check (state in ('draft','approved','posted','rejected')),
 approved_by uuid,
 movement_id uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, warehouse_id) references lara.warehouses (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, movement_id) references lara.stock_movements (tenant_id, entity_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create or replace function lara.count_sessions_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('approved','posted') and (new.cutoff_at <> old.cutoff_at or new.warehouse_id <> old.warehouse_id) then
  raise exception 'STATE_CONFLICT: an approved count is frozen' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('approved','rejected')) or
  (old.state = 'approved' and new.state = 'posted')) then
  raise exception 'STATE_CONFLICT: count cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if new.state = 'posted' and new.movement_id is null then raise exception 'STATE_CONFLICT: a posted count names its adjustment movement' using errcode = 'check_violation'; end if;
 return new;
end $$;
create trigger count_sessions_validate before update on lara.count_sessions for each row execute function lara.count_sessions_validate();
create trigger count_sessions_touch before update on lara.count_sessions for each row execute function lara.touch_row();
create table lara.count_lines (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 session_id uuid not null,
 item_id uuid not null,
 expected_quantity numeric(24,6) not null check (expected_quantity >= 0),
 observed_quantity numeric(24,6) not null check (observed_quantity >= 0),
 variance_value numeric(24,6),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, session_id, item_id),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, session_id) references lara.count_sessions (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, item_id) references lara.items (tenant_id, entity_id, id)
);
create or replace function lara.count_lines_guard() returns trigger language plpgsql as $$
declare s_state text;
begin
 if tg_op = 'DELETE' and current_setting('lara.maintenance', true) = 'teardown' and (exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper)) or exists (select 1 from pg_tables where schemaname = tg_table_schema and tablename = tg_table_name and tableowner = current_user)) then return old; end if;
 select state into s_state from lara.count_sessions where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.session_id, old.session_id);
 if tg_op = 'DELETE' and s_state <> 'draft' then raise exception 'STATE_CONFLICT: lines of an approved count are frozen' using errcode = 'check_violation'; end if;
 if tg_op = 'INSERT' and s_state <> 'draft' then raise exception 'STATE_CONFLICT: lines of an approved count are frozen' using errcode = 'check_violation'; end if;
 if tg_op = 'UPDATE' and s_state <> 'draft' and (new.observed_quantity <> old.observed_quantity or new.expected_quantity <> old.expected_quantity) then raise exception 'STATE_CONFLICT: quantities of an approved count are frozen' using errcode = 'check_violation'; end if;
 if tg_op = 'DELETE' then return old; end if;
 return new;
end $$;
create trigger count_lines_guard before insert or update or delete on lara.count_lines for each row execute function lara.count_lines_guard();

-- Landed cost runs: an approved charge allocated over receipts by value or
-- quantity; the remaining portion raises the layers, the sold portion goes to
-- cost of sales; allocations are append-only.
create table lara.landed_cost_runs (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 book_id uuid not null,
 charge_document_id uuid not null,
 receipt_ids jsonb not null check (jsonb_typeof(receipt_ids) = 'array' and jsonb_array_length(receipt_ids) >= 1),
 method text not null check (method in ('value','quantity','weight')),
 amount numeric(24,6) not null check (amount > 0),
 preview_json jsonb,
 state text not null default 'draft' check (state in ('draft','previewed','approved','posted','rejected')),
 approved_by uuid,
 posted_entry_id uuid,
 content_version bigint not null default 1 check (content_version >= 1),
 created_at timestamptz not null default now(),
 created_by uuid not null,
 updated_at timestamptz not null default now(),
 version bigint not null default 1 check (version >= 1),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, entity_id, id),
 check (state <> 'approved' or approved_by is not null),
 check (approved_by is null or approved_by <> created_by),
 check (state not in ('previewed','approved','posted') or preview_json is not null),
 check (state <> 'posted' or posted_entry_id is not null),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, book_id) references lara.books (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, charge_document_id) references lara.documents (tenant_id, entity_id, id),
 foreign key (tenant_id, entity_id, book_id, posted_entry_id) references lara.journal_entries (tenant_id, entity_id, book_id, id),
 foreign key (tenant_id, approved_by) references lara.principals (tenant_id, id),
 foreign key (tenant_id, created_by) references lara.principals (tenant_id, id)
);
create unique index landed_cost_runs_one_per_charge on lara.landed_cost_runs (tenant_id, charge_document_id) where state <> 'rejected';
create or replace function lara.landed_cost_runs_validate() returns trigger language plpgsql as $$
begin
 if old.state in ('approved','posted') and (new.receipt_ids <> old.receipt_ids or new.method <> old.method or new.amount <> old.amount or new.charge_document_id <> old.charge_document_id) then
  raise exception 'STATE_CONFLICT: an approved landed cost run is frozen' using errcode = 'check_violation';
 end if;
 if new.state <> old.state and not (
  (old.state = 'draft' and new.state in ('previewed','rejected')) or
  (old.state = 'previewed' and new.state in ('approved','rejected','draft','previewed')) or
  (old.state = 'approved' and new.state in ('posted','rejected'))) then
  raise exception 'STATE_CONFLICT: landed cost run cannot move from % to %', old.state, new.state using errcode = 'check_violation';
 end if;
 if old.state = 'posted' and new.posted_entry_id is distinct from old.posted_entry_id then raise exception 'STATE_CONFLICT: a posted run keeps its entry' using errcode = 'check_violation'; end if;
 return new;
end $$;
create trigger landed_cost_runs_validate before update on lara.landed_cost_runs for each row execute function lara.landed_cost_runs_validate();
create trigger landed_cost_runs_touch before update on lara.landed_cost_runs for each row execute function lara.touch_row();
create table lara.landed_cost_allocations (
 id uuid not null default gen_random_uuid(),
 tenant_id uuid not null,
 entity_id uuid not null,
 run_id uuid not null,
 layer_id uuid not null,
 receipt_line_id uuid not null,
 basis numeric(24,6) not null check (basis >= 0),
 amount numeric(24,6) not null check (amount >= 0),
 to_inventory numeric(24,6) not null check (to_inventory >= 0),
 to_cogs numeric(24,6) not null check (to_cogs >= 0),
 created_at timestamptz not null default now(),
 primary key (id),
 unique (tenant_id, id),
 unique (tenant_id, run_id, layer_id),
 check (to_inventory + to_cogs = amount),
 foreign key (tenant_id, entity_id) references lara.entities (tenant_id, id),
 foreign key (tenant_id, entity_id, run_id) references lara.landed_cost_runs (tenant_id, entity_id, id),
 foreign key (tenant_id, layer_id) references lara.valuation_layers (tenant_id, id),
 foreign key (tenant_id, receipt_line_id) references lara.stock_movement_lines (tenant_id, id)
);
create trigger landed_cost_allocations_append_only before update or delete on lara.landed_cost_allocations for each row execute function lara.reject_mutation();

-- RLS and grants
do $$
declare target text;
begin
 foreach target in array array['warehouses','items','stock_movements','stock_movement_lines','stock_balances','valuation_layers','stock_allocations','lot_serials','count_sessions','count_lines','landed_cost_runs','landed_cost_allocations'] loop
  execute format('alter table lara.%I enable row level security', target);
  execute format('alter table lara.%I force row level security', target);
  execute format('create policy tenant_scope on lara.%I using (tenant_id = lara.current_tenant()) with check (tenant_id = lara.current_tenant())', target);
 end loop;
end $$;
grant select, insert, update on lara.warehouses, lara.items, lara.stock_movements, lara.stock_balances, lara.valuation_layers, lara.lot_serials, lara.count_sessions, lara.landed_cost_runs to lara_api;
grant select, insert, update, delete on lara.stock_movement_lines, lara.count_lines to lara_api;
grant select, insert on lara.stock_allocations, lara.landed_cost_allocations to lara_api;
grant select on lara.warehouses, lara.items, lara.stock_movements, lara.stock_movement_lines, lara.stock_balances, lara.valuation_layers, lara.stock_allocations, lara.lot_serials, lara.count_sessions, lara.count_lines, lara.landed_cost_runs, lara.landed_cost_allocations to lara_worker, lara_audit_reader;
