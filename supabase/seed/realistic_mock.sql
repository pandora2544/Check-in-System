-- ข้อมูลทดสอบแบบสมจริง (14 ต.ค. 2569) — ใช้ตรวจหน้าจอให้ใกล้การใช้งานจริง
-- ทุกแถวเป็นของทดสอบ: ห้อง f0000000-* · วิชา c0000000-* · กลุ่ม e0000000-* · นักศึกษา b0000000-* (@mock.cph-smart-checkin.test)
-- ลบทั้งชุด: supabase/seed/remove_mock_data.sql
-- ช่วงข้อมูล: 3 สัปดาห์ก่อน → 4 สัปดาห์หลังวันที่รัน · คาบ 3 ชม. สัปดาห์ละครั้งต่อกลุ่ม

-- หมายเหตุการรันจริง 14 ต.ค. 2569: ผ่าน MCP คำสั่ง DELETE ถูกบล็อก → ส่วนที่ 1 รันเฉพาะ insert/update,
-- คาบรายวันเดิมของ BIO101L-01 ถูกตั้งเป็น cancelled (note = 'mock-old-daily') และการจองเก่าตั้งเป็น cancelled (decision_note 'mock-old%')
-- แล้วค่อยลบจริงด้วย supabase/seed/realistic_mock_cleanup.sql ใน SQL Editor
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

-- ===================== ส่วนที่ 3: คาบเรียนรายสัปดาห์ (note = 'mock-weekly') =====================
begin;
select set_config('app.actor', 'a0000000-0000-4000-8000-000000000003', true);
update public.schedules set status = 'cancelled', note = 'mock-old-daily'
 where section_id = 'e0000000-0000-4000-8000-000000000002' and status = 'scheduled' and coalesce(note,'') <> 'mock-weekly';
-- การจองค้างของห้องเดิม (คาบทดสอบที่ย้ายห้องแล้ว / การจองนอกคาบรุ่นแรก) → cancelled เพื่อไม่ชนช่วงเวลา
update public.room_reservations r set status = 'cancelled', decision_note = 'mock-old (ซ้ำ)'
from public.schedules s where r.schedule_id = s.schedule_id and r.location_id <> s.location_id and s.section_id = 'e0000000-0000-4000-8000-000000000001' and r.status in ('pending','approved');
update public.room_reservations set status = 'cancelled', decision_note = 'mock-old'
 where kind not in ('class','makeup') and requested_by::text like 'a0000000-%' and status in ('pending','approved') and created_at < current_date;

insert into public.schedules (section_id, location_id, class_date, start_time, end_time, slot_id, note)
select sl.section_id, sl.location_id, d::date, sl.start_time, sl.end_time, sl.slot_id, 'mock-weekly'
from public.section_slots sl
cross join generate_series(current_date - 21, current_date + 28, interval '1 day') d
where sl.section_id in ('e0000000-0000-4000-8000-000000000002','e0000000-0000-4000-8000-000000000011','e0000000-0000-4000-8000-000000000012','e0000000-0000-4000-8000-000000000013','e0000000-0000-4000-8000-000000000014','e0000000-0000-4000-8000-000000000015','e0000000-0000-4000-8000-000000000016','e0000000-0000-4000-8000-000000000017')
  and extract(isodow from d) = sl.weekday
  and not exists (select 1 from public.term_holidays h where h.holiday_date = d::date)
  and not exists (select 1 from public.schedules x where x.section_id = sl.section_id and x.class_date = d::date and x.status = 'scheduled');

with s as (
  select sc.schedule_id, ls.course_id, row_number() over (partition by sc.section_id order by sc.class_date) rn
  from public.schedules sc join public.lab_sections ls on ls.section_id = sc.section_id
  where sc.note = 'mock-weekly' and sc.topic_id is null
), t as (
  select topic_id, course_id, row_number() over (partition by course_id order by seq) k, count(*) over (partition by course_id) n from public.lab_topics
)
update public.schedules sc set topic_id = t.topic_id from s join t on t.course_id = s.course_id and t.k = 1 + (s.rn - 1) % t.n where sc.schedule_id = s.schedule_id;
insert into public.session_topics (schedule_id, topic_id, seq, time_share)
select schedule_id, topic_id, 1, 1 from public.schedules where note = 'mock-weekly' and topic_id is not null on conflict do nothing;

update public.room_reservations r set status = 'approved', decided_by = 'a0000000-0000-4000-8000-000000000003', decided_at = now(), decision_note = 'อนุมัติตามตารางเรียน'
from public.schedules s
where r.schedule_id = s.schedule_id and s.note = 'mock-weekly' and r.status = 'pending'
  and not (s.section_id = 'e0000000-0000-4000-8000-000000000013' and s.class_date >= current_date + 14);
update public.room_reservations r set status = 'rejected', decided_by = 'a0000000-0000-4000-8000-000000000003', decided_at = now(), decision_note = 'ห้อง B ติดซ่อมบำรุงช่วงนี้ — ยังไม่มีห้องว่าง กรุณาเลือกห้องอื่น'
where r.schedule_id in (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000017' and note = 'mock-weekly' order by class_date desc limit 2);
commit;

-- ===================== ส่วนที่ 4: ผลเช็คชื่อ (คาบที่ผ่านมา ~80% มา / 10% สาย / 4% ลา / 6% ขาด; คาบที่กำลังเรียน 60% มา 12% สาย ที่เหลือยังไม่สแกน) =====================
begin;
create temp table a0 on commit drop as
select e.student_id, s.schedule_id, s.location_id, ls.instructor_id, l.latitude lat, l.longitude lng,
       (s.class_date + s.start_time) at time zone 'Asia/Bangkok' st, (s.class_date + s.end_time) at time zone 'Asia/Bangkok' en,
       abs(hashtext(e.student_id::text || s.schedule_id::text)) % 100 r,
       abs(hashtext(s.schedule_id::text || e.student_id::text)) % 100 r2
from public.schedules s
join public.lab_sections ls on ls.section_id = s.section_id
join public.section_enrollments e on e.section_id = s.section_id
join public.locations l on l.location_id = s.location_id
where s.note = 'mock-weekly' and s.status = 'scheduled' and (s.class_date + s.start_time) at time zone 'Asia/Bangkok' <= now();

insert into public.attendance_records (student_id, schedule_id, location_id, status, check_in_time, check_in_lat, check_in_lng, distance_from_location, face_match_score,
  check_out_time, check_out_lat, check_out_lng, check_out_distance, check_out_face_score, left_early, device_id, is_manual, marked_by, marked_at, note, created_at)
select student_id, schedule_id, location_id, st_, cin,
       case when dev = 'mock' then lat + (r2 % 7 - 3) * 0.00001 end, case when dev = 'mock' then lng + (r % 7 - 3) * 0.00001 end,
       case when dev = 'mock' then 1 + r2 % 8 end, case when dev = 'mock' then 0.86 + (r2 % 12) / 100.0 end,
       cout, case when cout is not null then lat end, case when cout is not null then lng end, case when cout is not null then 2 + r % 6 end,
       case when cout is not null then 0.85 + (r % 12) / 100.0 end, case when cout is not null then le end,
       dev, st_ = 'excused', case when st_ = 'excused' then instructor_id end, case when st_ = 'excused' then st - interval '1 day' end, nt, cin
from (
  select *,
    case when live then (case when r < 60 then 'present' when r < 72 then 'late' end)
         else (case when r < 80 then 'present' when r < 90 then 'late' when r < 94 then 'excused' else 'absent' end) end st_,
    case when live then (case when r < 60 then st + make_interval(mins => r2 % 15) when r < 72 then st + make_interval(mins => 16 + r2 % 25) end)
         else (case when r < 80 then st + make_interval(mins => r2 % 15) when r < 90 then st + make_interval(mins => 16 + r2 % 25) when r < 94 then st else en end) end cin,
    case when live or r >= 90 then null when r2 >= 95 then en - interval '50 minutes' else en - make_interval(mins => r2 % 10) end cout,
    (not live and r < 90 and r2 >= 95) le,
    case when not live and r >= 94 then 'auto' when not live and r >= 90 then null else 'mock' end dev,
    case when not live and r >= 94 then 'ไม่มาเรียน (ตัดขาดอัตโนมัติ)'
         when not live and r >= 90 then (array['ลาป่วย (มีใบรับรองแพทย์)','ลากิจ — ธุระครอบครัว','ไปแข่งขันกีฬาในนามมหาวิทยาลัย'])[1 + r2 % 3]
         when not live and r < 90 and r2 >= 95 then 'ขอออกก่อน — นัดพบแพทย์' end nt
  from (select *, now() < en live from a0) x
) y
where st_ is not null and cin <= now()
on conflict (student_id, schedule_id) do nothing;
commit;
-- (ถ้างานตัดขาดอัตโนมัติรันก่อน จะได้ "ขาด" ทั้งคาบ — รอบ 14 ต.ค. แก้ CHM101L-03 ของวันนั้นด้วย update สูตรเดียวกัน)

-- ===================== ส่วนที่ 5: การจองอื่น งาน ประชุม ใบลา =====================
begin;
select set_config('app.actor', 'a0000000-0000-4000-8000-000000000003', true);
create temp table rv(loc uuid, kind text, status text, d date, st time, en time, req uuid, title text, purpose text, project text, actual text) on commit drop;
insert into rv select 'f0000000-0000-4000-8000-000000000004', 'prep', 'approved', d::date, '13:00', '16:00', 'a0000000-0000-4000-8000-000000000008', 'เตรียมสารสำหรับสัปดาห์ถัดไป', 'เตรียมสารละลายมาตรฐานและอาหารเลี้ยงเชื้อ', null, null
  from generate_series(current_date - 14, current_date + 21, interval '1 day') d where extract(isodow from d) in (1, 4) and not exists (select 1 from term_holidays h where h.holiday_date = d::date);
insert into rv select 'f0000000-0000-4000-8000-000000000005', 'research', 'approved', d::date, '13:00', '17:00', 'a0000000-0000-4000-8000-000000000004', 'วิจัยคุณภาพน้ำ', 'เก็บตัวอย่างน้ำและวิเคราะห์โลหะหนัก', 'โครงการวิจัยคุณภาพน้ำ (ทดสอบ)', 'นศ.ป.โท 2 คน'
  from generate_series(current_date - 14, current_date + 21, interval '1 day') d where extract(isodow from d) in (1, 4) and not exists (select 1 from term_holidays h where h.holiday_date = d::date);
insert into rv values ('f0000000-0000-4000-8000-000000000005', 'research', 'pending', current_date, '13:00', '16:00', 'a0000000-0000-4000-8000-000000000006', 'ทดลองเพาะเชื้อเพิ่มเติม', 'ขอใช้ตู้บ่มเชื้อและตู้ชีวนิรภัย', 'โครงการวิจัยจุลินทรีย์ในอาหาร (ทดสอบ)', null);
insert into rv select 'f0000000-0000-4000-8000-000000000005', 'research', 'pending', d::date, '09:00', '12:00', 'a0000000-0000-4000-8000-000000000006', 'ทดลองเพาะเชื้อเพิ่มเติม', 'ขอใช้ตู้บ่มเชื้อและตู้ชีวนิรภัย', 'โครงการวิจัยจุลินทรีย์ในอาหาร (ทดสอบ)', null
  from generate_series(current_date + 1, current_date + 14, interval '1 day') d where extract(isodow from d) = 5 and not exists (select 1 from term_holidays h where h.holiday_date = d::date);
insert into rv select 'f0000000-0000-4000-8000-000000000001', 'prep', 'approved', d::date, '07:30', '08:30', 'a0000000-0000-4000-8000-000000000009', 'จัดโต๊ะก่อนคาบเช้า', 'จัดอุปกรณ์ CHM101L-03', null, null
  from generate_series(current_date - 14, current_date + 21, interval '1 day') d where extract(isodow from d) = 3;
insert into rv values
 ('f0000000-0000-4000-8000-000000000002', 'maintenance', 'approved', current_date + (13 - extract(isodow from current_date)::int), '09:00', '12:00', 'a0000000-0000-4000-8000-000000000007', 'ตรวจเช็กตู้ชีวนิรภัยประจำปี', 'ช่างภายนอกเข้าตรวจ', null, 'ช่างบริษัท (ทดสอบ)'),
 ('f0000000-0000-4000-8000-000000000003', 'exam', 'pending', current_date + 8, '13:00', '16:00', 'a0000000-0000-4000-8000-000000000001', 'สอบปฏิบัติ CHM102L', 'สอบปฏิบัติกลางภาค', null, null),
 ('f0000000-0000-4000-8000-000000000001', 'training', 'approved', current_date + 2, '16:00', '17:30', 'a0000000-0000-4000-8000-000000000004', 'อบรมความปลอดภัยในห้องปฏิบัติการ', 'นศ.ใหม่ ป.โท/ป.เอก', null, null);
insert into public.room_reservations (location_id, kind, status, starts_at, ends_at, requested_by, title, purpose, project_name, actual_user, decided_by, decided_at, decision_note, course_id, semester_id)
select loc, kind, status, (d + st) at time zone 'Asia/Bangkok', (d + en) at time zone 'Asia/Bangkok', req, title, purpose, project, actual,
       case when status = 'approved' then 'a0000000-0000-4000-8000-000000000003'::uuid end, case when status = 'approved' then now() end,
       case when status = 'approved' then 'อนุมัติ (ข้อมูลทดสอบ)' end,
       case when kind = 'exam' then 'c0000000-0000-4000-8000-000000000003'::uuid end, case when kind = 'exam' then 'd0000000-0000-4000-8000-000000000001'::uuid end
from rv r
where not exists (select 1 from public.room_reservations x where x.location_id = r.loc and x.status in ('pending','approved')
                  and x.block && tstzrange((r.d + r.st) at time zone 'Asia/Bangkok', (r.d + r.en) at time zone 'Asia/Bangkok'));
-- ขอย้ายห้อง: ต้องเป็นผู้ดูแลห้อง (ใช้แอดมิน)
select public.room_move_request('a0000000-0000-4000-8000-000000000003',
  (select reservation_id from public.room_reservations where kind = 'training' and status = 'approved' and location_id = 'f0000000-0000-4000-8000-000000000001' and starts_at >= now() order by starts_at limit 1),
  'ห้อง A ต้องใช้สอนชดเชย CHM101L — ขอให้ย้ายอบรมไปห้อง E ได้ไหมครับ', false, '{"location_id":"f0000000-0000-4000-8000-000000000005"}'::jsonb);
select public.generate_rule_tasks(array(select schedule_id from public.schedules where note = 'mock-weekly' and status = 'scheduled' and class_date between current_date - 3 and current_date + 14), 'a0000000-0000-4000-8000-000000000003');
update public.tasks t set status = 'done', done_by = t.assignee_id, done_at = ((t.task_date + coalesce(t.start_time, '15:00')) at time zone 'Asia/Bangkok') + interval '1 hour', actual_hours = t.duration_hours
from public.schedules s where t.schedule_id = s.schedule_id and s.note = 'mock-weekly' and t.status = 'todo' and t.task_date < current_date;
-- เหลือ 1 งานค้าง (เลยกำหนด) ไว้ทดสอบ
update public.tasks set status = 'todo', done_by = null, done_at = null, actual_hours = null
 where task_id = (select t.task_id from public.tasks t join public.schedules s using(schedule_id) where s.note = 'mock-weekly' and t.status = 'done' and t.task_type = 'cleanup' order by t.task_date desc limit 1);
insert into public.tasks (source, task_type, title, assignee_id, task_date, start_time, duration_hours, status, place, note, created_by)
values ('general', 'meeting', 'ประชุมวางแผนการสอนปฏิบัติการ', 'a0000000-0000-4000-8000-000000000004', current_date + 1, '10:00', 1.5, 'todo', 'ห้องประชุม 1 ชั้น 2', 'ข้อมูลทดสอบ', 'a0000000-0000-4000-8000-000000000003'),
       ('general', 'meeting', 'ประชุมความปลอดภัยห้องปฏิบัติการ', 'a0000000-0000-4000-8000-000000000008', current_date + 6, '13:30', 1.0, 'todo', 'ห้อง T2-202', 'ข้อมูลทดสอบ', 'a0000000-0000-4000-8000-000000000003'),
       ('general', 'meeting', 'ประชุมสรุปผลการเรียนกลางภาค', 'a0000000-0000-4000-8000-000000000006', current_date - 2, '15:00', 1.0, 'done', 'Zoom', 'ข้อมูลทดสอบ', 'a0000000-0000-4000-8000-000000000003');
insert into public.leave_requests (schedule_id, student_id, submitted_via, requested_by, reason, status)
select s.schedule_id, p.id, 'student', p.id, p.reason, 'pending'
from (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000002' and note = 'mock-weekly' and class_date > current_date order by class_date limit 1) s
cross join (values ('b0000000-0000-4000-8000-000067010037'::uuid, 'ป่วยเป็นไข้หวัดใหญ่ แนบใบรับรองแพทย์ภายหลัง'), ('b0000000-0000-4000-8000-000067010042'::uuid, 'ไปแข่งขันกีฬามหาวิทยาลัย')) p(id, reason)
where not exists (select 1 from public.leave_requests l where l.schedule_id = s.schedule_id and l.student_id = p.id);
commit;
