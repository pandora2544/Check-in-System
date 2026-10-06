-- ลงฐานข้อมูลจริงแล้ว 6 ต.ค. 2569 (เวอร์ชัน 20261006062435) — สำเนาจาก supabase_migrations.schema_migrations
-- 017 ฟังก์ชันจองห้องแบบ transaction (plan.md 3.3 · ภาคผนวก ก.3)
create or replace function public.schedule_sync_reservation() returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_course uuid; v_sem uuid; v_req uuid; v_setup int; v_tear int; v_kind text;
  v_start timestamptz; v_end timestamptz; v_id uuid;
begin
  if tg_op = 'UPDATE' and new.status = 'cancelled' and old.status <> 'cancelled' then
    update room_reservations set status = 'cancelled', decision_note = coalesce(decision_note, 'คาบถูกงด')
     where schedule_id = new.schedule_id and status in ('pending', 'approved');
    return new;
  end if;
  if new.status <> 'scheduled' then return new; end if;

  v_start := (new.class_date + new.start_time) at time zone 'Asia/Bangkok';
  v_end := (new.class_date + new.end_time) at time zone 'Asia/Bangkok';
  v_kind := case when new.kind = 'makeup' then 'makeup' else 'class' end;

  if exists (select 1 from room_reservations r where r.schedule_id = new.schedule_id and r.location_id = new.location_id
              and r.starts_at = v_start and r.ends_at = v_end and r.status in ('pending', 'approved')) then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    select reservation_id into v_id from room_reservations r
     where r.schedule_id = new.schedule_id and r.location_id = old.location_id and r.status in ('pending', 'approved')
     order by (r.status = 'approved') desc, r.created_at limit 1;
    if v_id is not null then
      select setup_minutes, teardown_minutes into v_setup, v_tear from locations where location_id = new.location_id;
      update room_reservations set location_id = new.location_id, starts_at = v_start, ends_at = v_end,
             setup_minutes = case when new.location_id = old.location_id then setup_minutes else coalesce(v_setup, 0) end,
             teardown_minutes = case when new.location_id = old.location_id then teardown_minutes else coalesce(v_tear, 0) end,
             kind = v_kind,
             status = case when new.location_id <> old.location_id then 'pending' else status end,
             decided_by = case when new.location_id <> old.location_id then null else decided_by end,
             decided_at = case when new.location_id <> old.location_id then null else decided_at end
       where reservation_id = v_id;
      return new;
    end if;
  end if;

  select ls.course_id, ls.semester_id, ls.instructor_id into v_course, v_sem, v_req from lab_sections ls where ls.section_id = new.section_id;
  if v_req is null then select user_id into v_req from users where role = 'admin' order by created_at limit 1; end if;
  select setup_minutes, teardown_minutes into v_setup, v_tear from locations where location_id = new.location_id;
  insert into room_reservations (location_id, kind, status, starts_at, ends_at, setup_minutes, teardown_minutes, schedule_id, section_id, course_id, semester_id, requested_by)
  values (new.location_id, v_kind, 'pending', v_start, v_end, coalesce(v_setup, 0), coalesce(v_tear, 0), new.schedule_id, new.section_id, v_course, v_sem, v_req);
  return new;
end $$;

create or replace function public.resv_sync_schedule(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare r room_reservations;
begin
  select * into r from room_reservations where reservation_id = p_id;
  if r.schedule_id is null or r.status <> 'approved' then return; end if;
  update schedules set location_id = r.location_id,
         class_date = (r.starts_at at time zone 'Asia/Bangkok')::date,
         start_time = (r.starts_at at time zone 'Asia/Bangkok')::time,
         end_time = (r.ends_at at time zone 'Asia/Bangkok')::time
   where schedule_id = r.schedule_id;
end $$;

create or replace function public.booking_request(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_loc uuid := (p->>'location_id')::uuid;
  v_by uuid := (p->>'requested_by')::uuid;
  v_setup int := coalesce((p->>'setup_minutes')::int, 0);
  v_tear int := coalesce((p->>'teardown_minutes')::int, 0);
  v_override boolean := coalesce((p->>'override')::boolean, false);
  v_series uuid; it jsonb; v_s timestamptz; v_e timestamptz; v_block tstzrange;
  v_ids uuid[]; v_has_appr boolean; v_id uuid; v_status text; v_approve boolean;
  v_out jsonb := '[]'::jsonb; v_over uuid[] := '{}';
begin
  perform 1 from locations where location_id = v_loc for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if jsonb_array_length(coalesce(p->'items', '[]')) > 1 and p ? 'series' then
    insert into reservation_series (title, pattern, location_id, kind, section_id, created_by)
    values (p->'series'->>'title', coalesce(p->'series'->'pattern', '{}'::jsonb), v_loc, p->>'kind', nullif(p->>'section_id', '')::uuid, v_by)
    returning series_id into v_series;
  end if;

  for it in select * from jsonb_array_elements(coalesce(p->'items', '[]')) loop
    v_s := (it->>'starts_at')::timestamptz; v_e := (it->>'ends_at')::timestamptz;
    v_approve := coalesce((it->>'approve')::boolean, false);
    v_block := tstzrange(v_s - make_interval(mins => v_setup), v_e + make_interval(mins => v_tear), '[)');
    select array_agg(reservation_id), coalesce(bool_or(status = 'approved'), false) into v_ids, v_has_appr
      from room_reservations where location_id = v_loc and status in ('pending', 'approved') and block && v_block;
    if v_ids is not null then
      if v_override and not v_has_appr then
        update room_reservations set status = 'rejected', decided_by = v_by, decided_at = now(),
               decision_note = 'ผู้ดูแลห้องใช้ช่วงนี้' || coalesce(' — ' || nullif(p->>'override_note', ''), '')
         where reservation_id = any(v_ids);
        v_over := v_over || v_ids;
      else
        v_out := v_out || jsonb_build_object('starts_at', v_s, 'ends_at', v_e, 'ok', false, 'conflicts', to_jsonb(v_ids), 'has_approved', v_has_appr);
        continue;
      end if;
    end if;
    v_status := case when v_approve then 'approved' else 'pending' end;
    begin
      insert into room_reservations (location_id, kind, status, starts_at, ends_at, setup_minutes, teardown_minutes, schedule_id, section_id,
             course_id, semester_id, project_name, title, purpose, requested_by, actual_user, decided_by, decided_at, series_id)
      values (v_loc, p->>'kind', v_status, v_s, v_e, v_setup, v_tear, nullif(p->>'schedule_id', '')::uuid, nullif(p->>'section_id', '')::uuid,
             nullif(p->>'course_id', '')::uuid, nullif(p->>'semester_id', '')::uuid, nullif(p->>'project_name', ''), nullif(p->>'title', ''),
             nullif(p->>'purpose', ''), v_by, nullif(p->>'actual_user', ''),
             case when v_approve then v_by end, case when v_approve then now() end, v_series)
      returning reservation_id into v_id;
      v_out := v_out || jsonb_build_object('starts_at', v_s, 'ends_at', v_e, 'ok', true, 'reservation_id', v_id, 'status', v_status);
    exception when exclusion_violation then
      v_out := v_out || jsonb_build_object('starts_at', v_s, 'ends_at', v_e, 'ok', false, 'conflicts', '[]'::jsonb, 'race', true);
    end;
  end loop;
  if v_series is not null and not exists (select 1 from room_reservations where series_id = v_series) then
    delete from reservation_series where series_id = v_series; v_series := null;
  end if;
  return jsonb_build_object('series_id', v_series, 'results', v_out, 'overridden', to_jsonb(v_over));
end $$;

create or replace function public.booking_decide(p_ids uuid[], p_approve boolean, p_by uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r room_reservations; v_out jsonb := '[]'::jsonb; v_old room_reservations; v_sloc uuid; pc jsonb;
begin
  for r in select * from room_reservations where reservation_id = any(p_ids) order by starts_at for update loop
    pc := r.pending_change;
    if pc is not null and r.status in ('pending', 'approved') then
      if p_approve then
        begin
          update room_reservations set starts_at = (pc->>'starts_at')::timestamptz, ends_at = (pc->>'ends_at')::timestamptz,
                 setup_minutes = coalesce((pc->>'setup_minutes')::int, setup_minutes), teardown_minutes = coalesce((pc->>'teardown_minutes')::int, teardown_minutes),
                 pending_change = null, status = 'approved', decided_by = p_by, decided_at = now(), decision_note = p_note
           where reservation_id = r.reservation_id;
          select location_id into v_sloc from schedules where schedule_id = r.schedule_id;
          if r.schedule_id is not null and v_sloc = r.location_id then perform resv_sync_schedule(r.reservation_id); end if;
          v_out := v_out || jsonb_build_object('reservation_id', r.reservation_id, 'ok', true, 'result', 'change_approved');
        exception when exclusion_violation then
          v_out := v_out || jsonb_build_object('reservation_id', r.reservation_id, 'ok', false, 'result', 'conflict');
        end;
      else
        update room_reservations set pending_change = null, decision_note = coalesce(p_note, 'ไม่อนุมัติคำขอเปลี่ยน'), decided_by = p_by, decided_at = now()
         where reservation_id = r.reservation_id;
        v_out := v_out || jsonb_build_object('reservation_id', r.reservation_id, 'ok', true, 'result', 'change_rejected');
      end if;
    elsif r.status = 'pending' then
      if p_approve then
        if r.replaces_id is not null then
          select * into v_old from room_reservations where reservation_id = r.replaces_id for update;
          update room_reservations set status = 'cancelled', decision_note = 'ย้ายไปรายการใหม่', decided_by = p_by, decided_at = now()
           where reservation_id = r.replaces_id and status in ('pending', 'approved');
        end if;
        update room_reservations set status = 'approved', decided_by = p_by, decided_at = now(), decision_note = p_note where reservation_id = r.reservation_id;
        if r.schedule_id is not null and r.replaces_id is not null then
          select location_id into v_sloc from schedules where schedule_id = r.schedule_id;
          if v_sloc = v_old.location_id then perform resv_sync_schedule(r.reservation_id); end if;
        end if;
        v_out := v_out || jsonb_build_object('reservation_id', r.reservation_id, 'ok', true, 'result', 'approved', 'replaced', r.replaces_id);
      else
        update room_reservations set status = 'rejected', decided_by = p_by, decided_at = now(), decision_note = p_note where reservation_id = r.reservation_id;
        v_out := v_out || jsonb_build_object('reservation_id', r.reservation_id, 'ok', true, 'result', 'rejected');
      end if;
    else
      v_out := v_out || jsonb_build_object('reservation_id', r.reservation_id, 'ok', false, 'result', 'already_' || r.status);
    end if;
  end loop;
  return v_out;
end $$;

create or replace function public.booking_change(p_id uuid, p_location uuid, p_starts timestamptz, p_ends timestamptz,
  p_setup int, p_teardown int, p_by uuid, p_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r room_reservations; v_block tstzrange; v_ids uuid[]; v_new uuid; v_setup int; v_tear int;
begin
  select * into r from room_reservations where reservation_id = p_id for update;
  if r.reservation_id is null or r.status not in ('pending', 'approved') then return jsonb_build_object('ok', false, 'result', 'not_active'); end if;
  if p_ends <= p_starts then return jsonb_build_object('ok', false, 'result', 'bad_time'); end if;
  perform 1 from locations where location_id = p_location for update;
  if p_location = r.location_id then v_setup := coalesce(p_setup, r.setup_minutes); v_tear := coalesce(p_teardown, r.teardown_minutes);
  else select coalesce(p_setup, setup_minutes), coalesce(p_teardown, teardown_minutes) into v_setup, v_tear from locations where location_id = p_location; end if;
  v_block := tstzrange(p_starts - make_interval(mins => v_setup), p_ends + make_interval(mins => v_tear), '[)');
  select array_agg(reservation_id) into v_ids from room_reservations
   where location_id = p_location and status in ('pending', 'approved') and block && v_block and reservation_id <> p_id;
  if v_ids is not null then return jsonb_build_object('ok', false, 'result', 'conflict', 'conflicts', to_jsonb(v_ids)); end if;

  if r.status = 'pending' and r.replaces_id is null then
    update room_reservations set location_id = p_location, starts_at = p_starts, ends_at = p_ends, setup_minutes = v_setup, teardown_minutes = v_tear,
           status = case when p_auto then 'approved' else 'pending' end, decided_by = case when p_auto then p_by end, decided_at = case when p_auto then now() end
     where reservation_id = p_id;
    if p_auto then perform resv_sync_schedule(p_id); end if;
    return jsonb_build_object('ok', true, 'result', case when p_auto then 'updated_approved' else 'updated_pending' end, 'reservation_id', p_id);
  end if;

  if p_location = r.location_id and tstzrange(p_starts, p_ends, '[)') && tstzrange(r.starts_at, r.ends_at, '[)') then
    update room_reservations set pending_change = jsonb_build_object('starts_at', p_starts, 'ends_at', p_ends, 'setup_minutes', v_setup,
           'teardown_minutes', v_tear, 'requested_by', p_by, 'at', now())
     where reservation_id = p_id;
    if p_auto then return jsonb_build_object('ok', true, 'result', 'change_applied', 'reservation_id', p_id, 'decide', booking_decide(array[p_id], true, p_by, null)); end if;
    return jsonb_build_object('ok', true, 'result', 'change_requested', 'reservation_id', p_id);
  end if;

  begin
    insert into room_reservations (location_id, kind, status, starts_at, ends_at, setup_minutes, teardown_minutes, schedule_id, section_id, course_id,
           semester_id, project_name, title, purpose, requested_by, actual_user, series_id, replaces_id)
    values (p_location, r.kind, 'pending', p_starts, p_ends, v_setup, v_tear, r.schedule_id, r.section_id, r.course_id,
           r.semester_id, r.project_name, r.title, r.purpose, p_by, r.actual_user, r.series_id, r.reservation_id)
    returning reservation_id into v_new;
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'result', 'conflict', 'conflicts', '[]'::jsonb);
  end;
  if p_auto then return jsonb_build_object('ok', true, 'result', 'moved', 'reservation_id', v_new, 'decide', booking_decide(array[v_new], true, p_by, null)); end if;
  return jsonb_build_object('ok', true, 'result', 'move_requested', 'reservation_id', v_new);
end $$;

create or replace function public.booking_cancel(p_ids uuid[], p_by uuid, p_note text default null) returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update room_reservations set status = 'cancelled', pending_change = null, decided_by = p_by, decided_at = now(), decision_note = coalesce(p_note, 'ผู้ขอยกเลิก')
   where reservation_id = any(p_ids) and status in ('pending', 'approved');
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.resv_sync_schedule(uuid) from public, anon, authenticated;
revoke all on function public.booking_request(jsonb) from public, anon, authenticated;
revoke all on function public.booking_decide(uuid[], boolean, uuid, text) from public, anon, authenticated;
revoke all on function public.booking_change(uuid, uuid, timestamptz, timestamptz, int, int, uuid, boolean) from public, anon, authenticated;
revoke all on function public.booking_cancel(uuid[], uuid, text) from public, anon, authenticated;
grant execute on function public.booking_request(jsonb), public.booking_decide(uuid[], boolean, uuid, text),
  public.booking_change(uuid, uuid, timestamptz, timestamptz, int, int, uuid, boolean), public.booking_cancel(uuid[], uuid, text) to service_role;
