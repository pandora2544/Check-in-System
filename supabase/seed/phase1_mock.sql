-- ข้อมูลจำลองระยะ 1 (6 ต.ค. 2569) — ทุกบัญชี/รายการเป็นของทดสอบ (อีเมล @mock.cph-smart-checkin.test)
-- บทบาท: นักวิทย์ = ผู้ประสานรายวิชา/ดูแลห้อง · อาจารย์ = สอน (อนุมัติคำขอลา) · เจ้าหน้าที่ = เตรียมแล็บ · แล็บบอย = จัดแล็บ จัดของ
-- รหัสผ่านบัญชีใหม่ทั้งหมด: Mock@2569
begin;
select set_config('app.actor', 'a0000000-0000-4000-8000-000000000003', true);   -- ผู้ทำ = แอดมินทดสอบ (บันทึกการแก้ไข)

-- ---------- บัญชีบุคลากรใหม่ ----------
with p(id, email, name, sci, dept, phone, line) as (values
  ('a0000000-0000-4000-8000-000000000004'::uuid, 'scientist.chem1@mock.cph-smart-checkin.test', 'นายธนพล วิทยาการ (นักวิทย์เคมี · ทดสอบ)', true,  'dd000000-0000-4000-8000-000000000001'::uuid, '081-000-0004', 'thanapol.lab'),
  ('a0000000-0000-4000-8000-000000000005', 'scientist.chem2@mock.cph-smart-checkin.test', 'น.ส.กมลวรรณ สารเคมี (นักวิทย์เคมี · ทดสอบ)', true,  'dd000000-0000-4000-8000-000000000001', '081-000-0005', 'kamonwan.chem'),
  ('a0000000-0000-4000-8000-000000000006', 'scientist.bio1@mock.cph-smart-checkin.test',  'นายภูมิ ชีวภาพ (นักวิทย์ชีวะ · ทดสอบ)',      true,  'dd000000-0000-4000-8000-000000000002', '081-000-0006', 'phum.bio'),
  ('a0000000-0000-4000-8000-000000000007', 'scientist.bio2@mock.cph-smart-checkin.test',  'น.ส.ปิยะดา จุลชีพ (นักวิทย์ชีวะ · ทดสอบ)',   true,  'dd000000-0000-4000-8000-000000000002', '081-000-0007', 'piyada.micro'),
  ('a0000000-0000-4000-8000-000000000008', 'labstaff1@mock.cph-smart-checkin.test',       'นางสุดา เตรียมการ (เจ้าหน้าที่ · ทดสอบ)',     false, null, '081-000-0008', null),
  ('a0000000-0000-4000-8000-000000000009', 'labboy1@mock.cph-smart-checkin.test',         'นายสมชาย จัดแล็บ (แล็บบอย · ทดสอบ)',        false, 'dd000000-0000-4000-8000-000000000001', '081-000-0009', null),
  ('a0000000-0000-4000-8000-000000000010', 'labboy2@mock.cph-smart-checkin.test',         'นายวิชัย จัดของ (แล็บบอย · ทดสอบ)',          false, 'dd000000-0000-4000-8000-000000000002', '081-000-0010', null)
), au as (
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email,
         extensions.crypt('Mock@2569', extensions.gen_salt('bf')), now(),
         jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'mock', true),
         jsonb_build_object('full_name', name, 'app_role', 'instructor'), now(), now(), '', '', '', '', '', '', '', ''
  from p on conflict (id) do nothing returning id
), ai as (
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  select p.id::text, p.id, jsonb_build_object('sub', p.id::text, 'email', p.email, 'email_verified', true), 'email', now(), now(), now()
  from p where p.id in (select id from au) returning 1
)
insert into public.users (user_id, email, role, full_name, phone, department_id, is_scientist, line_id)
select id, email, 'instructor', name, phone, dept, sci, line from p
on conflict (user_id) do nothing;

-- ---------- อาคาร/โซน/ห้อง ----------
insert into public.zones (zone_id, building, floor, name, sort_order) values
  ('70000000-0000-4000-8000-000000000001', 'อาคารทดสอบ', '1', 'โซน 1 — ปฏิบัติการเคมี', 1),
  ('70000000-0000-4000-8000-000000000002', 'อาคารทดสอบ', '1', 'โซน 2 — ปฏิบัติการชีววิทยา', 2),
  ('70000000-0000-4000-8000-000000000003', 'อาคารทดสอบ', '2', 'โซน 3 — ห้องเตรียม/เครื่องมือ', 3)
on conflict do nothing;
update public.locations set zone_id = '70000000-0000-4000-8000-000000000001', room_code = 'T1-101', setup_minutes = 0, note = 'ทดสอบ: ใช้ทุกชั่วโมง (คาบจำลอง CHM101L)' where location_id = 'f0000000-0000-4000-8000-000000000001';
update public.locations set zone_id = '70000000-0000-4000-8000-000000000002', room_code = 'T1-102', setup_minutes = 15 where location_id = 'f0000000-0000-4000-8000-000000000002';
update public.locations set zone_id = '70000000-0000-4000-8000-000000000001', room_code = 'T1-103', setup_minutes = 30, teardown_minutes = 15 where location_id = 'f0000000-0000-4000-8000-000000000003';
insert into public.locations (location_id, name, building, floor, latitude, longitude, radius_meters, zone_id, room_code, setup_minutes)
select v.id, v.name, 'อาคารทดสอบ', '2', l.latitude, l.longitude, l.radius_meters, '70000000-0000-4000-8000-000000000003', v.code, 0
from public.locations l, (values
  ('f0000000-0000-4000-8000-000000000004'::uuid, 'ห้องเตรียมสารทดสอบ D', 'T2-201'),
  ('f0000000-0000-4000-8000-000000000005'::uuid, 'ห้องเครื่องมือทดสอบ E', 'T2-202')) v(id, name, code)
where l.location_id = 'f0000000-0000-4000-8000-000000000001'
on conflict (location_id) do nothing;

-- ---------- งานมอบหมาย ----------
insert into public.staff_assignments (user_id, kind, course_id, semester_id, created_by)
select u, k, c, 'd0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003' from (values
  -- ผู้ประสานหลัก/รอง (นักวิทย์)
  ('a0000000-0000-4000-8000-000000000004'::uuid, 'course_owner',  'c0000000-0000-4000-8000-000000000001'::uuid),
  ('a0000000-0000-4000-8000-000000000005', 'course_backup', 'c0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000005', 'course_owner',  'c0000000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000004', 'course_backup', 'c0000000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000006', 'course_owner',  'c0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000007', 'course_backup', 'c0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000007', 'course_owner',  'c0000000-0000-4000-8000-000000000004'),
  ('a0000000-0000-4000-8000-000000000006', 'course_backup', 'c0000000-0000-4000-8000-000000000004'),
  -- เจ้าหน้าที่เตรียมแล็บ (ทุกวิชา) + แล็บบอยตามสาขา
  ('a0000000-0000-4000-8000-000000000008', 'lab_staff', 'c0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000008', 'lab_staff', 'c0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000008', 'lab_staff', 'c0000000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000008', 'lab_staff', 'c0000000-0000-4000-8000-000000000004'),
  ('a0000000-0000-4000-8000-000000000009', 'lab_worker', 'c0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000009', 'lab_worker', 'c0000000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000010', 'lab_worker', 'c0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000010', 'lab_worker', 'c0000000-0000-4000-8000-000000000004')
) v(u, k, c)
on conflict do nothing;

-- ผู้ดูแลห้อง หลัก/สำรอง (นักวิทย์)
insert into public.staff_assignments (user_id, kind, location_id, created_by)
select u, k, l, 'a0000000-0000-4000-8000-000000000003' from (values
  ('a0000000-0000-4000-8000-000000000004'::uuid, 'room_manager', 'f0000000-0000-4000-8000-000000000001'::uuid),
  ('a0000000-0000-4000-8000-000000000005', 'room_backup',  'f0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000006', 'room_manager', 'f0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000007', 'room_backup',  'f0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000005', 'room_manager', 'f0000000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000004', 'room_backup',  'f0000000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000007', 'room_manager', 'f0000000-0000-4000-8000-000000000004'),
  ('a0000000-0000-4000-8000-000000000006', 'room_backup',  'f0000000-0000-4000-8000-000000000004'),
  ('a0000000-0000-4000-8000-000000000006', 'room_manager', 'f0000000-0000-4000-8000-000000000005'),
  ('a0000000-0000-4000-8000-000000000004', 'room_backup',  'f0000000-0000-4000-8000-000000000005')
) v(u, k, l)
on conflict do nothing;

-- ผู้ดูแลไม่อยู่: นักวิทย์เคมี 1 ไม่อยู่วันจันทร์หน้า (ผู้สำรองอนุมัติแทน) · ทั้งคู่ไม่อยู่วันที่ 20 (ติดต่อด่วน)
insert into public.user_away (user_id, from_date, to_date, note) values
  ('a0000000-0000-4000-8000-000000000004', '2026-10-12', '2026-10-12', 'ไปประชุมนอกสถานที่ (ทดสอบ)'),
  ('a0000000-0000-4000-8000-000000000006', '2026-10-20', '2026-10-20', 'ลากิจ (ทดสอบ)'),
  ('a0000000-0000-4000-8000-000000000007', '2026-10-20', '2026-10-20', 'อบรม (ทดสอบ)');

-- ---------- ค่ากำหนดการจองต่อวิชา + วันหยุด ----------
insert into public.course_term_settings (course_id, semester_id, request_lead_days, approve_lead_days, updated_by)
select course_id, 'd0000000-0000-4000-8000-000000000001', 14, 7, 'a0000000-0000-4000-8000-000000000003' from public.courses
on conflict do nothing;
insert into public.term_holidays (semester_id, holiday_date, name) values
  ('d0000000-0000-4000-8000-000000000001', '2026-10-13', 'วันนวมินทรมหาราช'),
  ('d0000000-0000-4000-8000-000000000001', '2026-10-23', 'วันปิยมหาราช')
on conflict do nothing;

-- ---------- บทปฏิบัติการ ----------
insert into public.lab_topics (topic_id, course_id, seq, title_th, title_en, setup_minutes)
select ('60000000-0000-4000-8000-' || lpad((row_number() over ())::text, 12, '0'))::uuid, c, s, th, en, sm from (values
  ('c0000000-0000-4000-8000-000000000001'::uuid, 1, 'ความปลอดภัยในห้องปฏิบัติการและเครื่องแก้ว', 'Lab safety & glassware', null::int),
  ('c0000000-0000-4000-8000-000000000001', 2, 'การชั่งและการวัดปริมาตร', 'Weighing & volumetric measurement', null),
  ('c0000000-0000-4000-8000-000000000001', 3, 'การเตรียมสารละลาย', 'Solution preparation', 15),
  ('c0000000-0000-4000-8000-000000000001', 4, 'การไทเทรตกรด-เบส', 'Acid-base titration', 15),
  ('c0000000-0000-4000-8000-000000000001', 5, 'อัตราการเกิดปฏิกิริยา', 'Reaction rate', null),
  ('c0000000-0000-4000-8000-000000000001', 6, 'สมดุลเคมี', 'Chemical equilibrium', null),
  ('c0000000-0000-4000-8000-000000000003', 1, 'การกลั่นแบบธรรมดาและลำดับส่วน', 'Distillation', 30),
  ('c0000000-0000-4000-8000-000000000003', 2, 'การสกัดด้วยตัวทำละลาย', 'Solvent extraction', 30),
  ('c0000000-0000-4000-8000-000000000003', 3, 'การตกผลึกใหม่', 'Recrystallization', null),
  ('c0000000-0000-4000-8000-000000000003', 4, 'โครมาโทกราฟีแบบชั้นบาง', 'Thin-layer chromatography', null),
  ('c0000000-0000-4000-8000-000000000002', 1, 'การใช้กล้องจุลทรรศน์', 'Microscopy', null),
  ('c0000000-0000-4000-8000-000000000002', 2, 'เซลล์พืชและเซลล์สัตว์', 'Plant & animal cells', null),
  ('c0000000-0000-4000-8000-000000000002', 3, 'การแบ่งเซลล์', 'Cell division', null),
  ('c0000000-0000-4000-8000-000000000002', 4, 'การสกัด DNA', 'DNA extraction', 15),
  ('c0000000-0000-4000-8000-000000000004', 1, 'เทคนิคปลอดเชื้อและการเตรียมอาหารเลี้ยงเชื้อ', 'Aseptic technique & media', 30),
  ('c0000000-0000-4000-8000-000000000004', 2, 'การย้อมสีแกรม', 'Gram staining', null),
  ('c0000000-0000-4000-8000-000000000004', 3, 'การนับจำนวนจุลินทรีย์', 'Microbial enumeration', null),
  ('c0000000-0000-4000-8000-000000000004', 4, 'การทดสอบความไวต่อยาปฏิชีวนะ', 'Antibiotic susceptibility', null)
) v(c, s, th, en, sm)
where not exists (select 1 from public.lab_topics t where t.course_id = v.c);

-- บทรายคาบ: แต่ละ Section วนบทตามสัปดาห์ (สัปดาห์ที่ n → บทที่ n mod จำนวนบท)
with sch as (
  select s.schedule_id, ls.course_id,
         dense_rank() over (partition by s.section_id order by date_trunc('week', s.class_date)) - 1 wk
  from public.schedules s join public.lab_sections ls on ls.section_id = s.section_id
  where s.status = 'scheduled'
), nt as (select course_id, count(*) n from public.lab_topics group by course_id)
update public.schedules s set topic_id = t.topic_id
from sch join nt on nt.course_id = sch.course_id
join public.lab_topics t on t.course_id = sch.course_id and t.seq = (sch.wk % nt.n) + 1
where s.schedule_id = sch.schedule_id and s.topic_id is null;

-- รวมแล็บตัวอย่าง: CHM102L คาบแรกที่ยังไม่ถึง เรียน 2 บท
insert into public.session_topics (schedule_id, topic_id, seq)
select s.schedule_id, t.topic_id, 2 from public.schedules s
join public.lab_topics t on t.course_id = 'c0000000-0000-4000-8000-000000000003' and t.seq = (
  select (st.seq % 4) + 1 from public.session_topics x join public.lab_topics st on st.topic_id = x.topic_id where x.schedule_id = s.schedule_id limit 1)
where s.schedule_id = (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000003' and class_date >= current_date and status = 'scheduled' order by class_date limit 1)
on conflict do nothing;

-- ---------- สิ่งที่ต้องเตรียมต่อบท (นักวิทย์ตั้ง) ----------
insert into public.topic_task_rules (topic_id, task_type, title, offset_days, start_time, duration_hours, needs_room, default_assignee, note, sort_order, created_by)
select t.topic_id, r.task_type, r.title, r.off, r.st::time, r.hrs, r.room,
       case r.who when 'boy' then case when c.department_id = 'dd000000-0000-4000-8000-000000000001' then 'a0000000-0000-4000-8000-000000000009'::uuid else 'a0000000-0000-4000-8000-000000000010'::uuid end
                  when 'staff' then 'a0000000-0000-4000-8000-000000000008'::uuid end,
       r.note, r.ord,
       (select a.user_id from public.staff_assignments a where a.kind = 'course_owner' and a.course_id = t.course_id limit 1)
from public.lab_topics t join public.courses c on c.course_id = t.course_id
cross join (values
  ('prep', 'เตรียมสาร/อุปกรณ์', -1, '13:00', 2.0, false, 'staff', 'ตามใบงานของบท', 1),
  ('prep', 'จัดโต๊ะปฏิบัติการ', 0, '08:00', 1.0, false, 'boy', 'จัดอุปกรณ์ตามกลุ่ม', 2),
  ('cleanup', 'เก็บล้างอุปกรณ์', 0, null, 1.0, false, 'boy', null, 3)
) r(task_type, title, off, st, hrs, room, who, note, ord)
where not exists (select 1 from public.topic_task_rules x where x.topic_id = t.topic_id);
-- บทชีวะที่ต้องอ่านผลวันถัดไป
insert into public.topic_task_rules (topic_id, task_type, title, offset_days, start_time, duration_hours, default_assignee, note, sort_order)
select topic_id, 'reading', 'อ่านผลเพาะเชื้อ', 1, '09:00', 1.0, 'a0000000-0000-4000-8000-000000000010', 'บ่ม 24 ชม.', 4
from public.lab_topics where course_id = 'c0000000-0000-4000-8000-000000000004' and seq in (1, 3, 4)
and not exists (select 1 from public.topic_task_rules x where x.topic_id = lab_topics.topic_id and x.task_type = 'reading');

-- สร้างงานให้คาบ 2 สัปดาห์ข้างหน้า (CHM101L คาบจำลองรายชั่วโมง → เฉพาะคาบ 09:00 และ 13:00)
select public.generate_rule_tasks(array(
  select s.schedule_id from public.schedules s
  where s.status = 'scheduled' and s.class_date between current_date and current_date + 14
    and (s.section_id <> 'e0000000-0000-4000-8000-000000000001' or s.start_time in ('09:00', '13:00'))
), 'a0000000-0000-4000-8000-000000000003');

-- งานทั่วไป/ส่วนตัว
insert into public.tasks (source, task_type, title, assignee_id, task_date, start_time, duration_hours, is_private, created_by, note) values
  ('general', 'other', 'ตรวจนับสารเคมีประจำเดือน', 'a0000000-0000-4000-8000-000000000008', current_date + 3, '13:00', 3, false, 'a0000000-0000-4000-8000-000000000004', 'ห้องเตรียมสาร D'),
  ('general', 'other', 'ประชุมทีมห้องปฏิบัติการ', 'a0000000-0000-4000-8000-000000000004', current_date + 2, '15:30', 1, false, 'a0000000-0000-4000-8000-000000000004', null),
  ('personal', 'other', 'นัดทันตแพทย์', 'a0000000-0000-4000-8000-000000000005', current_date + 4, '10:00', 2, true, 'a0000000-0000-4000-8000-000000000005', null);

-- วันลาเจ้าหน้าที่ → งานช่วงนั้นต้องหาคนแทน
insert into public.staff_leaves (user_id, from_date, to_date, note) values
  ('a0000000-0000-4000-8000-000000000009', current_date + 7, current_date + 8, 'ลาพักร้อน (ทดสอบ)');

-- ---------- การจองนอกคาบ (ผ่านฟังก์ชันจริง — กันชนในฐานข้อมูล) ----------
select public.booking_request(jsonb_build_object('location_id', 'f0000000-0000-4000-8000-000000000004', 'requested_by', 'a0000000-0000-4000-8000-000000000008',
  'kind', 'prep', 'course_id', 'c0000000-0000-4000-8000-000000000001', 'semester_id', 'd0000000-0000-4000-8000-000000000001', 'title', 'เตรียมสารละลายสัปดาห์หน้า',
  'items', jsonb_build_array(jsonb_build_object('starts_at', ((current_date + 1) + time '13:00') at time zone 'Asia/Bangkok', 'ends_at', ((current_date + 1) + time '16:00') at time zone 'Asia/Bangkok'))));
select public.booking_request(jsonb_build_object('location_id', 'f0000000-0000-4000-8000-000000000005', 'requested_by', 'a0000000-0000-4000-8000-000000000001',
  'kind', 'research', 'project_name', 'โครงการวิจัยคุณภาพน้ำ (ทดสอบ)', 'title', 'วิเคราะห์ตัวอย่างน้ำ', 'actual_user', 'นศ.ป.โท นายเอ บี',
  'series', jsonb_build_object('title', 'วิจัยทุกพุธ', 'pattern', jsonb_build_object('type', 'weekly', 'weekdays', jsonb_build_array(3))),
  'items', (select jsonb_agg(jsonb_build_object('starts_at', (d + time '13:00') at time zone 'Asia/Bangkok', 'ends_at', (d + time '17:00') at time zone 'Asia/Bangkok'))
            from generate_series(current_date + ((3 - extract(isodow from current_date)::int + 7) % 7), current_date + 27, interval '7 day') g(d))));
select public.booking_request(jsonb_build_object('location_id', 'f0000000-0000-4000-8000-000000000002', 'requested_by', 'a0000000-0000-4000-8000-000000000007',
  'kind', 'maintenance', 'title', 'พ่นยาฆ่าเชื้อห้อง', 'semester_id', 'd0000000-0000-4000-8000-000000000001',
  'items', jsonb_build_array(jsonb_build_object('starts_at', ((current_date + 5) + time '16:00') at time zone 'Asia/Bangkok', 'ends_at', ((current_date + 5) + time '18:00') at time zone 'Asia/Bangkok', 'approve', true))));
select public.booking_request(jsonb_build_object('location_id', 'f0000000-0000-4000-8000-000000000003', 'requested_by', 'a0000000-0000-4000-8000-000000000002',
  'kind', 'exam', 'course_id', 'c0000000-0000-4000-8000-000000000003', 'semester_id', 'd0000000-0000-4000-8000-000000000001', 'title', 'สอบปฏิบัติ CHM102L',
  'items', jsonb_build_array(jsonb_build_object('starts_at', ((current_date + 9) + time '13:00') at time zone 'Asia/Bangkok', 'ends_at', ((current_date + 9) + time '16:00') at time zone 'Asia/Bangkok'))));
select public.booking_request(jsonb_build_object('location_id', 'f0000000-0000-4000-8000-000000000002', 'requested_by', 'a0000000-0000-4000-8000-000000000001',
  'kind', 'training', 'title', 'อบรมการใช้ตู้ชีวนิรภัย', 'project_name', 'อบรมบุคลากร (ทดสอบ)',
  'items', jsonb_build_array(jsonb_build_object('starts_at', ((current_date + 3) + time '15:30') at time zone 'Asia/Bangkok', 'ends_at', ((current_date + 3) + time '17:00') at time zone 'Asia/Bangkok', 'approve', true))));

-- เจ้าของห้องขอให้ย้าย (ไม่บังคับ — รอผู้ขอใช้ตอบ)
select public.room_move_request('a0000000-0000-4000-8000-000000000006',
  (select reservation_id from public.room_reservations where title = 'อบรมการใช้ตู้ชีวนิรภัย' limit 1),
  'ต้องใช้ห้องฆ่าเชื้อหลังรั่วไหลเล็กน้อย ขอเลื่อนเป็นวันถัดไปได้ไหมครับ', true,
  jsonb_build_object('location_id', 'f0000000-0000-4000-8000-000000000002',
    'starts_at', ((current_date + 4) + time '15:30') at time zone 'Asia/Bangkok', 'ends_at', ((current_date + 4) + time '17:00') at time zone 'Asia/Bangkok'));

-- ---------- ของค้างห้อง ----------
insert into public.room_items (location_id, description, position, course_id, reuse_at, movable, contact_user_id, contact_note, created_by) values
  ('f0000000-0000-4000-8000-000000000002', 'จานเพาะเชื้อ 24 จาน (บ่มอยู่)', 'ตู้บ่มมุมขวา', 'c0000000-0000-4000-8000-000000000004',
   ((current_date + 1) + time '09:00') at time zone 'Asia/Bangkok', 'no', 'a0000000-0000-4000-8000-000000000007', 'ห้ามเปิดตู้บ่ม', 'a0000000-0000-4000-8000-000000000010'),
  ('f0000000-0000-4000-8000-000000000003', 'ชุดกลั่น 6 ชุด ประกอบค้างไว้', 'โต๊ะแถวหลัง', 'c0000000-0000-4000-8000-000000000003',
   ((current_date + 2) + time '09:00') at time zone 'Asia/Bangkok', 'temporary', 'a0000000-0000-4000-8000-000000000009', 'ย้ายชิดผนังได้', 'a0000000-0000-4000-8000-000000000009');

-- ---------- นักศึกษา: รอยืนยันตัวตน + คำขอลา ----------
update public.students set identity_status = 'pending' where student_id = (select student_id from public.students order by student_code desc limit 1);
insert into public.leave_requests (schedule_id, student_id, submitted_via, requested_by, reason)
select s.schedule_id, e.student_id, 'student', e.student_id, x.reason
from (select row_number() over (order by e.student_id) rn, e.* from public.section_enrollments e where e.section_id = 'e0000000-0000-4000-8000-000000000002') e
join lateral (select schedule_id from public.schedules where section_id = e.section_id and class_date > current_date and status = 'scheduled' order by class_date limit 1) s on true
join (values (1, 'ป่วย มีไข้ (ทดสอบ)'), (2, 'ติดสอบย่อยวิชาอื่น (ทดสอบ)')) x(rn, reason) on x.rn = e.rn
on conflict do nothing;

-- ปฏิทินของฉัน: นักวิทย์เคมี 1 เลือกดูของผู้สำรอง + ห้อง C
update public.users set calendar_settings = jsonb_build_object('show', 'selected', 'people', jsonb_build_array('a0000000-0000-4000-8000-000000000005'),
  'rooms', jsonb_build_array('f0000000-0000-4000-8000-000000000003'), 'layers', jsonb_build_array('sessions', 'tasks', 'bookings', 'holidays', 'leaves'))
where user_id = 'a0000000-0000-4000-8000-000000000004';

commit;
