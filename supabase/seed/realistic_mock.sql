-- ข้อมูลทดสอบแบบสมจริง (14 ต.ค. 2569) — ใช้ตรวจหน้าจอให้ใกล้การใช้งานจริง
-- ทุกแถวเป็นของทดสอบ: ห้อง f0000000-* · วิชา c0000000-* · กลุ่ม e0000000-* · นักศึกษา b0000000-* (@mock.cph-smart-checkin.test)
-- ลบทั้งชุด: supabase/seed/remove_mock_data.sql
-- ช่วงข้อมูล: 3 สัปดาห์ก่อน → 4 สัปดาห์หลังวันที่รัน · คาบ 3 ชม. สัปดาห์ละครั้งต่อกลุ่ม

-- ===================== ส่วนที่ 1: เก็บกวาด =====================
begin;
select set_config('app.actor', 'a0000000-0000-4000-8000-000000000003', true);

-- 1.1 คาบทดสอบรายชั่วโมง (CHM101L-01) → ย้ายไป "ห้องทดสอบระบบ 24 ชม." + วิชาทดสอบระบบ (ยังเช็คชื่อทดสอบได้ทุกเวลา แต่ไม่ปนห้องจริง)
insert into public.locations (location_id, name, building, floor, latitude, longitude, radius_meters, room_code, setup_minutes, teardown_minutes, note)
select 'f0000000-0000-4000-8000-000000000006', 'ห้องทดสอบระบบ (24 ชม.)', 'TEST', '0', latitude, longitude, radius_meters, 'T0-001', 0, 0, 'คาบทดสอบเช็คชื่อทุกชั่วโมง — ไม่ใช่ห้องเรียนจริง'
from public.locations where location_id = 'f0000000-0000-4000-8000-000000000001'
on conflict (location_id) do nothing;
insert into public.courses (course_id, course_code, course_name, credit) values
  ('c0000000-0000-4000-8000-000000000099', 'TEST24', 'คาบทดสอบระบบเช็คชื่อ (24 ชม.)', 0)
on conflict (course_id) do nothing;
update public.lab_sections set course_id = 'c0000000-0000-4000-8000-000000000099' where section_id = 'e0000000-0000-4000-8000-000000000001';
delete from public.tasks where schedule_id in (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000001');
delete from public.session_topics where schedule_id in (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000001');
update public.schedules set location_id = 'f0000000-0000-4000-8000-000000000006', topic_id = null where section_id = 'e0000000-0000-4000-8000-000000000001';
update public.room_reservations set course_id = 'c0000000-0000-4000-8000-000000000099', status = 'approved', decided_at = coalesce(decided_at, now())
 where section_id = 'e0000000-0000-4000-8000-000000000001';

-- 1.2 BIO101L-01 เดิมมีคาบทุกวัน → ลบแล้วสร้างใหม่รายสัปดาห์
delete from public.notification_logs where schedule_id in (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000002');
delete from public.attendance_records where schedule_id in (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000002');
update public.room_items set schedule_id = null, reuse_schedule_id = null where schedule_id in (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000002')
   or reuse_schedule_id in (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000002');
delete from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000002';

-- 1.3 การจองนอกคาบเดิม (ข้อมูลจำลองรุ่นแรก เวลาเพี้ยน) → ลบ แล้วสร้างใหม่ในส่วนที่ 5
delete from public.room_reservations where kind not in ('class', 'makeup') and requested_by::text like 'a0000000-%';
commit;

-- ===================== ส่วนที่ 2: วิชา กลุ่ม นักศึกษา =====================
begin;
select set_config('app.actor', 'a0000000-0000-4000-8000-000000000003', true);

insert into public.courses (course_id, course_code, course_name, credit, department_id) values
  ('c0000000-0000-4000-8000-000000000005', 'CHM103L', 'ปฏิบัติการเคมีวิเคราะห์ (ทดสอบ)', 1, 'dd000000-0000-4000-8000-000000000001'),
  ('c0000000-0000-4000-8000-000000000006', 'BIO103L', 'ปฏิบัติการจุลชีววิทยา (ทดสอบ)', 1, 'dd000000-0000-4000-8000-000000000002')
on conflict (course_id) do nothing;

-- กลุ่มเรียน (sec, course, no, instructor, weekday, start, end, room)
create temp table rs(sec uuid, course uuid, no text, instr uuid, wd int, st time, en time, loc uuid) on commit drop;
insert into rs values
  ('e0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', '01', 'a0000000-0000-4000-8000-000000000002', 2, '13:00', '16:00', 'f0000000-0000-4000-8000-000000000002'),
  ('e0000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-000000000001', '02', 'a0000000-0000-4000-8000-000000000001', 1, '13:00', '16:00', 'f0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000012', 'c0000000-0000-4000-8000-000000000001', '03', 'a0000000-0000-4000-8000-000000000001', 3, '09:00', '12:00', 'f0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000013', 'c0000000-0000-4000-8000-000000000005', '01', 'a0000000-0000-4000-8000-000000000001', 2, '13:00', '16:00', 'f0000000-0000-4000-8000-000000000005'),
  ('e0000000-0000-4000-8000-000000000014', 'c0000000-0000-4000-8000-000000000005', '02', 'a0000000-0000-4000-8000-000000000001', 3, '13:00', '16:00', 'f0000000-0000-4000-8000-000000000001'),
  ('e0000000-0000-4000-8000-000000000015', 'c0000000-0000-4000-8000-000000000002', '02', 'a0000000-0000-4000-8000-000000000002', 4, '13:00', '16:00', 'f0000000-0000-4000-8000-000000000002'),
  ('e0000000-0000-4000-8000-000000000016', 'c0000000-0000-4000-8000-000000000006', '01', 'a0000000-0000-4000-8000-000000000002', 5, '09:00', '12:00', 'f0000000-0000-4000-8000-000000000002'),
  ('e0000000-0000-4000-8000-000000000017', 'c0000000-0000-4000-8000-000000000006', '02', 'a0000000-0000-4000-8000-000000000002', 5, '13:00', '16:00', 'f0000000-0000-4000-8000-000000000002');

insert into public.lab_sections (section_id, course_id, semester_id, section_no, instructor_id, max_students, late_threshold_minutes, auto_absent, teach_from, teach_to)
select sec, course, 'd0000000-0000-4000-8000-000000000001', no, instr, 30, 15, true, current_date - 21, current_date + 28 from rs
on conflict (section_id) do update set teach_from = excluded.teach_from, teach_to = excluded.teach_to, auto_absent = true;

delete from public.section_slots where section_id in (select sec from rs);
insert into public.section_slots (section_id, weekday, start_time, end_time, location_id) select sec, wd, st, en, loc from rs;

-- นักศึกษาจำลอง 60 คน (ไม่ล็อกอิน — มีแถว auth เพราะ schema ผูก users กับ auth.users)
create temp table ppl on commit drop as
select ('b0000000-0000-4000-8000-0000670100' || lpad(n::text, 2, '0'))::uuid id, n,
       '670100' || lpad(n::text, 2, '0') code,
       (array['นาย','นางสาว'])[1 + n % 2] || (array['กิตติ','ชนิดา','ณัฐวุฒิ','ธิดารัตน์','ปกรณ์','พรทิพย์','ภัทร','มณีรัตน์','รัชพล','วรรณา','ศุภชัย','สิริน','อนุชา','อรทัย','เกศินี'])[1 + n % 15]
         || ' ' || (array['แก้วใส','ทองคำ','บุญมี','ศรีสวัสดิ์','วงศ์ดี','จันทร์แก้ว','สุขใจ','รักษ์ไทย','มั่นคง','พึ่งบุญ','ดวงดี','ใจงาม'])[1 + (n * 7) % 12] full_name
from generate_series(1, 60) n;
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', code || '@mock.cph-smart-checkin.test', '', now(),
       '{"provider":"email","providers":["email"],"mock":true}'::jsonb, jsonb_build_object('full_name', full_name, 'app_role', 'student'), now(), now()
from ppl on conflict (id) do nothing;
insert into public.users (user_id, email, role, full_name)
select id, code || '@mock.cph-smart-checkin.test', 'student', full_name from ppl on conflict (user_id) do nothing;
insert into public.students (student_id, student_code, year_level) select id, code, 1 from ppl on conflict (student_id) do nothing;

-- ลงทะเบียน (บางคนเรียนหลายวิชา → ใช้ทดสอบยอดนับซ้ำ)
insert into public.section_enrollments (section_id, student_id, work_group)
select e.sec::uuid, p.id, 'กลุ่ม ' || (1 + p.n % 6)
from ppl p join (values
  ('e0000000-0000-4000-8000-000000000011', 1, 24), ('e0000000-0000-4000-8000-000000000012', 25, 48),
  ('e0000000-0000-4000-8000-000000000013', 1, 12), ('e0000000-0000-4000-8000-000000000013', 49, 60),
  ('e0000000-0000-4000-8000-000000000014', 13, 36), ('e0000000-0000-4000-8000-000000000002', 37, 60),
  ('e0000000-0000-4000-8000-000000000015', 1, 20), ('e0000000-0000-4000-8000-000000000016', 21, 44),
  ('e0000000-0000-4000-8000-000000000017', 45, 60), ('e0000000-0000-4000-8000-000000000017', 5, 10)
) e(sec, a, b) on p.n between e.a and e.b
on conflict (section_id, student_id) do nothing;

-- บทปฏิบัติการวิชาใหม่ + สิ่งที่ต้องเตรียมต่อบท
insert into public.lab_topics (topic_id, course_id, seq, title_th, title_en)
select ('60000000-0000-4000-8000-0000000001' || lpad(row_number() over ()::text, 2, '0'))::uuid, c::uuid, s, th, en from (values
  ('c0000000-0000-4000-8000-000000000005', 1, 'การไทเทรตแบบรีดอกซ์', 'Redox titration'),
  ('c0000000-0000-4000-8000-000000000005', 2, 'การวิเคราะห์โดยน้ำหนัก', 'Gravimetric analysis'),
  ('c0000000-0000-4000-8000-000000000005', 3, 'สเปกโทรโฟโตเมตรี', 'Spectrophotometry'),
  ('c0000000-0000-4000-8000-000000000005', 4, 'การไทเทรตแบบสารเชิงซ้อน', 'Complexometric titration'),
  ('c0000000-0000-4000-8000-000000000006', 1, 'การเพาะเลี้ยงและแยกเชื้อบริสุทธิ์', 'Culture & isolation'),
  ('c0000000-0000-4000-8000-000000000006', 2, 'การย้อมสีพิเศษ', 'Special staining'),
  ('c0000000-0000-4000-8000-000000000006', 3, 'การทดสอบทางชีวเคมีของแบคทีเรีย', 'Biochemical tests'),
  ('c0000000-0000-4000-8000-000000000006', 4, 'จุลชีววิทยาของน้ำและอาหาร', 'Water & food microbiology')
) v(c, s, th, en)
where not exists (select 1 from public.lab_topics t where t.course_id = v.c::uuid);

insert into public.topic_task_rules (topic_id, task_type, title, offset_days, start_time, duration_hours, needs_room, default_assignee, note, sort_order)
select t.topic_id, r.tt, r.title, r.off, r.st::time, r.hrs, false,
       case r.who when 'boy' then case when c.department_id = 'dd000000-0000-4000-8000-000000000001' then 'a0000000-0000-4000-8000-000000000009'::uuid else 'a0000000-0000-4000-8000-000000000010'::uuid end
                  else 'a0000000-0000-4000-8000-000000000008'::uuid end, null, r.ord
from public.lab_topics t join public.courses c on c.course_id = t.course_id
cross join (values ('prep', 'เตรียมสาร/อุปกรณ์', -1, '13:00', 2.0, 'staff', 1), ('prep', 'จัดโต๊ะปฏิบัติการ', 0, '08:00', 1.0, 'boy', 2), ('cleanup', 'เก็บล้างอุปกรณ์', 0, null, 1.0, 'boy', 3)) r(tt, title, off, st, hrs, who, ord)
where t.course_id in ('c0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000006')
  and not exists (select 1 from public.topic_task_rules x where x.topic_id = t.topic_id);

-- งานมอบหมายของวิชาใหม่
insert into public.staff_assignments (user_id, kind, course_id, semester_id, created_by)
select u::uuid, k, c::uuid, 'd0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003' from (values
  ('a0000000-0000-4000-8000-000000000005', 'course_owner',  'c0000000-0000-4000-8000-000000000005'),
  ('a0000000-0000-4000-8000-000000000004', 'course_backup', 'c0000000-0000-4000-8000-000000000005'),
  ('a0000000-0000-4000-8000-000000000006', 'course_owner',  'c0000000-0000-4000-8000-000000000006'),
  ('a0000000-0000-4000-8000-000000000007', 'course_backup', 'c0000000-0000-4000-8000-000000000006'),
  ('a0000000-0000-4000-8000-000000000008', 'lab_staff',     'c0000000-0000-4000-8000-000000000005'),
  ('a0000000-0000-4000-8000-000000000008', 'lab_staff',     'c0000000-0000-4000-8000-000000000006'),
  ('a0000000-0000-4000-8000-000000000009', 'lab_worker',    'c0000000-0000-4000-8000-000000000005'),
  ('a0000000-0000-4000-8000-000000000010', 'lab_worker',    'c0000000-0000-4000-8000-000000000006')
) v(u, k, c) on conflict do nothing;
insert into public.course_term_settings (course_id, semester_id, request_lead_days, approve_lead_days, updated_by)
values ('c0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000001', 14, 7, 'a0000000-0000-4000-8000-000000000003'),
       ('c0000000-0000-4000-8000-000000000006', 'd0000000-0000-4000-8000-000000000001', 14, 7, 'a0000000-0000-4000-8000-000000000003')
on conflict do nothing;
commit;
