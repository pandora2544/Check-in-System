-- ตารางงาน (14 ต.ค. 2569): เพิ่มประเภท "นัดหมาย/ประชุม" (ไม่มีช่องติ๊กเสร็จ) + สถานที่ของนัด
alter table public.tasks drop constraint if exists tasks_task_type_check;
alter table public.tasks add constraint tasks_task_type_check
  check (task_type = any (array['prep', 'supervise', 'reading', 'cleanup', 'other', 'meeting']));
alter table public.tasks add column if not exists place text;
comment on column public.tasks.place is 'สถานที่ (ใช้กับนัดหมาย/ประชุม)';

create or replace function public.task_write(p_by uuid, p_action text, p_id uuid, p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
                       is_private, note, place, created_by)
    values (case when v_course is not null then 'manual' when v_private then 'personal' else 'general' end,
            v_sched, v_course, v_sem, coalesce(nullif(p ->> 'task_type', ''), 'other'), left(trim(p ->> 'title'), 200),
            coalesce(nullif(p ->> 'assignee_id', '')::uuid, p_by), (p ->> 'task_date')::date,
            nullif(p ->> 'start_time', '')::time, nullif(p ->> 'duration_hours', '')::numeric,
            v_private, nullif(left(trim(coalesce(p ->> 'note', '')), 1000), ''), nullif(left(trim(coalesce(p ->> 'place', '')), 200), ''), p_by)
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
    place = case when p ? 'place' then nullif(left(trim(coalesce(p ->> 'place', '')), 200), '') else place end,
    manually_edited = manually_edited or source = 'rule',
    updated_at = now()
  where task_id = t.task_id;
  return jsonb_build_object('ok', true, 'task_id', t.task_id, 'created', false);
end $function$;
