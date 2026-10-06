-- ลงฐานข้อมูลจริงแล้ว 6 ต.ค. 2569 (เวอร์ชัน 20261006061209) — สำเนาจาก supabase_migrations.schema_migrations
-- 015 CSE-SMART-LAB ระยะ 1: สิทธิ์ตามงานมอบหมาย + ทะเบียนห้อง/โซน/ผู้ดูแลห้อง
alter table public.users
  add column if not exists is_scientist boolean not null default false,
  add column if not exists line_id text,
  add column if not exists telegram_chat_id text;

create table if not exists public.zones (
  zone_id uuid primary key default gen_random_uuid(),
  building text not null,
  floor text,
  name text not null,
  sort_order integer not null default 0,
  note text,
  created_at timestamptz not null default now()
);

alter table public.locations
  add column if not exists zone_id uuid references public.zones(zone_id) on delete set null,
  add column if not exists room_code text,
  add column if not exists setup_minutes integer not null default 0 check (setup_minutes between 0 and 600),
  add column if not exists teardown_minutes integer not null default 0 check (teardown_minutes between 0 and 600),
  add column if not exists room_status text not null default 'active' check (room_status in ('active', 'closed')),
  add column if not exists note text;
create unique index if not exists uq_locations_room_code on public.locations (room_code) where room_code is not null;

create table if not exists public.staff_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  kind text not null check (kind in ('course_owner', 'instructor', 'lab_staff', 'lab_worker', 'room_manager', 'room_backup', 'room_delegate', 'cost_viewer')),
  course_id uuid references public.courses(course_id) on delete cascade,
  semester_id uuid references public.semesters(semester_id) on delete cascade,
  section_id uuid references public.lab_sections(section_id) on delete cascade,
  location_id uuid references public.locations(location_id) on delete cascade,
  department_id uuid references public.departments(department_id) on delete cascade,
  valid_from date,
  valid_to date,
  created_by uuid references public.users(user_id),
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  check (
    (kind in ('course_owner', 'lab_staff', 'lab_worker') and course_id is not null and semester_id is not null) or
    (kind = 'instructor' and section_id is not null) or
    (kind in ('room_manager', 'room_backup') and location_id is not null) or
    (kind = 'room_delegate' and location_id is not null and valid_from is not null and valid_to is not null) or
    (kind = 'cost_viewer')
  )
);
create unique index if not exists uq_assign on public.staff_assignments
  (user_id, kind, coalesce(course_id, '00000000-0000-0000-0000-000000000000'), coalesce(semester_id, '00000000-0000-0000-0000-000000000000'),
   coalesce(section_id, '00000000-0000-0000-0000-000000000000'), coalesce(location_id, '00000000-0000-0000-0000-000000000000'),
   coalesce(department_id, '00000000-0000-0000-0000-000000000000'), coalesce(valid_from, '1900-01-01'));
create index if not exists idx_assign_user on public.staff_assignments (user_id);
create index if not exists idx_assign_course on public.staff_assignments (course_id, semester_id);
create index if not exists idx_assign_section on public.staff_assignments (section_id);
create index if not exists idx_assign_location on public.staff_assignments (location_id);
create unique index if not exists uq_room_manager on public.staff_assignments (location_id) where kind = 'room_manager';
create unique index if not exists uq_room_backup on public.staff_assignments (location_id) where kind = 'room_backup';

create table if not exists public.user_away (
  away_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  from_date date not null,
  to_date date not null check (to_date >= from_date),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_user_away on public.user_away (user_id, from_date, to_date);

create table if not exists public.course_owner_requests (
  request_id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(course_id) on delete cascade,
  semester_id uuid not null references public.semesters(semester_id) on delete cascade,
  user_id uuid not null references public.users(user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  message text,
  decided_by uuid references public.users(user_id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_owner_request_pending on public.course_owner_requests (course_id, semester_id, user_id) where status = 'pending';

insert into public.staff_assignments (user_id, kind, section_id)
select s.instructor_id, 'instructor', s.section_id from public.lab_sections s where s.instructor_id is not null
on conflict do nothing;
insert into public.staff_assignments (user_id, kind, course_id, semester_id)
select distinct s.instructor_id, 'course_owner', s.course_id, s.semester_id from public.lab_sections s where s.instructor_id is not null
on conflict do nothing;

alter table public.zones enable row level security;
alter table public.staff_assignments enable row level security;
alter table public.user_away enable row level security;
alter table public.course_owner_requests enable row level security;
create policy "staff read zones" on public.zones for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "staff read staff_assignments" on public.staff_assignments for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "staff read user_away" on public.user_away for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "own or admin read course_owner_requests" on public.course_owner_requests for select
  using (user_id = auth.uid() or public.is_admin());
create policy "admin full access zones" on public.zones for all using (public.is_admin());
create policy "admin full access staff_assignments" on public.staff_assignments for all using (public.is_admin());
create policy "admin full access user_away" on public.user_away for all using (public.is_admin());
create policy "admin full access course_owner_requests" on public.course_owner_requests for all using (public.is_admin());
