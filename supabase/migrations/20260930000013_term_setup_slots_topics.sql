-- 013 ตั้งค่าเทอมล่วงหน้า: ช่วงเวลาประจำสัปดาห์ของกลุ่มเรียน + วันหยุด + บทปฏิบัติการ
-- ลำดับการใช้งาน: ตั้งวันเวลา/ห้อง → ระบบสร้างคาบทั้งเทอม → กำหนดบทของแต่ละคาบ → (ใบงาน/คลัง) → นำเข้ารายชื่อหลังลงทะเบียน

-- วันเวลาเรียนประจำสัปดาห์ของกลุ่มเรียน (1 กลุ่มมีได้หลายช่วง เช่น อังคารบ่าย + พฤหัสเช้า)
create table if not exists public.section_slots (
  slot_id uuid primary key default gen_random_uuid(),
  section_id uuid not null references public.lab_sections(section_id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),       -- ISO: 1=จันทร์ … 7=อาทิตย์
  start_time time not null,
  end_time time not null check (end_time > start_time),
  location_id uuid not null references public.locations(location_id),
  created_at timestamptz not null default now()
);
create index if not exists idx_section_slots_section on public.section_slots (section_id);

-- ช่วงวันที่สร้างคาบของกลุ่มเรียน (ค่าเริ่มต้น = วันเปิด–ปิดเทอม) — เช่น แล็บเริ่มสัปดาห์ที่ 2
alter table public.lab_sections
  add column if not exists teach_from date,
  add column if not exists teach_to date;

-- วันหยุดของเทอม (ไม่สร้างคาบ)
create table if not exists public.term_holidays (
  holiday_id uuid primary key default gen_random_uuid(),
  semester_id uuid not null references public.semesters(semester_id) on delete cascade,
  holiday_date date not null,
  name text not null default 'วันหยุด',
  unique (semester_id, holiday_date)
);

-- บทปฏิบัติการของรายวิชา (แอดมิน/อาจารย์ค่อยๆ เพิ่ม) — ใบงาน/รายการของจะเกาะกับบทในขั้นถัดไป
create table if not exists public.lab_topics (
  topic_id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(course_id) on delete cascade,
  seq integer not null default 1,              -- ปฏิบัติการที่
  title_th text not null,
  title_en text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lab_topics_course on public.lab_topics (course_id, seq);

-- คาบรู้ว่าเกิดจากช่วงเวลาไหน และเป็นบทอะไร
alter table public.schedules
  add column if not exists slot_id uuid references public.section_slots(slot_id) on delete set null,
  add column if not exists topic_id uuid references public.lab_topics(topic_id) on delete set null,
  add column if not exists note text;
create index if not exists idx_schedules_topic on public.schedules (topic_id);

-- RLS: อ่านได้เฉพาะบุคลากร · เขียนผ่าน Edge Function (service role) เท่านั้น
alter table public.section_slots enable row level security;
alter table public.term_holidays enable row level security;
alter table public.lab_topics enable row level security;
create policy "staff read section_slots" on public.section_slots for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "staff read term_holidays" on public.term_holidays for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "authenticated read lab_topics" on public.lab_topics for select using (auth.uid() is not null);
create policy "admin full access section_slots" on public.section_slots for all using (public.is_admin());
create policy "admin full access term_holidays" on public.term_holidays for all using (public.is_admin());
create policy "admin full access lab_topics" on public.lab_topics for all using (public.is_admin());

-- สรุปคาบสำหรับปฏิทิน: เพิ่มบทปฏิบัติการ
drop function if exists public.staff_schedule_stats(date, date, uuid[]);
create function public.staff_schedule_stats(p_from date, p_to date, p_section_ids uuid[])
returns table (
  schedule_id uuid, section_id uuid, class_date date, start_time time, end_time time, status text,
  room text, enrolled int, present int, late int, absent int, excused int, checked_out int,
  topic_seq int, topic_title text
)
language sql stable
set search_path = public
as $$
  with sch as (
    select s.* from schedules s
    where s.class_date between p_from and p_to and s.section_id = any (p_section_ids)
  ), enr as (
    select e.section_id, count(*)::int n from section_enrollments e
    where e.section_id = any (p_section_ids) group by e.section_id
  ), att as (
    select a.schedule_id,
      count(*) filter (where a.status = 'present')::int present,
      count(*) filter (where a.status = 'late')::int late,
      count(*) filter (where a.status = 'absent')::int absent,
      count(*) filter (where a.status = 'excused')::int excused,
      count(*) filter (where a.check_out_time is not null)::int checked_out
    from attendance_records a where a.schedule_id in (select sch.schedule_id from sch)
    group by a.schedule_id
  )
  select sch.schedule_id, sch.section_id, sch.class_date, sch.start_time, sch.end_time, sch.status,
         l.name, coalesce(enr.n, 0), coalesce(att.present, 0), coalesce(att.late, 0),
         coalesce(att.absent, 0), coalesce(att.excused, 0), coalesce(att.checked_out, 0),
         t.seq, t.title_th
  from sch
  join locations l on l.location_id = sch.location_id
  left join enr on enr.section_id = sch.section_id
  left join att on att.schedule_id = sch.schedule_id
  left join lab_topics t on t.topic_id = sch.topic_id
  order by sch.class_date, sch.start_time;
$$;
revoke all on function public.staff_schedule_stats(date, date, uuid[]) from public, anon, authenticated;
grant execute on function public.staff_schedule_stats(date, date, uuid[]) to service_role;
