\set ON_ERROR_STOP 1
\pset footer off
\set A '''10000000-0000-0000-0000-00000000000a'''
\set B '''10000000-0000-0000-0000-00000000000b'''
\set ADMIN '''00000000-0000-0000-0000-0000000000a1'''
\set SCI '''00000000-0000-0000-0000-0000000000b1'''
\set INST '''00000000-0000-0000-0000-0000000000b2'''
\set MGR '''00000000-0000-0000-0000-0000000000b3'''
\set BAK '''00000000-0000-0000-0000-0000000000b4'''
\set C1 '''20000000-0000-0000-0000-000000000001'''
\set SEM '''30000000-0000-0000-0000-000000000001'''
-- seed roles: room B manager/backup; CHM101L primary = SCI (replace auto owner INST), backup = BAK
\echo '== R0 auto owners from instructors removed; non-scientist cannot be coordinator'
select count(*) owners_left from staff_assignments where kind='course_owner';
\set ON_ERROR_STOP 0
insert into staff_assignments (user_id,kind,course_id,semester_id) values (:INST,'course_owner',:C1,:SEM);
\set ON_ERROR_STOP 1
update users set is_scientist = true where user_id in (:SCI, :BAK);
insert into staff_assignments (user_id,kind,location_id) values (:MGR,'room_manager',:B),(:BAK,'room_backup',:B);
insert into staff_assignments (user_id,kind,course_id,semester_id) values (:SCI,'course_owner',:C1,:SEM),(:BAK,'course_backup',:C1,:SEM);
create function pg_temp.bkk_ts(d date, t time) returns timestamptz language sql as $$ select (d + t) at time zone 'Asia/Bangkok' $$;
create temp table day as select current_date + 20 d;

\echo '== R1 course coordinators: primary here / primary away / both away'
select role, urgent from course_coordinators(:C1,:SEM,(select d from day));
insert into user_away (user_id,from_date,to_date) values (:SCI,(select d from day),(select d from day));
select role, urgent from course_coordinators(:C1,:SEM,(select d from day));
insert into user_away (user_id,from_date,to_date) values (:BAK,(select d from day),(select d from day));
select role, urgent from course_coordinators(:C1,:SEM,(select d from day));
\echo '== R1b room approvers same rule (manager+backup both away -> both urgent)'
select role, urgent from room_approvers(:B,(select d from day)) order by role;
insert into user_away (user_id,from_date,to_date) values (:MGR,(select d from day),(select d from day));
select role, urgent from room_approvers(:B,(select d from day)) order by role;
delete from user_away;
\echo '== R1c backup can manage course only when primary away (today)'
select user_manages_course(:BAK,:C1,:SEM) backup_when_primary_here;
insert into user_away (user_id,from_date,to_date) values (:SCI,current_date,current_date);
select user_manages_course(:BAK,:C1,:SEM) backup_when_primary_away;
delete from user_away;

\echo '== R2 INST books B (pending); MGR approves; MGR cannot cancel; MGR asks to move; INST accepts and cancels'
create temp table tb as select (booking_request(jsonb_build_object('location_id',:B,'requested_by',:INST,'kind','prep','course_id',:C1,'semester_id',:SEM,
  'items', jsonb_build_array(jsonb_build_object('starts_at',pg_temp.bkk_ts((select d from day),'13:00'),'ends_at',pg_temp.bkk_ts((select d from day),'15:00'))))) -> 'results' -> 0 ->> 'reservation_id')::uuid id;
select booking_decide(array[(select id from tb)], true, :MGR) -> 0 ->> 'result' decided;
select booking_cancel(array[(select id from tb)], :MGR) mgr_cancel_count;
select booking_change((select id from tb), :B, pg_temp.bkk_ts((select d from day),'16:00'), pg_temp.bkk_ts((select d from day),'17:00'), null, null, :MGR, true) ->> 'result' mgr_change;
select room_move_request(:INST, (select id from tb), 'x') ->> 'result' inst_cannot_ask;
select room_move_request(:MGR, (select id from tb), 'ท่อน้ำแตก', true) ->> 'ok' mgr_asks;
select room_move_respond(:MGR, (select move_request_id from room_move_requests), true) ->> 'result' mgr_cannot_answer;
select room_move_respond(:INST, (select move_request_id from room_move_requests), true) ->> 'ok' inst_accepts;
select booking_cancel(array[(select id from tb)], :INST) inst_cancel_count;
\echo '== R2b audit shows who did what on that booking'
select action, (select full_name from users where user_id=actor) who, after->>'status' status from audit_log where table_name='room_reservations' and row_id=(select id::text from tb) order by audit_id;

\echo '== R3 new-term session clashing with an approved booking -> session saved, no room'
select booking_request(jsonb_build_object('location_id',:B,'requested_by',:ADMIN,'kind','exam','items',
  jsonb_build_array(jsonb_build_object('starts_at',pg_temp.bkk_ts((select d from day)+1,'09:00'),'ends_at',pg_temp.bkk_ts((select d from day)+1,'12:00'),'approve',true)))) -> 'results' -> 0 ->> 'status' exam;
insert into schedules (section_id,location_id,class_date,start_time,end_time) values ('40000000-0000-0000-0000-000000000002',:B,(select d from day)+1,'10:00','11:00');
select count(*) sessions, count(r.reservation_id) rooms from schedules s left join room_reservations r on r.schedule_id=s.schedule_id and r.status in ('pending','approved')
 where s.class_date=(select d from day)+1 and s.location_id=:B;
select course_code, no_room from booking_term_dashboard(:SEM) order by 1;

\echo '== R4 past held sessions have used hours; cancel_reason column'
select count(*) past_resv, sum(used_hours) hrs from room_reservations where ends_at < now();
update schedules set status='cancelled', cancel_reason='not_needed' where schedule_id=(select schedule_id from schedules where class_date=current_date+3 and start_time='09:00' limit 1);
select status from room_reservations where schedule_id=(select schedule_id from schedules where class_date=current_date+3 and start_time='09:00' limit 1);

\echo '== R5 leave: SCI (not instructor) denied; INST approves -> excused'
insert into leave_requests (schedule_id,student_id,submitted_via,requested_by,reason)
select schedule_id,'00000000-0000-0000-0000-0000000000c1','student','00000000-0000-0000-0000-0000000000c1','ป่วย' from schedules
 where section_id='40000000-0000-0000-0000-000000000001' and class_date=current_date+5 and start_time='08:00' returning request_id \gset
select leave_decide(:SCI, :'request_id', true) ->> 'result' sci;
select leave_decide(:INST, :'request_id', true) ->> 'status' inst;

\echo '== R6 tasks: rules -> generate; shift session moves task; private task hidden from colleague'
insert into topic_task_rules (topic_id,task_type,offset_days,duration_hours) values ('60000000-0000-0000-0000-000000000001','prep',-1,2);
select generate_rule_tasks(array(select schedule_id from schedules where class_date>=current_date and start_time='08:00' and section_id='40000000-0000-0000-0000-000000000001'), :SCI) made;
insert into tasks (source,task_type,title,assignee_id,task_date,created_by,is_private) values ('personal','other','ส่วนตัว',:INST,current_date,:INST,true),('general','other','ตรวจนับคลัง',:INST,current_date,:INST,false);
set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b2',false);
select count(*) inst_sees from tasks where source in ('personal','general');
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-0000000000b1',false);
select count(*) sci_sees from tasks where source in ('personal','general');
reset role;
\echo '== R7 session topics multi -> first topic synced; readiness'
insert into session_topics (schedule_id, topic_id, seq) select schedule_id,'60000000-0000-0000-0000-000000000002',0 from schedules where class_date=current_date+9 and start_time='08:00' and section_id='40000000-0000-0000-0000-000000000001';
select t.title_th from schedules s join lab_topics t using (topic_id) where s.class_date=current_date+9 and s.start_time='08:00' and s.section_id='40000000-0000-0000-0000-000000000001';
select rooms_ok, topic_ok, roster_ok from schedule_readiness(array(select schedule_id from schedules where class_date=current_date+9 and start_time='08:00' and section_id='40000000-0000-0000-0000-000000000001'));
\echo '== R8 delete a session (cascade) does not break audit'
delete from schedules where class_date=current_date+10 and start_time='14:00' and section_id='40000000-0000-0000-0000-000000000001';
select table_name, action, count(*) from audit_log group by 1,2 order by 1,2;
