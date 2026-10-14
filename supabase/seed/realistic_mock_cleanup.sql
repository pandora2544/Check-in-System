-- ลบเศษข้อมูลจำลองรุ่นเก่า (รันใน Supabase SQL Editor — คำสั่ง DELETE ผ่าน MCP ถูกบล็อก)
-- ปลอดภัย: แตะเฉพาะแถวทดสอบ (กลุ่ม e0000000-*, ผู้ขอ a0000000-*)
begin;
-- งานเตรียม/เก็บที่เคยสร้างให้คาบทดสอบรายชั่วโมง (CHM101L-01 → TEST24) ~1,668 งาน
delete from public.tasks where schedule_id in (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000001');
delete from public.session_topics where schedule_id in (select schedule_id from public.schedules where section_id = 'e0000000-0000-4000-8000-000000000001');
-- คาบรายวันเดิมของ BIO101L-01 (ตั้งเป็น cancelled แล้ว)
update public.room_items set schedule_id = null where schedule_id in (select schedule_id from public.schedules where note = 'mock-old-daily');
update public.room_items set reuse_schedule_id = null where reuse_schedule_id in (select schedule_id from public.schedules where note = 'mock-old-daily');
delete from public.notification_logs where schedule_id in (select schedule_id from public.schedules where note = 'mock-old-daily');
delete from public.attendance_records where schedule_id in (select schedule_id from public.schedules where note = 'mock-old-daily');
delete from public.schedules where note = 'mock-old-daily';
-- การจองเก่าที่ยกเลิกแล้ว
delete from public.room_reservations where decision_note like 'mock-old%' and requested_by::text like 'a0000000-%';
commit;
select (select count(*) from public.tasks t join public.schedules s using (schedule_id) where s.section_id = 'e0000000-0000-4000-8000-000000000001') test_tasks_left,
       (select count(*) from public.schedules where note = 'mock-old-daily') old_daily_left;
