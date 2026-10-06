\set ON_ERROR_STOP 1
\set A '''10000000-0000-0000-0000-00000000000a'''
\set B '''10000000-0000-0000-0000-00000000000b'''
\set ADMIN '''00000000-0000-0000-0000-0000000000a1'''
\set SCI '''00000000-0000-0000-0000-0000000000b1'''
\set INST '''00000000-0000-0000-0000-0000000000b2'''
\set MGR '''00000000-0000-0000-0000-0000000000b3'''
\set BAK '''00000000-0000-0000-0000-0000000000b4'''
insert into staff_assignments (user_id,kind,location_id) values (:MGR,'room_manager',:B),(:BAK,'room_backup',:B);
insert into staff_assignments (user_id,kind,course_id,semester_id) values (:SCI,'course_owner','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001');
create temp table day as select current_date + 20 d;

\echo '== T1 approvers of room B: manager + admin (backup hidden)'
select via, full_name from room_approvers(:B, (select d from day)) order by via;
\echo '== T1b manager away -> backup appears'
insert into user_away (user_id,starts_on,ends_on) values (:MGR,(select d from day),(select d from day));
select via, full_name from room_approvers(:B, (select d from day)) order by via;
delete from user_away;

\echo '== T2 instructor requests B 13-15 (pending), sci requests same slot -> conflict w/ contacts'
select booking_request(:INST, jsonb_build_array(jsonb_build_object('location_id',:B,'kind','prep','course_id','20000000-0000-0000-0000-000000000001',
  'starts_at', bkk_ts((select d from day),'13:00'),'ends_at',bkk_ts((select d from day),'15:00')))) -> 'created' ->0->>'status' as first_status;
select jsonb_pretty(booking_request(:SCI, jsonb_build_array(jsonb_build_object('location_id',:B,'kind','research','project_name','วิจัย X',
  'starts_at', bkk_ts((select d from day),'14:00'),'ends_at',bkk_ts((select d from day),'16:00')))) -> 'failed' -> 0 -> 'conflicts' -> 0);

\echo '== T3 manager overrides pending -> ok, first rejected'
select booking_request(:MGR, jsonb_build_array(jsonb_build_object('location_id',:B,'kind','maintenance','title','ล้างห้อง','override_note','ล้างห้องประจำปี',
  'starts_at', bkk_ts((select d from day),'14:00'),'ends_at',bkk_ts((select d from day),'16:00'))), null, true) -> 'created' -> 0 ->> 'status' as mgr_status;
select kind,status,decision_note from room_reservations where location_id=:B order by created_at;

\echo '== T4 manager cannot override approved -> conflict, can_override=false'
select booking_request(:MGR, jsonb_build_array(jsonb_build_object('location_id',:B,'kind','event','title','x',
  'starts_at', bkk_ts((select d from day),'15:00'),'ends_at',bkk_ts((select d from day),'17:00'))), null, true) -> 'failed' -> 0 -> 'can_override' as can_override;

\echo '== T5 weekly series 8 weeks in B 09-12, week 3 already booked -> 7 created 1 failed'
select booking_request(:ADMIN, jsonb_build_array(jsonb_build_object('location_id',:B,'kind','exam','title','block',
  'starts_at', bkk_ts((select d from day)+14,'10:00'),'ends_at',bkk_ts((select d from day)+14,'11:00'))));
select jsonb_array_length(x->'created') created, jsonb_array_length(x->'failed') failed, x->'failed'->0->>'index' failed_idx
from (select booking_request(:INST, (select jsonb_agg(jsonb_build_object('location_id',:B,'kind','training','title','อบรม',
  'starts_at', bkk_ts((select d from day)+7*w,'09:00'),'ends_at',bkk_ts((select d from day)+7*w,'12:00'))) from generate_series(0,7) w),
  '{"pattern":"weekly","rule":{"weekdays":[1]}}') x) q;

\echo '== T6 shift approved class 30 min in same room -> does not conflict with itself (admin applies directly)'
create temp table c1 as select r.*, s.start_time st from room_reservations r join schedules s using (schedule_id)
  where s.class_date=current_date+5 and s.start_time='15:00' and s.section_id='40000000-0000-0000-0000-000000000001';
select booking_change(:ADMIN, (select reservation_id from c1), :A, (select starts_at from c1)+interval '30 min', (select ends_at from c1)+interval '30 min') ->> 'mode' as mode;
select start_time,end_time from schedules where schedule_id=(select schedule_id from c1);
\echo '   shift 14:00 slot by 30 min would hit 14:00-15:00? (14:30-15:30 vs 15:30-16:30 moved) -> 14:00 slot overlaps none? expect conflict with nothing'
\echo '== T6b instructor (not approver) shifts 30 min -> pending_change, row unchanged'
create temp table c2 as select r.* from room_reservations r join schedules s using (schedule_id)
  where s.class_date=current_date+6 and s.start_time='15:00' and s.section_id='40000000-0000-0000-0000-000000000001';
select booking_change(:INST, (select reservation_id from c2), :A, (select starts_at from c2)+interval '30 min', (select ends_at from c2)+interval '30 min') ->> 'mode' as mode;
select status, pending_change is not null has_change, (starts_at at time zone 'Asia/Bangkok')::time from room_reservations where reservation_id=(select reservation_id from c2);
\echo '   admin approves change -> schedule moves'
select booking_decide(:ADMIN, array[(select reservation_id from c2)], true) -> 'done' ->0->>'reservation_id' is not null ok;
select start_time,end_time from schedules where schedule_id=(select schedule_id from c2);

\echo '== T7 move class to room B (instructor) -> replacement pending; manager rejects -> original stays'
create temp table c3 as select r.* from room_reservations r join schedules s using (schedule_id)
  where s.class_date=current_date+3 and s.start_time='10:00' and s.section_id='40000000-0000-0000-0000-000000000001';
create temp table ch as select booking_change(:INST, (select reservation_id from c3), :B, (select starts_at from c3), (select ends_at from c3)) x;
select x->>'mode' mode, x->>'status' status from ch;
select booking_decide(:MGR, array[(x->>'reservation_id')::uuid], false, 'ไม่ว่าง') ->'done' is not null from ch;
select r.status, l.name, s.location_id = r.location_id same_loc from room_reservations r join schedules s using (schedule_id) join locations l on l.location_id=r.location_id where r.reservation_id=(select reservation_id from c3);
\echo '   move again, manager approves -> original cancelled, schedule now in B'
create temp table ch2 as select booking_change(:INST, (select reservation_id from c3), :B, (select starts_at from c3), (select ends_at from c3)) x;
select booking_decide(:MGR, array[(x->>'reservation_id')::uuid], true) -> 'skipped' skipped from ch2;
select (select status from room_reservations where reservation_id=(select reservation_id from c3)) old_status,
       (select l.name from schedules s join locations l using (location_id) where s.schedule_id=(select schedule_id from c3)) sched_room;

\echo '== T8 cancel schedule -> room free immediately; tasks cancelled'
insert into topic_task_rules (topic_id,task_type,offset_days,duration_hours) values ('60000000-0000-0000-0000-000000000001','prep',-1,2);
select generate_rule_tasks(array(select schedule_id from schedules where class_date>=current_date and start_time='08:00' and section_id='40000000-0000-0000-0000-000000000001')) tasks_made;
create temp table c4 as select schedule_id from schedules where class_date=current_date+8 and start_time='08:00' and section_id='40000000-0000-0000-0000-000000000001';
update schedules set status='cancelled' where schedule_id=(select schedule_id from c4);
select (select string_agg(status,',') from room_reservations where schedule_id=(select schedule_id from c4)) resv,
       (select string_agg(status,',') from tasks where schedule_id=(select schedule_id from c4)) tasks;
select booking_request(:SCI, jsonb_build_array(jsonb_build_object('location_id',:A,'kind','prep','course_id','20000000-0000-0000-0000-000000000001',
  'starts_at', bkk_ts(current_date+8,'08:00'),'ends_at',bkk_ts(current_date+8,'09:00')))) -> 'created' -> 0 ->> 'status' as rebook_freed_slot;

\echo '== T9 new-term session clashing with a booking -> session saved, no room (shows in dashboard)'
insert into schedules (section_id,location_id,class_date,start_time,end_time) values ('40000000-0000-0000-0000-000000000002',:B,(select d from day),'14:30','15:00');
select count(*) sessions, count(r.*) reservations from schedules s left join room_reservations r using (schedule_id)
 where s.class_date=(select d from day) and s.location_id=:B;
\echo '   non-clashing legacy insert by admin actor -> approved reservation created'
select set_config('app.actor', '00000000-0000-0000-0000-0000000000a1', false);
insert into schedules (section_id,location_id,class_date,start_time,end_time) values ('40000000-0000-0000-0000-000000000002',:B,(select d from day)+1,'08:00','09:00');
select status, self_approved from room_reservations where schedule_id=(select schedule_id from schedules where class_date=(select d from day)+1 and location_id=:B);
select set_config('app.actor', '', false);

\echo '== T10 task date follows schedule shift (A shift prior day)'
create temp table c5 as select schedule_id, class_date from schedules where class_date=current_date+9 and start_time='08:00' and section_id='40000000-0000-0000-0000-000000000001';
select task_date - (select class_date from c5) offset_before from tasks where schedule_id=(select schedule_id from c5);

\echo '== T11 session_topics multi-topic -> schedules.topic_id = first'
insert into session_topics (schedule_id, topic_id, seq) select schedule_id,'60000000-0000-0000-0000-000000000002',0 from c5;
select t.title_th from schedules s join lab_topics t using (topic_id) where s.schedule_id=(select schedule_id from c5);

\echo '== T12 leave request approved -> excused'
insert into leave_requests (schedule_id,student_id,submitted_via,requested_by,reason) select schedule_id,'00000000-0000-0000-0000-0000000000c1','student','00000000-0000-0000-0000-0000000000c1','ป่วย' from c5 returning request_id \gset
select leave_decide(:INST, :'request_id', true) ->> 'status';
select status, is_manual from attendance_records where schedule_id=(select schedule_id from c5);

\echo '== T13 readiness + dashboard'
select rooms_ok, rooms_pending, topic_ok, roster_ok from schedule_readiness(array(select schedule_id from c5));
select course_code, first_class, request_due, approve_due, sessions, no_request, pending, approved from booking_term_dashboard('30000000-0000-0000-0000-000000000001');
\echo '== T14 audit rows'
select table_name, action, count(*) from audit_log group by 1,2 order by 1,2;
\echo '== T15 past held sessions migrated with actual hours; past cancelled not'
select s.status, count(r.*) resv, sum(r.actual_hours) hrs from schedules s left join room_reservations r using (schedule_id)
 where s.class_date < current_date group by 1 order by 1;
select count(*) past_sched, count(*) filter (where booking_id is not null) with_booking from schedules where class_date < current_date;
select count(*) attendance from attendance_records;
