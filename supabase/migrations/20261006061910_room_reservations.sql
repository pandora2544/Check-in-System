-- ลงฐานข้อมูลจริงแล้ว 6 ต.ค. 2569 (เวอร์ชัน 20261006061910) — สำเนาจาก supabase_migrations.schema_migrations
create extension if not exists btree_gist with schema extensions;

alter table public.schedules
  add column if not exists kind text not null default 'regular' check (kind in ('regular', 'makeup')),
  add column if not exists makeup_of uuid references public.schedules(schedule_id) on delete set null;

create table if not exists public.reservation_series (
  series_id uuid primary key default gen_random_uuid(),
  title text,
  pattern jsonb not null,
  location_id uuid references public.locations(location_id) on delete set null,
  kind text,
  section_id uuid references public.lab_sections(section_id) on delete set null,
  created_by uuid references public.users(user_id),
  created_at timestamptz not null default now()
);

create table if not exists public.room_reservations (
  reservation_id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(location_id),
  kind text not null check (kind in ('class', 'makeup', 'prep', 'reading', 'research', 'project', 'service', 'exam', 'event', 'training', 'maintenance')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  setup_minutes integer not null default 0 check (setup_minutes between 0 and 600),
  teardown_minutes integer not null default 0 check (teardown_minutes between 0 and 600),
  block tstzrange not null,
  schedule_id uuid references public.schedules(schedule_id) on delete cascade,
  section_id uuid references public.lab_sections(section_id) on delete set null,
  course_id uuid references public.courses(course_id) on delete set null,
  semester_id uuid references public.semesters(semester_id) on delete set null,
  project_name text,
  title text,
  purpose text,
  requested_by uuid not null references public.users(user_id),
  actual_user text,
  decided_by uuid references public.users(user_id),
  decided_at timestamptz,
  decision_note text,
  series_id uuid references public.reservation_series(series_id) on delete set null,
  replaces_id uuid references public.room_reservations(reservation_id) on delete set null,
  pending_change jsonb,
  used_hours numeric(7,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  constraint room_reservations_no_overlap exclude using gist (location_id with =, block with &&) where (status in ('pending', 'approved'))
);
create index if not exists idx_resv_schedule on public.room_reservations (schedule_id);
create index if not exists idx_resv_location_time on public.room_reservations (location_id, starts_at);
create index if not exists idx_resv_status on public.room_reservations (status) where status = 'pending';
create index if not exists idx_resv_series on public.room_reservations (series_id);
create index if not exists idx_resv_course on public.room_reservations (course_id, semester_id);

create or replace function public.resv_set_block() returns trigger language plpgsql set search_path = public as $$
begin
  new.block := tstzrange(new.starts_at - make_interval(mins => new.setup_minutes), new.ends_at + make_interval(mins => new.teardown_minutes), '[)');
  new.updated_at := now();
  return new;
end $$;
create or replace trigger trg_resv_block before insert or update of starts_at, ends_at, setup_minutes, teardown_minutes, status, pending_change, decided_at
  on public.room_reservations for each row execute function public.resv_set_block();

create table if not exists public.course_term_settings (
  course_id uuid not null references public.courses(course_id) on delete cascade,
  semester_id uuid not null references public.semesters(semester_id) on delete cascade,
  request_lead_days integer default 14 check (request_lead_days is null or request_lead_days between 0 and 365),
  approve_lead_days integer default 7 check (approve_lead_days is null or approve_lead_days between 0 and 365),
  first_class_date date,
  updated_by uuid references public.users(user_id),
  updated_at timestamptz not null default now(),
  primary key (course_id, semester_id)
);

create or replace function public.schedule_sync_reservation() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_course uuid; v_sem uuid; v_req uuid; v_setup int; v_tear int; v_kind text;
  v_start timestamptz; v_end timestamptz; v_id uuid;
begin
  if tg_op = 'UPDATE' and new.status = 'cancelled' and old.status <> 'cancelled' then
    update room_reservations set status = 'cancelled', decision_note = coalesce(decision_note, 'คาบถูกงด')
     where schedule_id = new.schedule_id and status in ('pending', 'approved');
    return new;
  end if;
  if new.status <> 'scheduled' then return new; end if;

  v_start := (new.class_date + new.start_time) at time zone 'Asia/Bangkok';
  v_end := (new.class_date + new.end_time) at time zone 'Asia/Bangkok';
  v_kind := case when new.kind = 'makeup' then 'makeup' else 'class' end;

  if exists (select 1 from room_reservations r where r.schedule_id = new.schedule_id and r.location_id = new.location_id
              and r.starts_at = v_start and r.ends_at = v_end and r.status in ('pending', 'approved')) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    select reservation_id into v_id from room_reservations r
     where r.schedule_id = new.schedule_id and r.location_id = old.location_id and r.status in ('pending', 'approved')
     order by (r.status = 'approved') desc, r.created_at limit 1;
    if v_id is not null then
      select setup_minutes, teardown_minutes into v_setup, v_tear from locations where location_id = new.location_id;
      update room_reservations set location_id = new.location_id, starts_at = v_start, ends_at = v_end,
             setup_minutes = case when new.location_id = old.location_id then setup_minutes else coalesce(v_setup, 0) end,
             teardown_minutes = case when new.location_id = old.location_id then teardown_minutes else coalesce(v_tear, 0) end,
             kind = v_kind
       where reservation_id = v_id;
      return new;
    end if;
  end if;

  select ls.course_id, ls.semester_id, ls.instructor_id into v_course, v_sem, v_req from lab_sections ls where ls.section_id = new.section_id;
  if v_req is null then select user_id into v_req from users where role = 'admin' order by created_at limit 1; end if;
  select setup_minutes, teardown_minutes into v_setup, v_tear from locations where location_id = new.location_id;
  insert into room_reservations (location_id, kind, status, starts_at, ends_at, setup_minutes, teardown_minutes, schedule_id, section_id, course_id, semester_id, requested_by)
  values (new.location_id, v_kind, 'pending', v_start, v_end, coalesce(v_setup, 0), coalesce(v_tear, 0), new.schedule_id, new.section_id, v_course, v_sem, v_req);
  return new;
end $$;
create or replace trigger trg_schedule_resv after insert or update of class_date, start_time, end_time, location_id, status on public.schedules
  for each row execute function public.schedule_sync_reservation();
revoke all on function public.schedule_sync_reservation() from public, anon, authenticated;

insert into public.room_reservations (location_id, kind, status, starts_at, ends_at, schedule_id, section_id, course_id, semester_id, requested_by, decided_by, decided_at, decision_note)
select s.location_id, 'class', 'approved',
       (s.class_date + s.start_time) at time zone 'Asia/Bangkok', (s.class_date + s.end_time) at time zone 'Asia/Bangkok',
       s.schedule_id, s.section_id, ls.course_id, ls.semester_id,
       coalesce(ls.instructor_id, (select user_id from public.users where role = 'admin' order by created_at limit 1)),
       coalesce(ls.instructor_id, (select user_id from public.users where role = 'admin' order by created_at limit 1)), now(), 'ย้ายจากคาบเดิม (migration 016)'
from public.schedules s join public.lab_sections ls on ls.section_id = s.section_id
where s.status = 'scheduled'
  and not exists (select 1 from public.room_reservations r where r.schedule_id = s.schedule_id);

alter table public.reservation_series enable row level security;
alter table public.room_reservations enable row level security;
alter table public.course_term_settings enable row level security;
create policy "staff read reservation_series" on public.reservation_series for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "staff read room_reservations" on public.room_reservations for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "staff read course_term_settings" on public.course_term_settings for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "admin full access reservation_series" on public.reservation_series for all using (public.is_admin());
create policy "admin full access room_reservations" on public.room_reservations for all using (public.is_admin());
create policy "admin full access course_term_settings" on public.course_term_settings for all using (public.is_admin());
