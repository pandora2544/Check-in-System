-- ⚠️ ร่าง — ยังไม่ apply กับฐานข้อมูลจริง (6 ต.ค. 2569 · รอผู้ใช้อนุมัติ) · ดู docs/plan.md ส่วนที่ 1.2–1.4, 2 + ภาคผนวก ก
-- 017 คาบหลายบท · ชดเชย · กฎงานต่อบท · ตารางงาน · วันลา · ของค้างห้อง · ความพร้อมของคาบ

-- ---------- คาบ: ประเภท + ชดเชยของคาบไหน ----------
alter table public.schedules
  add column if not exists kind text not null default 'regular' check (kind in ('regular', 'makeup')),
  add column if not exists makeup_of uuid references public.schedules(schedule_id) on delete set null;
update public.schedules s set kind = 'makeup'
from public.room_bookings b where b.booking_id = s.booking_id and b.booking_type = 'makeup' and s.kind <> 'makeup';
create trigger trg_audit_schedules after insert or update or delete on public.schedules
  for each row execute function public.audit_row('schedule_id');

alter table public.lab_sections add column if not exists expected_students int check (expected_students >= 0);

-- เวลาจัด/เก็บห้องต่อบท (A8: ค่าห้อง → บท → รายครั้ง) · null = ใช้ค่าห้อง
alter table public.lab_topics
  add column if not exists setup_minutes int check (setup_minutes between 0 and 600),
  add column if not exists teardown_minutes int check (teardown_minutes between 0 and 600);

-- ---------- บทของคาบ (รวมแล็บ 1.4F) — schedules.topic_id = บทแรก เพื่อให้โค้ดเดิม/Telegram ทำงาน ----------
create table if not exists public.session_topics (
  schedule_id uuid not null references public.schedules(schedule_id) on delete cascade,
  topic_id uuid not null references public.lab_topics(topic_id) on delete cascade,
  seq smallint not null default 1,
  time_share numeric(5, 2),            -- สัดส่วนเวลาบท (null = เท่ากัน) ใช้แบ่งต้นทุนห้อง/เครื่อง
  primary key (schedule_id, topic_id)
);
create index if not exists idx_session_topics_topic on public.session_topics (topic_id);
insert into public.session_topics (schedule_id, topic_id, seq)
select schedule_id, topic_id, 1 from public.schedules where topic_id is not null
on conflict do nothing;

-- session_topics เปลี่ยน → schedules.topic_id = บทแรก
create or replace function public.sync_first_topic()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_sid uuid := coalesce(new.schedule_id, old.schedule_id);
begin
  if pg_trigger_depth() > 1 then return null; end if;
  update schedules set topic_id = (select topic_id from session_topics where schedule_id = v_sid order by seq, topic_id limit 1)
  where schedule_id = v_sid;
  return null;
end $$;
create trigger trg_session_topics_first after insert or update or delete on public.session_topics
  for each row execute function public.sync_first_topic();

-- โค้ดเดิมแก้ schedules.topic_id ตรง → บทของคาบเหลือบทเดียวตามนั้น
create or replace function public.sync_topic_to_session()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  delete from session_topics where schedule_id = new.schedule_id;
  if new.topic_id is not null then
    insert into session_topics (schedule_id, topic_id, seq) values (new.schedule_id, new.topic_id, 1);
  end if;
  return new;
end $$;
create trigger trg_schedule_topic_legacy after update of topic_id on public.schedules
  for each row when (old.topic_id is distinct from new.topic_id) execute function public.sync_topic_to_session();
create trigger trg_schedule_topic_insert after insert on public.schedules
  for each row when (new.topic_id is not null) execute function public.sync_topic_to_session();

-- ---------- กฎงานต่อบท (2.3) ----------
create table if not exists public.topic_task_rules (
  rule_id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.lab_topics(topic_id) on delete cascade,
  task_type text not null check (task_type in ('prep', 'supervise', 'reading', 'cleanup', 'other')),  -- เตรียม/คุมแล็บ/อ่านผล/เก็บ/อื่นๆ
  title text,
  offset_days int not null default 0,          -- เทียบวันเรียน: −1 = ก่อน 1 วัน, 0 = วันเรียน, +1 = หลัง 1 วัน
  start_time time,                             -- null = ไม่ระบุเวลา (วันเรียน: เวลาคาบ)
  duration_hours numeric(5, 2),
  needs_room boolean not null default false,   -- true → สร้างคำขอจองประเภทเตรียม/อ่านผล
  default_assignee uuid references public.users(user_id) on delete set null,
  note text,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_task_rules_topic on public.topic_task_rules (topic_id);

-- ---------- ตารางงาน ----------
create table if not exists public.tasks (
  task_id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('rule', 'manual', 'general')),   -- จากกฎ / เพิ่มเองในวิชา / งานทั่วไป
  rule_id uuid references public.topic_task_rules(rule_id) on delete set null,
  schedule_id uuid references public.schedules(schedule_id) on delete cascade,
  course_id uuid references public.courses(course_id) on delete cascade,
  semester_id uuid references public.semesters(semester_id) on delete cascade,
  task_type text not null check (task_type in ('prep', 'supervise', 'reading', 'cleanup', 'other')),
  title text not null,
  assignee_id uuid references public.users(user_id) on delete set null,
  task_date date not null,
  start_time time,
  duration_hours numeric(5, 2),
  status text not null default 'todo' check (status in ('todo', 'done', 'cancelled')),
  actual_hours numeric(5, 2),
  manually_edited boolean not null default false,   -- แก้รายงานแล้ว → คาบเลื่อนไม่ทับค่าที่แก้
  reservation_id uuid references public.room_reservations(reservation_id) on delete set null,
  handed_over_from uuid references public.users(user_id) on delete set null,
  done_by uuid references public.users(user_id),
  done_at timestamptz,
  note text,
  created_by uuid references public.users(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source = 'general' or course_id is not null)
);
create unique index if not exists tasks_rule_schedule_key on public.tasks (rule_id, schedule_id) where rule_id is not null;
create index if not exists idx_tasks_assignee_date on public.tasks (assignee_id, task_date);
create index if not exists idx_tasks_schedule on public.tasks (schedule_id);
create index if not exists idx_tasks_course on public.tasks (course_id, semester_id);
create trigger trg_audit_tasks after insert or update or delete on public.tasks
  for each row execute function public.audit_row('task_id');

-- คาบเลื่อน → งานจากกฎเลื่อนตาม (ยกเว้นที่แก้เอง) · คาบงด → งานยกเลิก
create or replace function public.sync_schedule_tasks()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update tasks set status = 'cancelled', updated_at = now() where schedule_id = new.schedule_id and status = 'todo';
  elsif new.class_date <> old.class_date then
    update tasks t set task_date = new.class_date + r.offset_days, updated_at = now()
    from topic_task_rules r
    where t.rule_id = r.rule_id and t.schedule_id = new.schedule_id and t.status = 'todo' and not t.manually_edited;
  end if;
  return new;
end $$;
create trigger trg_schedule_tasks after update of class_date, status on public.schedules
  for each row execute function public.sync_schedule_tasks();

-- สร้างงานจากกฎให้คาบที่ระบุ (เรียกหลังตั้งบท/ตั้งกฎ) — ไม่สร้างซ้ำ · ผู้รับ = ค่าเริ่มของกฎ หรือเจ้าหน้าที่คนแรกของวิชา
create or replace function public.generate_rule_tasks(p_schedule_ids uuid[])
returns int language sql set search_path = public as $$
  with ins as (
    insert into tasks (source, rule_id, schedule_id, course_id, semester_id, task_type, title, assignee_id, task_date, start_time, duration_hours)
    select 'rule', r.rule_id, s.schedule_id, ls.course_id, ls.semester_id, r.task_type,
      coalesce(r.title, case r.task_type when 'prep' then 'เตรียมแล็บ' when 'supervise' then 'คุมแล็บ' when 'reading' then 'อ่านผล'
                                         when 'cleanup' then 'เก็บแล็บ' else 'งาน' end) || ' · ' || t.title_th,
      coalesce(r.default_assignee, (select a.user_id from staff_assignments a where a.course_id = ls.course_id and a.semester_id = ls.semester_id
                                     and a.kind in ('lab_staff', 'lab_worker') order by a.kind, a.created_at limit 1)),
      s.class_date + r.offset_days,
      coalesce(r.start_time, case when r.offset_days = 0 then s.start_time end),
      r.duration_hours
    from schedules s
    join lab_sections ls on ls.section_id = s.section_id
    join session_topics st on st.schedule_id = s.schedule_id
    join lab_topics t on t.topic_id = st.topic_id
    join topic_task_rules r on r.topic_id = st.topic_id
    where s.schedule_id = any (p_schedule_ids) and s.status = 'scheduled'
    on conflict do nothing
    returning 1
  ) select count(*)::int from ins;
$$;

-- ---------- วันลาของเจ้าหน้าที่/พนักงาน (2.4) ----------
create table if not exists public.staff_leaves (
  leave_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_staff_leaves_user on public.staff_leaves (user_id, starts_on);

-- ---------- ของค้างห้อง (A9) — ไม่กันห้อง แต่เตือนผู้จองช่วงนั้น ----------
create table if not exists public.room_items (
  item_id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(location_id) on delete cascade,
  description text not null,
  position text,                                            -- โต๊ะ/มุม
  course_id uuid references public.courses(course_id) on delete set null,
  schedule_id uuid references public.schedules(schedule_id) on delete set null,        -- ของคาบไหน
  reuse_schedule_id uuid references public.schedules(schedule_id) on delete set null,  -- จะใช้อีกที่คาบไหน (เลื่อนตามคาบ)
  reuse_at timestamptz,                                     -- หรือวันเวลาที่จะใช้อีก
  movable text not null default 'no' check (movable in ('no', 'temporary')),  -- ห้ามย้าย / ย้ายชั่วคราวได้
  contact_user_id uuid references public.users(user_id) on delete set null,
  contact_note text,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_by uuid references public.users(user_id),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists idx_room_items_loc on public.room_items (location_id) where status = 'active';

-- ---------- ความพร้อมของคาบ: ระบบคำนวณ + คนติ๊ก (R1.11) ----------
create table if not exists public.readiness_checks (
  schedule_id uuid not null references public.schedules(schedule_id) on delete cascade,
  check_key text not null check (check_key in ('rooms', 'topic', 'roster', 'worksheet', 'materials', 'equipment', 'room_items')),
  checked_by uuid not null references public.users(user_id),
  checked_at timestamptz not null default now(),
  note text,
  primary key (schedule_id, check_key)
);

-- ส่วน "ระบบ" (ระยะ 1: ห้อง · บท · รายชื่อ) — ส่วนอื่นเติมเมื่อมีใบงาน/คลัง
create or replace function public.schedule_readiness(p_schedule_ids uuid[])
returns table (schedule_id uuid, rooms_ok boolean, rooms_pending int, topic_ok boolean, roster_ok boolean, checks jsonb)
language sql stable set search_path = public as $$
  select s.schedule_id,
    exists (select 1 from room_reservations r where r.schedule_id = s.schedule_id and r.status = 'approved')
      and not exists (select 1 from room_reservations r where r.schedule_id = s.schedule_id and r.status = 'pending'),
    (select count(*)::int from room_reservations r where r.schedule_id = s.schedule_id and r.status = 'pending'),
    exists (select 1 from session_topics t where t.schedule_id = s.schedule_id),
    exists (select 1 from section_enrollments e where e.section_id = s.section_id),
    coalesce((select jsonb_object_agg(c.check_key, jsonb_build_object('by', c.checked_by, 'at', c.checked_at, 'note', c.note))
              from readiness_checks c where c.schedule_id = s.schedule_id), '{}'::jsonb)
  from schedules s where s.schedule_id = any (p_schedule_ids);
$$;

-- ---------- RLS: บุคลากรอ่าน · เขียนผ่าน Edge Function `staff` / `manage` ----------
do $$
declare t text;
begin
  foreach t in array array['session_topics', 'topic_task_rules', 'tasks', 'staff_leaves', 'room_items', 'readiness_checks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "staff read %s" on public.%I for select using (public.is_staff())', t, t);
    execute format('create policy "admin full access %s" on public.%I for all using (public.is_admin())', t, t);
  end loop;
end $$;
-- นักศึกษาเห็นบทของคาบตัวเอง (หน้าเช็คชื่อแสดง "ปฏิบัติการที่ 1+2")
create policy "student read own session_topics" on public.session_topics for select using (
  exists (select 1 from public.schedules s join public.section_enrollments e on e.section_id = s.section_id
          where s.schedule_id = session_topics.schedule_id and e.student_id = auth.uid()));

revoke all on function public.sync_first_topic(), public.sync_topic_to_session(), public.sync_schedule_tasks() from public, anon, authenticated;
revoke all on function public.generate_rule_tasks(uuid[]), public.schedule_readiness(uuid[]) from public, anon, authenticated;
grant execute on function public.generate_rule_tasks(uuid[]), public.schedule_readiness(uuid[]) to service_role;
