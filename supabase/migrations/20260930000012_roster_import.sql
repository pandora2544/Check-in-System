-- 012 อัปโหลดรายชื่อรายเทอม
-- ใบหน้าผูกกับนักศึกษา (students) ไม่ผูกกับเทอม → เทอมใหม่อัปโหลดรายชื่อแล้วสแกนได้เลย ไม่ต้องลงทะเบียนหน้าใหม่

alter table public.section_enrollments
  add column if not exists work_group text,                          -- กลุ่มทำงานในแล็บ (เช่น 1–7) ใช้ในใบเซ็นชื่อ/รับคืนอุปกรณ์
  add column if not exists source text not null default 'manual'
    check (source in ('manual', 'import', 'seed')),
  add column if not exists updated_at timestamptz not null default now();

-- กันสร้างซ้ำ
alter table public.semesters add constraint semesters_year_term_key unique (academic_year, term);
alter table public.lab_sections add constraint lab_sections_course_term_section_key unique (course_id, semester_id, section_no);

update public.section_enrollments set source = 'seed' where section_id::text like 'e0000000-%';

-- ใช้ตอนนำเข้า: ถ้าสร้างบัญชีไว้แล้วแต่รอบก่อนล้มกลางทาง (มี auth.users แต่ยังไม่มี public.users) ให้หา id เดิมได้
create or replace function public.auth_user_id_by_email(p_email text) returns uuid
language sql stable security definer set search_path = auth, public as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;
revoke all on function public.auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_id_by_email(text) to service_role;
