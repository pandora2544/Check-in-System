-- รันแล้วใน SQL Editor โดยผู้ใช้ 6 ต.ค. 2569 16:13 · ตรวจผลครบ 5 ข้อ · บันทึกใน schema_migrations แล้ว
-- ระยะ 1 · ส่วนที่ต้องยืนยันก่อนรัน (ลบ/ผ่อนข้อจำกัด) — รันใน Supabase SQL Editor
-- 1) เพิ่มหน้าที่ "ผู้ประสานรายวิชารอง" (course_backup) ในข้อจำกัดของ staff_assignments
-- 2) เอาอาจารย์ที่ถูกตั้งเป็นผู้ตั้งรายวิชาอัตโนมัติออก (ผู้ประสานต้องเป็นนักวิทย์) — อาจารย์ยังเป็นผู้สอนตามเดิม
-- 3) คาบไม่ต้องผูก room_bookings เดิมแล้ว (booking_id ไม่บังคับ)
-- 4) เพิ่มชนิดแจ้งเตือนใหม่ (ขอให้ย้าย ติดต่อด่วน คำขอลา ฯลฯ)
-- 5) โค้ดเดิมแก้บทของคาบ (schedules.topic_id) → บทของคาบ (session_topics) ตามให้
begin;
alter table public.staff_assignments drop constraint staff_assignments_kind_check;
alter table public.staff_assignments add constraint staff_assignments_kind_check check (kind in (
  'course_owner',    -- ผู้ประสานรายวิชาหลัก (นักวิทย์)
  'course_backup',   -- ผู้ประสานรายวิชารอง
  'instructor', 'lab_staff', 'lab_worker', 'room_manager', 'room_backup', 'room_delegate', 'cost_viewer'));
alter table public.staff_assignments drop constraint staff_assignments_check1;
alter table public.staff_assignments add constraint staff_assignments_scope_check check (
  (kind in ('course_owner', 'course_backup', 'lab_staff', 'lab_worker') and course_id is not null and semester_id is not null) or
  (kind = 'instructor' and section_id is not null) or
  (kind in ('room_manager', 'room_backup') and location_id is not null) or
  (kind = 'room_delegate' and location_id is not null and valid_from is not null and valid_to is not null) or
  (kind = 'cost_viewer'));

delete from public.staff_assignments a
 using public.users u
 where a.kind = 'course_owner' and u.user_id = a.user_id and not u.is_scientist and u.role <> 'admin';

alter table public.schedules alter column booking_id drop not null;   -- คาบไม่ต้องผูก room_bookings เดิมแล้ว

alter table public.notification_logs drop constraint notification_logs_notification_type_check;
alter table public.notification_logs add constraint notification_logs_notification_type_check
  check (notification_type = any (array[
    'mid_class_15min', 'end_of_class', 'auto_absent', 'roster_ready', 'class_reminder',
    'booking_submitted', 'booking_approved', 'booking_rejected', 'booking_change', 'booking_cancelled', 'booking_overridden',
    'booking_due', 'booking_partial', 'room_move_request', 'room_move_response',
    'session_cancelled', 'session_moved', 'task_assigned', 'task_handover', 'task_needs_cover',
    'leave_submitted', 'leave_decided', 'identity_pending', 'owner_request', 'urgent_contact']));

create or replace function public.sync_topic_to_session()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if pg_trigger_depth() > 1 then return new; end if;
  delete from session_topics where schedule_id = new.schedule_id;
  if new.topic_id is not null then insert into session_topics (schedule_id, topic_id, seq) values (new.schedule_id, new.topic_id, 1); end if;
  return new;
end $$;
create trigger trg_schedule_topic_legacy after update of topic_id on public.schedules
  for each row when (old.topic_id is distinct from new.topic_id) execute function public.sync_topic_to_session();
create trigger trg_schedule_topic_insert after insert on public.schedules
  for each row when (new.topic_id is not null) execute function public.sync_topic_to_session();
revoke all on function public.sync_topic_to_session() from public, anon, authenticated;
commit;
