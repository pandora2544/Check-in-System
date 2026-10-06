-- ⚠️ ร่าง — ยังไม่ apply กับฐานข้อมูลจริง (6 ต.ค. 2569 · รอผู้ใช้อนุมัติ) · ดู docs/plan.md ภาคผนวก ก
-- 015 สิทธิ์ (งานมอบหมาย) + ทะเบียนห้อง/โซน + สถานะไม่อยู่ + บันทึกการแก้ไข
-- เพิ่มอย่างเดียว: ไม่ลบตาราง/คอลัมน์เดิม · users.role เดิมคงไว้ (instructor = บุคลากร) · lab_sections.instructor_id คงไว้ช่วงเปลี่ยนผ่าน

-- ---------- ผู้ใช้: คุณสมบัติ + ช่องทางติดต่อ ----------
alter table public.users
  add column if not exists is_scientist boolean not null default false,   -- นักวิทยาศาสตร์ (เปิดรายวิชาได้ · A1)
  add column if not exists line_id text,
  add column if not exists telegram_chat_id text;                         -- แจ้งส่วนตัว (ต้องผูกบัญชีก่อน)

create or replace function public.is_staff()
returns boolean language sql stable as $$
  select exists (select 1 from public.users where user_id = auth.uid() and role in ('instructor', 'admin'));
$$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated, service_role;

-- ---------- บันทึกการแก้ไข (R1.5: ผู้ทำ เวลา ค่าก่อน/หลัง) ----------
-- Edge Function ตั้งผู้ทำด้วย set_config('app.actor', '<user_id>', true) ก่อนเขียน · ฟังก์ชันจองตั้งให้เอง
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
alter table public.audit_log enable row level security;
create policy "admin read audit_log" on public.audit_log for select using (public.is_admin());

create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_pk text := tg_argv[0];
  v_actor uuid := nullif(current_setting('app.actor', true), '')::uuid;
begin
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then return new; end if;
  insert into audit_log (table_name, row_id, action, actor, before, after)
  values (tg_table_name,
          coalesce(to_jsonb(new) ->> v_pk, to_jsonb(old) ->> v_pk),
          lower(tg_op), coalesce(v_actor, auth.uid()),
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
revoke all on function public.audit_row() from public, anon, authenticated;

-- ---------- โซน (อาคาร → ชั้น → โซน → ห้อง) ----------
create table if not exists public.zones (
  zone_id uuid primary key default gen_random_uuid(),
  building text not null,
  floor text,
  name text not null,                    -- เช่น "ล่างซ้าย เทคนิคการแพทย์"
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (building, floor, name)
);
alter table public.zones enable row level security;
create policy "staff read zones" on public.zones for select using (public.is_staff());
create policy "admin full access zones" on public.zones for all using (public.is_admin());

-- ---------- ห้อง: ใช้ locations เดิม (พิกัด/รัศมี/QR ที่ผู้ใช้ปักไว้) ----------
alter table public.locations
  add column if not exists zone_id uuid references public.zones(zone_id) on delete set null,
  add column if not exists room_code text,
  add column if not exists setup_minutes int not null default 0 check (setup_minutes between 0 and 600),     -- เวลาจัดห้อง (A8)
  add column if not exists teardown_minutes int not null default 0 check (teardown_minutes between 0 and 600), -- เวลาเก็บห้อง ค่าเริ่ม 0
  add column if not exists room_status text not null default 'active' check (room_status in ('active', 'inactive')),
  add column if not exists bookable boolean not null default true;   -- false = จุดเช็คชื่ออย่างเดียว (เช่น ลงพื้นที่)
create unique index if not exists locations_room_code_key on public.locations (room_code) where room_code is not null;
create index if not exists idx_locations_zone on public.locations (zone_id);

-- ---------- งานมอบหมาย: สิทธิ์ = บทบาทบัญชี + หน้าที่ × ขอบเขต × ช่วงวันที่ (ส่วนที่ 1.1) ----------
create table if not exists public.staff_assignments (
  assignment_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  kind text not null check (kind in (
    'course_owner',   -- ผู้ตั้งรายวิชา        (รายวิชา × เทอม)
    'instructor',     -- ผู้สอน               (Section)
    'lab_staff',      -- เจ้าหน้าที่เตรียมแล็บ  (รายวิชา × เทอม)
    'lab_worker',     -- พนักงานห้องทดลอง     (รายวิชา × เทอม)
    'room_manager',   -- ผู้ดูแลห้องหลัก       (ห้อง)
    'room_backup',    -- ผู้สำรอง              (ห้อง)
    'room_delegate',  -- ผู้แทนชั่วคราว        (ห้อง + ช่วงวันที่)
    'cost_viewer'     -- ผู้ดูต้นทุน           (ทั้งศูนย์ หรือ สาขา)
  )),
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
  check (case
    when kind in ('course_owner', 'lab_staff', 'lab_worker') then course_id is not null and semester_id is not null and section_id is null and location_id is null
    when kind = 'instructor' then section_id is not null and location_id is null
    when kind in ('room_manager', 'room_backup') then location_id is not null and course_id is null and section_id is null
    when kind = 'room_delegate' then location_id is not null and valid_from is not null and valid_to is not null
    when kind = 'cost_viewer' then course_id is null and section_id is null and location_id is null
  end)
);
create unique index if not exists staff_assignments_uniq on public.staff_assignments
  (user_id, kind, course_id, semester_id, section_id, location_id, department_id, valid_from) nulls not distinct;
create unique index if not exists staff_assignments_one_manager on public.staff_assignments (location_id) where kind = 'room_manager';
create index if not exists idx_assign_user on public.staff_assignments (user_id, kind);
create index if not exists idx_assign_course on public.staff_assignments (course_id, semester_id);
create index if not exists idx_assign_section on public.staff_assignments (section_id);
create index if not exists idx_assign_location on public.staff_assignments (location_id);
alter table public.staff_assignments enable row level security;
create policy "staff read staff_assignments" on public.staff_assignments for select using (public.is_staff());
create policy "admin full access staff_assignments" on public.staff_assignments for all using (public.is_admin());
create trigger trg_audit_staff_assignments after insert or update or delete on public.staff_assignments
  for each row execute function public.audit_row('assignment_id');

-- R1.6 เปลี่ยนผ่าน: ผู้สอนเดิม → หน้าที่ "ผู้สอน"
insert into public.staff_assignments (user_id, kind, section_id)
select instructor_id, 'instructor', section_id from public.lab_sections where instructor_id is not null
on conflict do nothing;

-- ---------- ผู้ดูแลไม่อยู่ (ผู้สำรองอนุมัติแทนช่วงนั้น · A5) ----------
create table if not exists public.user_away (
  away_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_user_away on public.user_away (user_id, starts_on);
alter table public.user_away enable row level security;
create policy "staff read user_away" on public.user_away for select using (public.is_staff());
create policy "admin full access user_away" on public.user_away for all using (public.is_admin());

-- ---------- ขอเป็นผู้ตั้งรายวิชาร่วม (R1.3) ----------
create table if not exists public.course_owner_requests (
  request_id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(course_id) on delete cascade,
  semester_id uuid not null references public.semesters(semester_id) on delete cascade,
  requested_by uuid not null references public.users(user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  note text,
  decided_by uuid references public.users(user_id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists course_owner_requests_one_pending on public.course_owner_requests (course_id, semester_id, requested_by) where status = 'pending';
alter table public.course_owner_requests enable row level security;
create policy "staff read course_owner_requests" on public.course_owner_requests for select using (public.is_staff());
create policy "admin full access course_owner_requests" on public.course_owner_requests for all using (public.is_admin());

-- ---------- หน้าที่ของผู้ใช้ ณ วันหนึ่ง (ใช้ใน staff-auth.ts และฟังก์ชันจอง) ----------
create or replace function public.active_assignments(p_user uuid, p_on date default (now() at time zone 'Asia/Bangkok')::date)
returns setof public.staff_assignments
language sql stable set search_path = public as $$
  select a.* from staff_assignments a
  where a.user_id = p_user
    and (a.valid_from is null or a.valid_from <= p_on)
    and (a.valid_to is null or a.valid_to >= p_on);
$$;
revoke all on function public.active_assignments(uuid, date) from public, anon, authenticated;
grant execute on function public.active_assignments(uuid, date) to service_role;

-- ---------- ตัวช่วยตรวจสิทธิ์ (ใช้ในฟังก์ชันฐานข้อมูล + Edge Function) ----------
-- แอดมิน (ผู้พัฒนาระบบ) ทำได้ทุกอย่างเสมอ — ทุกฟังก์ชันด้านล่างคืน true ให้แอดมิน
create or replace function public.user_is_admin(p_user uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from users where user_id = p_user and role = 'admin');
$$;

-- ผู้ตั้งรายวิชา (นักวิทย์ที่รับผิดชอบรายวิชา) ของรายวิชา-เทอม
create or replace function public.user_owns_course(p_user uuid, p_course uuid, p_semester uuid)
returns boolean language sql stable set search_path = public as $$
  select user_is_admin(p_user) or exists (select 1 from staff_assignments a where a.user_id = p_user and a.kind = 'course_owner'
                                           and a.course_id = p_course and a.semester_id = p_semester);
$$;

-- อาจารย์ผู้สอนของ Section (นักวิทย์บันทึกให้ตามที่สำนักวิชาแจ้ง)
create or replace function public.user_teaches_section(p_user uuid, p_section uuid)
returns boolean language sql stable set search_path = public as $$
  select user_is_admin(p_user) or exists (select 1 from staff_assignments a where a.user_id = p_user and a.kind = 'instructor'
                                           and a.section_id = p_section);
$$;

-- จัดการคาบ (เลื่อน/งด/ชดเชย) = ผู้ตั้งรายวิชาของวิชานั้น
create or replace function public.user_manages_schedule(p_user uuid, p_schedule uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from schedules s join lab_sections ls on ls.section_id = s.section_id
                 where s.schedule_id = p_schedule and user_owns_course(p_user, ls.course_id, ls.semester_id));
$$;

revoke all on function public.user_is_admin(uuid), public.user_owns_course(uuid, uuid, uuid),
  public.user_teaches_section(uuid, uuid), public.user_manages_schedule(uuid, uuid) from public, anon, authenticated;
grant execute on function public.user_is_admin(uuid), public.user_owns_course(uuid, uuid, uuid),
  public.user_teaches_section(uuid, uuid), public.user_manages_schedule(uuid, uuid) to service_role;
