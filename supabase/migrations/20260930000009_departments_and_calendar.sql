-- 009 สาขา (departments) + ฟังก์ชันสรุปคาบสำหรับปฏิทินหน้าอาจารย์/แอดมิน
-- สาขาเป็นเจ้าของรายวิชา · บุคลากร (อาจารย์/นักวิทย์) สังกัดสาขา → เห็นแล็บทั้งสาขาในปฏิทิน
-- แก้ไข/เช็คชื่อแทน ยังจำกัดเฉพาะกลุ่มเรียนที่ตัวเองสอน (แอดมินได้ทุกกลุ่ม)

create table if not exists public.departments (
  department_id uuid primary key default gen_random_uuid(),
  code text not null unique,            -- เช่น CHEM, BIO
  name text not null,                   -- เช่น สาขาเคมี
  color text,                           -- สีประจำสาขาในปฏิทิน (#RRGGBB) ไม่บังคับ
  created_at timestamptz not null default now()
);
alter table public.departments enable row level security;
create policy "staff read departments" on public.departments for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "admin full access departments" on public.departments for all using (public.is_admin());

alter table public.courses add column if not exists department_id uuid references public.departments(department_id);
alter table public.users   add column if not exists department_id uuid references public.departments(department_id);
create index if not exists idx_courses_department on public.courses (department_id);
create index if not exists idx_users_department on public.users (department_id);
create index if not exists idx_schedules_date on public.schedules (class_date);

-- สรุปรายคาบในช่วงวันที่ (รวมยอดใน Postgres แทนดึงทุกแถวไปนับใน Edge Function)
create or replace function public.staff_schedule_stats(p_from date, p_to date, p_section_ids uuid[])
returns table (
  schedule_id uuid, section_id uuid, class_date date, start_time time, end_time time, status text,
  room text, enrolled int, present int, late int, absent int, excused int, checked_out int
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
         coalesce(att.absent, 0), coalesce(att.excused, 0), coalesce(att.checked_out, 0)
  from sch
  join locations l on l.location_id = sch.location_id
  left join enr on enr.section_id = sch.section_id
  left join att on att.schedule_id = sch.schedule_id
  order by sch.class_date, sch.start_time;
$$;
revoke all on function public.staff_schedule_stats(date, date, uuid[]) from public, anon, authenticated;
grant execute on function public.staff_schedule_stats(date, date, uuid[]) to service_role;
