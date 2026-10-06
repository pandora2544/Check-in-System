-- ============================================================
-- ระยะ 1 · ฟังก์ชันงานประจำของบุคลากร (เรียกจาก Edge Function "work")
--   ผู้ทำ (p_by) ถูกบันทึกลง audit_log ผ่าน app.actor ทุกครั้ง
--   1) งดคาบ / เลื่อนคาบ (สร้างคาบชดเชย) / คืนคาบ — ผู้ประสานรายวิชา (หลัก → รองเมื่อหลักไม่อยู่) หรือแอดมิน
--   2) ตารางงาน: สร้าง/แก้/ทำเสร็จ/ลบ — ผู้สร้าง ผู้รับงาน ผู้ประสานรายวิชา (งานของวิชา) หรือแอดมิน
-- ไม่มีคำสั่งลบตาราง/คอลัมน์ — สร้างหรือแทนที่ฟังก์ชันเท่านั้น
-- ============================================================

-- ---------- 1) คาบเรียน ----------
-- งด: not_needed = ไม่ต้องเรียนแล้ว (ไม่คิดต้นทุน) · other_held = งดตามตาราง แต่มีการเรียนจริงในรูปแบบอื่น (คิดต้นทุน)
create or replace function public.session_cancel(p_by uuid, p_schedule uuid, p_reason text, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s schedules; v_course uuid; v_sem uuid;
begin
  perform set_config('app.actor', p_by::text, true);
  if p_reason not in ('not_needed', 'other_held') then return jsonb_build_object('ok', false, 'result', 'bad_reason'); end if;
  select * into s from schedules where schedule_id = p_schedule for update;
  if not found then return jsonb_build_object('ok', false, 'result', 'not_found'); end if;
  select course_id, semester_id into v_course, v_sem from lab_sections where section_id = s.section_id;
  if not user_manages_course(p_by, v_course, v_sem) then return jsonb_build_object('ok', false, 'result', 'not_coordinator'); end if;
  if s.status = 'cancelled' then return jsonb_build_object('ok', false, 'result', 'already_cancelled'); end if;
  update schedules set status = 'cancelled', cancel_reason = p_reason, cancel_note = nullif(trim(coalesce(p_note, '')), '')
   where schedule_id = s.schedule_id;
  return jsonb_build_object('ok', true, 'schedule_id', s.schedule_id, 'section_id', s.section_id, 'course_id', v_course, 'semester_id', v_sem);
end $$;

-- เลื่อน: คาบเดิม = งด (postponed) + บันทึก "จาก → ไป" · สร้างคาบชดเชย (kind=makeup, makeup_of=คาบเดิม) พร้อมบทเดิมทุกบท
-- ห้องของคาบชดเชยถูกขอจองอัตโนมัติ (trigger) — ห้องชนก็ยังสร้างคาบได้ แต่ขึ้นว่า "ยังไม่มีห้อง"
create or replace function public.session_postpone(p_by uuid, p_schedule uuid, p_date date, p_start time, p_end time,
  p_location uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s schedules; v_course uuid; v_sem uuid; v_new uuid; v_loc uuid; v_has_room boolean; v_th text;
begin
  perform set_config('app.actor', p_by::text, true);
  if p_end <= p_start then return jsonb_build_object('ok', false, 'result', 'bad_time'); end if;
  select * into s from schedules where schedule_id = p_schedule for update;
  if not found then return jsonb_build_object('ok', false, 'result', 'not_found'); end if;
  select course_id, semester_id into v_course, v_sem from lab_sections where section_id = s.section_id;
  if not user_manages_course(p_by, v_course, v_sem) then return jsonb_build_object('ok', false, 'result', 'not_coordinator'); end if;
  if s.status = 'cancelled' then return jsonb_build_object('ok', false, 'result', 'already_cancelled'); end if;
  if (p_date + p_start) at time zone 'Asia/Bangkok' < now() then return jsonb_build_object('ok', false, 'result', 'past'); end if;
  v_loc := coalesce(p_location, s.location_id);
  v_th := to_char(s.class_date, 'DD/MM/YYYY') || ' ' || to_char(s.start_time, 'HH24:MI') || '–' || to_char(s.end_time, 'HH24:MI')
       || ' → ' || to_char(p_date, 'DD/MM/YYYY') || ' ' || to_char(p_start, 'HH24:MI') || '–' || to_char(p_end, 'HH24:MI');

  update schedules set status = 'cancelled', cancel_reason = 'postponed',
         cancel_note = left('เลื่อน ' || v_th || coalesce(' · ' || nullif(trim(coalesce(p_note, '')), ''), ''), 500)
   where schedule_id = s.schedule_id;

  insert into schedules (section_id, location_id, class_date, start_time, end_time, status, topic_id, note, kind, makeup_of)
  values (s.section_id, v_loc, p_date, p_start, p_end, 'scheduled', s.topic_id,
          left('ชดเชยคาบ ' || to_char(s.class_date, 'DD/MM/YYYY') || coalesce(' · ' || nullif(trim(coalesce(p_note, '')), ''), ''), 500),
          'makeup', s.schedule_id)
  returning schedule_id into v_new;

  insert into session_topics (schedule_id, topic_id, seq, time_share)
  select v_new, topic_id, seq, time_share from session_topics where schedule_id = s.schedule_id
  on conflict (schedule_id, topic_id) do update set seq = excluded.seq, time_share = excluded.time_share;

  select exists (select 1 from room_reservations r where r.schedule_id = v_new and r.status in ('pending', 'approved')) into v_has_room;
  return jsonb_build_object('ok', true, 'schedule_id', s.schedule_id, 'makeup_id', v_new, 'has_room', v_has_room,
    'section_id', s.section_id, 'course_id', v_course, 'semester_id', v_sem, 'summary', v_th);
end $$;

-- คืนคาบที่งดไว้ (เฉพาะงดแบบ not_needed / other_held — คาบที่เลื่อนให้งดคาบชดเชยแทน)
create or replace function public.session_restore(p_by uuid, p_schedule uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s schedules; v_course uuid; v_sem uuid;
begin
  perform set_config('app.actor', p_by::text, true);
  select * into s from schedules where schedule_id = p_schedule for update;
  if not found then return jsonb_build_object('ok', false, 'result', 'not_found'); end if;
  select course_id, semester_id into v_course, v_sem from lab_sections where section_id = s.section_id;
  if not user_manages_course(p_by, v_course, v_sem) then return jsonb_build_object('ok', false, 'result', 'not_coordinator'); end if;
  if s.status <> 'cancelled' then return jsonb_build_object('ok', false, 'result', 'not_cancelled'); end if;
  if s.cancel_reason = 'postponed' then return jsonb_build_object('ok', false, 'result', 'postponed'); end if;
  update schedules set status = 'scheduled', cancel_reason = null, cancel_note = null where schedule_id = s.schedule_id;
  return jsonb_build_object('ok', true, 'schedule_id', s.schedule_id,
    'has_room', exists (select 1 from room_reservations r where r.schedule_id = s.schedule_id and r.status in ('pending', 'approved')));
end $$;


-- ---------- 2) ตารางงาน ----------
create or replace function public.task_can_edit(p_by uuid, t public.tasks)
returns boolean language sql stable set search_path = public as $$
  select user_is_admin(p_by) or t.created_by = p_by or t.assignee_id = p_by
      or (t.course_id is not null and user_manages_course(p_by, t.course_id, t.semester_id));
$$;

-- ผู้ใช้เกี่ยวข้องกับวิชา (มีงานมอบหมายระดับวิชา หรือสอนกลุ่มเรียนของวิชาในเทอมนั้น)
create or replace function public.user_in_course(p_by uuid, p_course uuid, p_semester uuid)
returns boolean language sql stable set search_path = public as $$
  select user_is_admin(p_by)
      or exists (select 1 from staff_assignments a where a.user_id = p_by and a.course_id = p_course and a.semester_id = p_semester
                  and a.kind in ('course_owner', 'course_backup', 'lab_staff', 'lab_worker'))
      or exists (select 1 from lab_sections ls left join staff_assignments a on a.section_id = ls.section_id and a.kind = 'instructor' and a.user_id = p_by
                  where ls.course_id = p_course and ls.semester_id = p_semester and (ls.instructor_id = p_by or a.assignment_id is not null));
$$;

-- p_action: 'save' (สร้าง/แก้ ตาม p_id) · 'status' · 'remove'
-- p: { title, task_type, task_date, start_time, duration_hours, assignee_id, is_private, note, course_id, semester_id, schedule_id, status, actual_hours }
create or replace function public.task_write(p_by uuid, p_action text, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t tasks; v_course uuid; v_sem uuid; v_sched uuid; v_private boolean; v_status text; v_id uuid;
begin
  perform set_config('app.actor', p_by::text, true);
  if p_id is not null then
    select * into t from tasks where task_id = p_id for update;
    if not found then return jsonb_build_object('ok', false, 'result', 'not_found'); end if;
    if not task_can_edit(p_by, t) then return jsonb_build_object('ok', false, 'result', 'forbidden'); end if;
  elsif p_action <> 'save' then
    return jsonb_build_object('ok', false, 'result', 'not_found');
  end if;

  if p_action = 'status' then
    v_status := p ->> 'status';
    if v_status not in ('todo', 'done', 'cancelled') then return jsonb_build_object('ok', false, 'result', 'bad_status'); end if;
    update tasks set status = v_status,
      actual_hours = case when p ? 'actual_hours' then nullif(p ->> 'actual_hours', '')::numeric else actual_hours end,
      done_by = case when v_status = 'done' then p_by end, done_at = case when v_status = 'done' then now() end, updated_at = now()
    where task_id = t.task_id;
    return jsonb_build_object('ok', true, 'task_id', t.task_id, 'status', v_status);
  end if;

  if p_action = 'remove' then
    -- "ลบ" = ยกเลิก (เก็บประวัติไว้ในบันทึกการแก้ไข · งานจากสิ่งที่ต้องเตรียมจะไม่ถูกสร้างซ้ำ) — หน้าเว็บซ่อนงานที่ยกเลิก
    update tasks set status = 'cancelled', updated_at = now() where task_id = t.task_id;
    return jsonb_build_object('ok', true, 'task_id', t.task_id, 'removed', 'cancelled');
  end if;

  if p_action <> 'save' then return jsonb_build_object('ok', false, 'result', 'bad_action'); end if;
  if coalesce(trim(p ->> 'title'), '') = '' then return jsonb_build_object('ok', false, 'result', 'no_title'); end if;
  if nullif(p ->> 'task_date', '') is null then return jsonb_build_object('ok', false, 'result', 'no_date'); end if;

  v_sched := nullif(p ->> 'schedule_id', '')::uuid;
  v_course := nullif(p ->> 'course_id', '')::uuid;
  v_sem := nullif(p ->> 'semester_id', '')::uuid;
  if v_sched is not null then
    select ls.course_id, ls.semester_id into v_course, v_sem from schedules s join lab_sections ls on ls.section_id = s.section_id where s.schedule_id = v_sched;
  end if;
  if v_course is not null and v_sem is null then return jsonb_build_object('ok', false, 'result', 'no_semester'); end if;
  if v_course is not null and (p_id is null or v_course is distinct from t.course_id) and not user_in_course(p_by, v_course, v_sem) then
    return jsonb_build_object('ok', false, 'result', 'not_in_course');
  end if;
  v_private := coalesce((p ->> 'is_private')::boolean, false) and v_course is null;

  if p_id is null then
    insert into tasks (source, schedule_id, course_id, semester_id, task_type, title, assignee_id, task_date, start_time, duration_hours,
                       is_private, note, created_by)
    values (case when v_course is not null then 'manual' when v_private then 'personal' else 'general' end,
            v_sched, v_course, v_sem, coalesce(nullif(p ->> 'task_type', ''), 'other'), left(trim(p ->> 'title'), 200),
            coalesce(nullif(p ->> 'assignee_id', '')::uuid, p_by), (p ->> 'task_date')::date,
            nullif(p ->> 'start_time', '')::time, nullif(p ->> 'duration_hours', '')::numeric,
            v_private, nullif(left(trim(coalesce(p ->> 'note', '')), 1000), ''), p_by)
    returning task_id into v_id;
    return jsonb_build_object('ok', true, 'task_id', v_id, 'created', true);
  end if;

  update tasks set
    title = left(trim(p ->> 'title'), 200),
    task_type = coalesce(nullif(p ->> 'task_type', ''), task_type),
    task_date = (p ->> 'task_date')::date,
    start_time = nullif(p ->> 'start_time', '')::time,
    duration_hours = nullif(p ->> 'duration_hours', '')::numeric,
    assignee_id = coalesce(nullif(p ->> 'assignee_id', '')::uuid, assignee_id),
    handed_over_from = case when nullif(p ->> 'assignee_id', '')::uuid is distinct from assignee_id and nullif(p ->> 'assignee_id', '') is not null
                            then assignee_id else handed_over_from end,
    is_private = case when source in ('rule', 'manual') then false else v_private end,
    course_id = case when source in ('rule', 'manual') then course_id else v_course end,
    semester_id = case when source in ('rule', 'manual') then semester_id else v_sem end,
    source = case when source in ('rule', 'manual') then source when v_course is not null then 'manual' when v_private then 'personal' else 'general' end,
    note = nullif(left(trim(coalesce(p ->> 'note', '')), 1000), ''),
    manually_edited = manually_edited or source = 'rule',
    updated_at = now()
  where task_id = t.task_id;
  return jsonb_build_object('ok', true, 'task_id', t.task_id, 'created', false);
end $$;

-- ใช้ผ่าน Edge Function (service role) เท่านั้น
revoke all on function public.session_cancel(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.session_postpone(uuid, uuid, date, time, time, uuid, text) from public, anon, authenticated;
revoke all on function public.session_restore(uuid, uuid) from public, anon, authenticated;
revoke all on function public.task_write(uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.session_cancel(uuid, uuid, text, text) to service_role;
grant execute on function public.session_postpone(uuid, uuid, date, time, time, uuid, text) to service_role;
grant execute on function public.session_restore(uuid, uuid) to service_role;
grant execute on function public.task_write(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.task_can_edit(uuid, public.tasks) to service_role;
grant execute on function public.user_in_course(uuid, uuid, uuid) to service_role;
