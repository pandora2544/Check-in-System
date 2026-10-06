-- ============================================================
-- ระยะ 1 · เปลี่ยนห้องของคาบ (ผู้ประสานรายวิชา) — ใช้ตอนคาบ "ยังไม่มีห้อง" (ห้องเดิมชน) หรือย้ายห้อง
-- การจองห้องของคาบถูกขอใหม่อัตโนมัติผ่าน trigger schedule_sync_reservation (สถานะ "รออนุมัติ")
-- ห้องใหม่ชน → ไม่เปลี่ยนอะไร (คืน conflict)
-- ============================================================
create or replace function public.session_set_room(p_by uuid, p_schedule uuid, p_location uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s schedules; v_course uuid; v_sem uuid; v_has boolean;
begin
  perform set_config('app.actor', p_by::text, true);
  select * into s from schedules where schedule_id = p_schedule for update;
  if not found then return jsonb_build_object('ok', false, 'result', 'not_found'); end if;
  select course_id, semester_id into v_course, v_sem from lab_sections where section_id = s.section_id;
  if not user_manages_course(p_by, v_course, v_sem) then return jsonb_build_object('ok', false, 'result', 'not_coordinator'); end if;
  if s.status <> 'scheduled' then return jsonb_build_object('ok', false, 'result', 'already_cancelled'); end if;
  if not exists (select 1 from locations where location_id = p_location) then return jsonb_build_object('ok', false, 'result', 'not_found'); end if;
  begin
    update schedules set location_id = p_location where schedule_id = s.schedule_id;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'result', 'conflict');
  end;
  select exists (select 1 from room_reservations r where r.schedule_id = s.schedule_id and r.location_id = p_location and r.status in ('pending', 'approved')) into v_has;
  return jsonb_build_object('ok', true, 'schedule_id', s.schedule_id, 'has_room', v_has, 'section_id', s.section_id);
end $$;

revoke all on function public.session_set_room(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.session_set_room(uuid, uuid, uuid) to service_role;
