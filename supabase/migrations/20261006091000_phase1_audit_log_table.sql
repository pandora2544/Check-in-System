-- ลงแล้ว 6 ต.ค. 2569 (apply_migration phase1_audit_log_table)
create table if not exists public.audit_log (
  audit_id bigint generated always as identity primary key,
  table_name text not null,
  row_id text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor uuid,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create index if not exists idx_audit_row on public.audit_log (table_name, row_id, at desc);
create index if not exists idx_audit_actor on public.audit_log (actor, at desc);
alter table public.audit_log enable row level security;
create policy "admin read audit_log" on public.audit_log for select using (public.is_admin());
