-- ข้อมูลจำลองเพิ่มเติม (รันหลัง mock_data.sql): สาขา + วิชาแล็บเพิ่ม 2 วิชา ให้ปฏิทินมีหลายวิชา/หลายสาขา
-- สาขาเคมี: CHM101L (ทุกชั่วโมง), CHM102L (อ./พฤ. 09:00–12:00) — instructor1
-- สาขาชีววิทยา: BIO101L (ทุกวัน 13:00–15:00), BIO102L (จ./พ. 09:00–11:00) — instructor2
-- แอดมินไม่สังกัดสาขา = เห็นทุกสาขา

insert into public.departments (department_id, code, name, color) values
  ('dd000000-0000-4000-8000-000000000001', 'CHEM', 'สาขาเคมี', '#3C6E58'),
  ('dd000000-0000-4000-8000-000000000002', 'BIO',  'สาขาชีววิทยา', '#8A5A1F')
on conflict (department_id) do nothing;

insert into public.courses (course_id, course_code, course_name, credit) values
  ('c0000000-0000-4000-8000-000000000003', 'CHM102L', 'ปฏิบัติการเคมีอินทรีย์ (ทดสอบ)', 1),
  ('c0000000-0000-4000-8000-000000000004', 'BIO102L', 'ปฏิบัติการจุลชีววิทยา (ทดสอบ)', 1)
on conflict (course_id) do nothing;

update public.courses set department_id = 'dd000000-0000-4000-8000-000000000001' where course_id in ('c0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000003');
update public.courses set department_id = 'dd000000-0000-4000-8000-000000000002' where course_id in ('c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000004');
update public.users set department_id = 'dd000000-0000-4000-8000-000000000001' where user_id = 'a0000000-0000-4000-8000-000000000001';
update public.users set department_id = 'dd000000-0000-4000-8000-000000000002' where user_id = 'a0000000-0000-4000-8000-000000000002';

insert into public.lab_sections (section_id, course_id, semester_id, section_no, instructor_id, max_students, late_threshold_minutes, auto_absent) values
  ('e0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001', '01', 'a0000000-0000-4000-8000-000000000001', 40, 15, false),
  ('e0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000001', '01', 'a0000000-0000-4000-8000-000000000002', 40, 15, false)
on conflict (section_id) do nothing;

-- CHM102L: นักศึกษา 66010001–66010005 · BIO102L: 66020001–66020003
insert into public.section_enrollments (section_id, student_id)
select case when s.student_code like '6601%' then 'e0000000-0000-4000-8000-000000000003'::uuid else 'e0000000-0000-4000-8000-000000000004'::uuid end, s.student_id
from public.students s
where s.student_code between '66010001' and '66010005' or s.student_code like '6602%'
on conflict (section_id, student_id) do nothing;

-- ห้อง C ใช้พิกัดเดียวกับห้อง A — แยกห้องเพื่อไม่ให้ชนกับ CHM101L (คาบทดสอบทุกชั่วโมงในห้อง A) เมื่อเปิดกฎห้ามจองห้องซ้อน (migration 014)
insert into public.locations (location_id, name, building, floor, latitude, longitude, radius_meters)
select 'f0000000-0000-4000-8000-000000000003', 'ห้องทดสอบ C (เคมีอินทรีย์)', building, floor, latitude, longitude, radius_meters
from public.locations where location_id = 'f0000000-0000-4000-8000-000000000001'
on conflict (location_id) do nothing;

insert into public.room_bookings (booking_id, location_id, booking_type, section_id, requested_by, purpose,
                                  start_datetime, end_datetime, recurrence_rule, status, approved_by, approved_at) values
  ('90000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000003', 'class_schedule',
   'e0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'ทดสอบระบบ — อ./พฤ. 09:00-12:00',
   '2026-09-29 09:00+07', '2026-09-29 12:00+07', 'TEST: weekly Tue,Thu', 'approved', 'a0000000-0000-4000-8000-000000000001', now()),
  ('90000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000002', 'class_schedule',
   'e0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000002', 'ทดสอบระบบ — จ./พ. 09:00-11:00',
   '2026-09-28 09:00+07', '2026-09-28 11:00+07', 'TEST: weekly Mon,Wed', 'approved', 'a0000000-0000-4000-8000-000000000002', now())
on conflict (booking_id) do nothing;

-- ย้อนหลังตั้งแต่ต้นเดือน ก.ย. เพื่อให้ปฏิทินมีคาบในอดีตด้วย (ไม่มีข้อมูลเช็คชื่อ)
insert into public.schedules (booking_id, section_id, location_id, class_date, start_time, end_time)
select '90000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000003', d::date, time '09:00', time '12:00'
from generate_series(date '2026-09-01', date '2026-10-30', interval '1 day') d
where extract(isodow from d) in (2, 4)
  and not exists (select 1 from public.schedules x where x.booking_id = '90000000-0000-4000-8000-000000000003' and x.class_date = d::date);

insert into public.schedules (booking_id, section_id, location_id, class_date, start_time, end_time)
select '90000000-0000-4000-8000-000000000004', 'e0000000-0000-4000-8000-000000000004', 'f0000000-0000-4000-8000-000000000002', d::date, time '09:00', time '11:00'
from generate_series(date '2026-09-01', date '2026-10-30', interval '1 day') d
where extract(isodow from d) in (1, 3)
  and not exists (select 1 from public.schedules x where x.booking_id = '90000000-0000-4000-8000-000000000004' and x.class_date = d::date);
