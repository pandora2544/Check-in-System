-- ทดสอบฟังก์ชันงานประจำ (migration 20261006120000_phase1_work_fns) บนฐานข้อมูลจำลองในเครื่อง
\set ON_ERROR_STOP 1
\pset footer off
\set B '''10000000-0000-0000-0000-00000000000b'''
\set ADMIN '''00000000-0000-0000-0000-0000000000a1'''
\set SCI '''00000000-0000-0000-0000-0000000000b1'''
\set INST '''00000000-0000-0000-0000-0000000000b2'''
\set MGR '''00000000-0000-0000-0000-0000000000b3'''
\set BAK '''00000000-0000-0000-0000-0000000000b4'''
\set C1 '''20000000-0000-0000-0000-000000000001'''
\set SEM '''30000000-0000-0000-0000-000000000001'''
update users set is_scientist = true where user_id in (:SCI, :BAK);
delete from staff_assignments where kind = 'course_owner';
insert into staff_assignments (user_id,kind,course_id,semester_id) values (:SCI,'course_owner',:C1,:SEM),(:BAK,'course_backup',:C1,:SEM);
create temp table s as
  select s.schedule_id id, row_number() over (order by class_date, start_time) n from schedules s join lab_sections ls using (section_id)
  where ls.course_id = :C1 and s.status = 'scheduled' and s.class_date > current_date order by class_date, start_time limit 3;

\echo '== W1 งดคาบ: อาจารย์ (ไม่ใช่ผู้ประสาน) ทำไม่ได้ · ผู้ประสานหลักทำได้ · การจองห้องถูกยกเลิกตาม'
select session_cancel(:INST, (select id from s where n=1), 'not_needed') ->> 'result' inst;
select session_cancel(:BAK, (select id from s where n=1), 'not_needed') ->> 'result' backup_when_primary_here;
select session_cancel(:SCI, (select id from s where n=1), 'bad') ->> 'result' bad_reason;
select session_cancel(:SCI, (select id from s where n=1), 'other_held', 'สอนออนไลน์แทน') ->> 'ok' sci_ok;
select status, cancel_reason, cancel_note from schedules where schedule_id = (select id from s where n=1);
select string_agg(status, ',') resv_after_cancel from room_reservations where schedule_id = (select id from s where n=1);
select actor = :SCI actor_logged from audit_log where table_name = 'schedules' and row_id = (select id from s where n=1)::text order by audit_id desc limit 1;

\echo '== W2 คืนคาบ → ขอห้องใหม่อัตโนมัติ'
select session_restore(:SCI, (select id from s where n=1)) ->> 'has_room' restored_has_room;

\echo '== W3 เลื่อนคาบ: คาบเดิม postponed + คาบชดเชย makeup_of + บทตามไป + จองห้องให้'
insert into user_away (user_id, from_date, to_date) values (:SCI, current_date, current_date);
select (session_postpone(:BAK, (select id from s where n=2), current_date + 40, '13:00', '16:00', null, 'ห้องซ่อม')) - 'summary' - 'section_id' - 'course_id' - 'semester_id' - 'schedule_id' - 'makeup_id' backup_when_primary_away;
delete from user_away;
select status, cancel_reason, left(cancel_note, 60) note from schedules where schedule_id = (select id from s where n=2);
select kind, class_date = current_date + 40 moved, start_time, (select count(*) from session_topics t where t.schedule_id = m.schedule_id) topics,
       (select string_agg(r.kind || ':' || r.status, ',') from room_reservations r where r.schedule_id = m.schedule_id) resv
  from schedules m where makeup_of = (select id from s where n=2);
select session_postpone(:SCI, (select id from s where n=3), current_date - 1, '13:00', '16:00') ->> 'result' past;
select session_restore(:SCI, (select id from s where n=2)) ->> 'result' cannot_restore_postponed;

\echo '== W4 งาน: สร้างงานส่วนตัว/งานวิชา · คนนอกวิชาสร้างงานวิชาไม่ได้ · แก้/เสร็จ/ลบ ตามสิทธิ์'
create temp table tk as select (task_write(:MGR, 'save', null, jsonb_build_object('title','ประชุม','task_date', current_date + 1,'is_private',true)) ->> 'task_id')::uuid id;
select source, is_private, assignee_id = :MGR self_assigned from tasks where task_id = (select id from tk);
select task_write(:MGR, 'save', null, jsonb_build_object('title','เตรียมสาร','task_date', current_date + 1,'course_id',:C1,'semester_id',:SEM)) ->> 'result' outsider_course_task;
insert into tk select (task_write(:SCI, 'save', null, jsonb_build_object('title','เตรียมสาร','task_type','prep','task_date', current_date + 1,
  'course_id',:C1,'semester_id',:SEM,'assignee_id',:INST,'start_time','08:00','duration_hours',2)) ->> 'task_id')::uuid;
select source, task_type, assignee_id = :INST to_inst from tasks where task_id = (select id from tk offset 1);
select task_write(:MGR, 'status', (select id from tk offset 1), '{"status":"done"}') ->> 'result' outsider_done;
select task_write(:INST, 'status', (select id from tk offset 1), '{"status":"done","actual_hours":"2.5"}') ->> 'status' assignee_done;
select done_by = :INST, actual_hours from tasks where task_id = (select id from tk offset 1);
select task_write(:SCI, 'save', (select id from tk offset 1), jsonb_build_object('title','เตรียมสาร (แก้)','task_date', current_date + 2,'assignee_id',:BAK)) ->> 'ok' coordinator_edit;
select title, handed_over_from = :INST handed_over, assignee_id = :BAK to_bak from tasks where task_id = (select id from tk offset 1);
select task_write(:INST, 'remove', (select id from tk limit 1), '{}') ->> 'result' other_cannot_remove_private;
select task_write(:MGR, 'remove', (select id from tk limit 1), '{}') ->> 'removed' owner_remove;
select count(*) audit_rows_with_actor from audit_log where table_name = 'tasks' and actor is not null;

\echo '== W5 เปลี่ยนห้องของคาบ: ห้องว่าง → ขอห้องใหม่ (pending) · ห้องชน → conflict ไม่เปลี่ยน · คนนอกทำไม่ได้'
create temp table s5 as select s.schedule_id id, s.location_id loc, s.class_date d, s.start_time st, s.end_time en from schedules s join lab_sections ls using (section_id)
  where ls.course_id = :C1 and s.status = 'scheduled' and s.class_date > current_date + 3 order by class_date limit 1;
select session_set_room(:INST, (select id from s5), :B) ->> 'result' inst;
select (session_set_room(:SCI, (select id from s5), :B)) ->> 'has_room' moved_to_b;
select l.name, r.status from room_reservations r join locations l using (location_id) where r.schedule_id = (select id from s5) and r.status in ('pending','approved');
insert into room_reservations (location_id, kind, status, starts_at, ends_at, requested_by)
  select '10000000-0000-0000-0000-00000000000a', 'prep', 'approved', (d + st) at time zone 'Asia/Bangkok', (d + en) at time zone 'Asia/Bangkok', :ADMIN from s5;
select session_set_room(:SCI, (select id from s5), '10000000-0000-0000-0000-00000000000a') ->> 'result' to_busy_room;
select location_id = :B still_b from schedules where schedule_id = (select id from s5);
