-- ลบข้อมูลจำลองทั้งหมด (รันก่อนเริ่มใช้งานจริง)
delete from public.notification_logs where schedule_id in (select schedule_id from public.schedules where booking_id::text like '90000000-%');
delete from public.attendance_records where schedule_id in (select schedule_id from public.schedules where booking_id::text like '90000000-%');
delete from public.face_templates where student_id::text like 'b0000000-%';
delete from public.schedules where booking_id::text like '90000000-%';
-- คาบของกลุ่มทดสอบทั้งหมด (ชุดสมจริง realistic_mock.sql) + ข้อมูลที่ผูกกับคาบ
delete from public.leave_requests where schedule_id in (select schedule_id from public.schedules where section_id::text like 'e0000000-%');
delete from public.tasks where schedule_id in (select schedule_id from public.schedules where section_id::text like 'e0000000-%');
delete from public.tasks where note = 'ข้อมูลทดสอบ' and created_by::text like 'a0000000-%';
update public.room_items set schedule_id = null where schedule_id in (select schedule_id from public.schedules where section_id::text like 'e0000000-%');
update public.room_items set reuse_schedule_id = null where reuse_schedule_id in (select schedule_id from public.schedules where section_id::text like 'e0000000-%');
delete from public.notification_logs where schedule_id in (select schedule_id from public.schedules where section_id::text like 'e0000000-%');
delete from public.attendance_records where schedule_id in (select schedule_id from public.schedules where section_id::text like 'e0000000-%');
delete from public.schedules where section_id::text like 'e0000000-%';
delete from public.room_reservations where requested_by::text like 'a0000000-%' or location_id::text like 'f0000000-%';
delete from public.room_bookings where booking_id::text like '90000000-%';
delete from public.telegram_channels where section_id::text like 'e0000000-%';
delete from public.section_enrollments where section_id::text like 'e0000000-%';
delete from public.lab_sections where section_id::text like 'e0000000-%';
delete from public.locations where location_id::text like 'f0000000-%';
delete from public.courses where course_id::text like 'c0000000-%';
update public.users set department_id = null where department_id::text like 'dd000000-%';
delete from public.departments where department_id::text like 'dd000000-%';
delete from public.semesters where semester_id::text like 'd0000000-%';
delete from auth.users where email like '%@mock.cph-smart-checkin.test'; -- cascade ไป users/students
