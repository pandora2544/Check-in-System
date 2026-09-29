-- ============================================================
-- ข้อมูลจำลองสำหรับทดสอบ (MOCK DATA — ชื่อทั้งหมดสมมติ)
-- รันซ้ำได้ (idempotent) — ไม่ลบข้อมูลเช็คชื่อที่ทดสอบไปแล้ว
-- ลบทิ้งทั้งหมดก่อนใช้งานจริง: ดู supabase/seed/remove_mock_data.sql
-- ============================================================

-- 1) บัญชี auth (นักศึกษาไม่ล็อกอิน แต่ schema ผูก users กับ auth.users จึงต้องมีแถวนี้)
with people(id, email, full_name, role, student_code) as (values
  ('a0000000-0000-4000-8000-000000000001'::uuid, 'instructor1@mock.cph-smart-checkin.test', 'ผศ.ดร.สมศักดิ์ ใจดี (ทดสอบ)', 'instructor', null),
  ('a0000000-0000-4000-8000-000000000002'::uuid, 'instructor2@mock.cph-smart-checkin.test', 'อ.วิภาวรรณ ชื่นใจ (ทดสอบ)', 'instructor', null),
  ('a0000000-0000-4000-8000-000000000003'::uuid, 'admin@mock.cph-smart-checkin.test',       'ผู้ดูแลระบบ (ทดสอบ)',        'admin',      null),
  ('b0000000-0000-4000-8000-000066010001'::uuid, '66010001@mock.cph-smart-checkin.test', 'กมลชนก ศรีสุข',        'student', '66010001'),
  ('b0000000-0000-4000-8000-000066010002'::uuid, '66010002@mock.cph-smart-checkin.test', 'ธนากร วงศ์ใหญ่',       'student', '66010002'),
  ('b0000000-0000-4000-8000-000066010003'::uuid, '66010003@mock.cph-smart-checkin.test', 'ปิยะธิดา แก้วมณี',      'student', '66010003'),
  ('b0000000-0000-4000-8000-000066010004'::uuid, '66010004@mock.cph-smart-checkin.test', 'ณัฐพล บุญมา',          'student', '66010004'),
  ('b0000000-0000-4000-8000-000066010005'::uuid, '66010005@mock.cph-smart-checkin.test', 'สุชาดา พรหมวิเศษ',     'student', '66010005'),
  ('b0000000-0000-4000-8000-000066010006'::uuid, '66010006@mock.cph-smart-checkin.test', 'วีรภัทร ทองดี',         'student', '66010006'),
  ('b0000000-0000-4000-8000-000066010007'::uuid, '66010007@mock.cph-smart-checkin.test', 'อรอุมา จันทร์เพ็ญ',     'student', '66010007'),
  ('b0000000-0000-4000-8000-000066010008'::uuid, '66010008@mock.cph-smart-checkin.test', 'กิตติพัฒน์ สายสุวรรณ',  'student', '66010008'),
  ('b0000000-0000-4000-8000-000066010009'::uuid, '66010009@mock.cph-smart-checkin.test', 'พิมพ์ชนก ศักดิ์ดี',     'student', '66010009'),
  ('b0000000-0000-4000-8000-000066010010'::uuid, '66010010@mock.cph-smart-checkin.test', 'ภานุวัฒน์ มีสุข',       'student', '66010010'),
  ('b0000000-0000-4000-8000-000066020001'::uuid, '66020001@mock.cph-smart-checkin.test', 'ชลธิชา รุ่งเรือง',      'student', '66020001'),
  ('b0000000-0000-4000-8000-000066020002'::uuid, '66020002@mock.cph-smart-checkin.test', 'ศุภกร นาคสวัสดิ์',      'student', '66020002'),
  ('b0000000-0000-4000-8000-000066020003'::uuid, '66020003@mock.cph-smart-checkin.test', 'รัตนาภรณ์ แสงทอง',     'student', '66020003')
),
ins_auth as (
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email, '', now(),
         '{"provider":"email","providers":["email"],"mock":true}'::jsonb,
         jsonb_build_object('full_name', full_name, 'app_role', role), now(), now()
  from people
  on conflict (id) do update set raw_user_meta_data = excluded.raw_user_meta_data
  returning id
)
select count(*) from ins_auth;

insert into public.users (user_id, email, role, full_name)
select id, email, raw_user_meta_data->>'app_role', raw_user_meta_data->>'full_name'
from auth.users
where email like '%@mock.cph-smart-checkin.test'
on conflict (user_id) do nothing;

insert into public.students (student_id, student_code, year_level)
select user_id, split_part(email, '@', 1), 1 from public.users
where role = 'student' and email like '%@mock.cph-smart-checkin.test'
on conflict (student_id) do nothing;

-- 2) วิชา / เทอม / กลุ่มเรียน
insert into public.courses (course_id, course_code, course_name, credit) values
  ('c0000000-0000-4000-8000-000000000001', 'CHM101L', 'ปฏิบัติการเคมีทั่วไป (ทดสอบ)', 1),
  ('c0000000-0000-4000-8000-000000000002', 'BIO101L', 'ปฏิบัติการชีววิทยาทั่วไป (ทดสอบ)', 1)
on conflict (course_id) do nothing;

insert into public.semesters (semester_id, academic_year, term, start_date, end_date) values
  ('d0000000-0000-4000-8000-000000000001', '2569', '1', '2026-06-15', '2026-11-15')
on conflict (semester_id) do nothing;

insert into public.lab_sections (section_id, course_id, semester_id, section_no, instructor_id, max_students, late_threshold_minutes) values
  ('e0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', '01', 'a0000000-0000-4000-8000-000000000001', 40, 15),
  ('e0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001', '01', 'a0000000-0000-4000-8000-000000000002', 40, 15)
on conflict (section_id) do nothing;

insert into public.section_enrollments (section_id, student_id)
select case when s.student_code like '6601%' then 'e0000000-0000-4000-8000-000000000001'::uuid
            else 'e0000000-0000-4000-8000-000000000002'::uuid end,
       s.student_id
from public.students s
join public.users u on u.user_id = s.student_id
where u.email like '%@mock.cph-smart-checkin.test'
on conflict (section_id, student_id) do nothing;

-- 3) ห้อง (building = 'TEST' = ห้องทดสอบ ย้ายพิกัดได้ด้วยเครื่องมือทดสอบในหน้าเว็บ)
-- พิกัดเริ่มต้นเป็นค่าสมมติ — ตั้งเป็นตำแหน่งจริงผ่านหน้าเว็บ > เครื่องมือทดสอบ
insert into public.locations (location_id, name, building, floor, latitude, longitude, radius_meters) values
  ('f0000000-0000-4000-8000-000000000001', 'ห้องทดสอบ A (เคมี)',    'TEST', '1', 13.7563, 100.5018, 50),
  ('f0000000-0000-4000-8000-000000000002', 'ห้องทดสอบ B (ชีววิทยา)', 'TEST', '1', 13.7563, 100.5018, 50)
on conflict (location_id) do nothing;

-- 4) การจองห้อง (อนุมัติแล้ว) → ตารางเรียน
insert into public.room_bookings (booking_id, location_id, booking_type, section_id, requested_by, purpose,
                                  start_datetime, end_datetime, recurrence_rule, status, approved_by, approved_at) values
  ('90000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001', 'class_schedule',
   'e0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'ทดสอบระบบ — คาบละ 1 ชม. ทุกชั่วโมง',
   '2026-09-29 00:00+07', '2026-09-29 01:00+07', 'TEST: hourly, 24/7', 'approved', 'a0000000-0000-4000-8000-000000000001', now()),
  ('90000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002', 'class_schedule',
   'e0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'ทดสอบระบบ — ทุกวัน 13:00-15:00',
   '2026-09-29 13:00+07', '2026-09-29 15:00+07', 'TEST: daily 13:00-15:00', 'approved', 'a0000000-0000-4000-8000-000000000002', now())
on conflict (booking_id) do nothing;

-- กลุ่ม 1: ทุกชั่วโมง 00:00-24:00 ห้อง A (ทดสอบได้ทุกเวลา: เช็คภายใน 15 นาทีแรกของชั่วโมง = ปกติ, หลังจากนั้น = สาย)
insert into public.schedules (booking_id, section_id, location_id, class_date, start_time, end_time)
select '90000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000001',
       d::date, make_time(h, 0, 0), case when h = 23 then time '23:59:59' else make_time(h + 1, 0, 0) end
from generate_series((now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date + 30, interval '1 day') d,
     generate_series(0, 23) h
where not exists (select 1 from public.schedules x where x.booking_id = '90000000-0000-4000-8000-000000000001'
                  and x.class_date = d::date and x.start_time = make_time(h, 0, 0));

-- กลุ่ม 2: ทุกวัน 13:00-15:00 ห้อง B (อยู่พิกัดเดียวกับห้อง A = ทดสอบกรณี "ห้องใกล้กัน GPS แยกไม่ออก")
insert into public.schedules (booking_id, section_id, location_id, class_date, start_time, end_time)
select '90000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000002',
       d::date, time '13:00', time '15:00'
from generate_series((now() at time zone 'Asia/Bangkok')::date, (now() at time zone 'Asia/Bangkok')::date + 30, interval '1 day') d
where not exists (select 1 from public.schedules x where x.booking_id = '90000000-0000-4000-8000-000000000002'
                  and x.class_date = d::date);
