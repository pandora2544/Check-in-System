-- ระยะ 1 · กติกาสิทธิ์ระยะ 1 (ตกลงกับผู้ใช้ 6 ต.ค. 2569 15:14–15:36) — ต่อจาก 20261006062435_booking_functions ที่ลงแล้ว
-- • ผู้ขอใช้เป็นผู้ยกเลิก/ย้ายการจองของตน · เจ้าของห้องอนุมัติ/ปฏิเสธ และ "ขอให้ย้าย" ได้ แต่บังคับยกเลิก/ย้ายไม่ได้
-- • รายวิชามีผู้ประสานหลัก (course_owner) + ผู้ประสานรอง (course_backup): หลักอยู่ → หลัก · หลักไม่อยู่ → รอง · ไม่อยู่ทั้งคู่ → ติดต่อด่วนทั้งคู่
-- • ห้องใช้กติกาเดียวกัน (ผู้ดูแลหลัก/สำรอง ไม่อยู่ทั้งคู่ → ติดต่อด่วนทั้งคู่)
-- • บันทึกการแก้ไข (ใคร เมื่อไร ค่าก่อน/หลัง) · เหตุผลงดคาบ · ชม.ใช้ห้องของคาบที่ผ่านแล้ว · สร้างคาบไม่ล้มเมื่อห้องชน
-- • แอดมิน (ผู้พัฒนาระบบ) ทำได้ทุกอย่าง

create or replace function public.is_staff()
returns boolean language sql stable as $$
  select exists (select 1 from public.users where user_id = auth.uid() and role in ('instructor', 'admin'));
$$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated, service_role;

-- ชม.ใช้ห้องของคาบที่ผ่านไปแล้วและเกิดการเรียน = เวลาคาบ (แก้ได้ภายหลัง) — ทำก่อนเปิดบันทึกการแก้ไข
update public.room_reservations set used_hours = round(extract(epoch from (ends_at - starts_at)) / 3600.0, 2)
where status = 'approved' and ends_at < now() and used_hours is null;

-- ============================================================
-- บันทึกการแก้ไข
-- ============================================================
create table if not exists public.audit_log (
  audit_id bigint generated always as identity primary key,
  table_name text not null,
  row_id text not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  actor uuid,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create index if not exists idx_audit_row on public.audit_log (table_name, row_id, at desc);
create index if not exists idx_audit_actor on public.audit_log (actor, at desc);
alter table public.audit_log enable row level security;
create policy "admin read audit_log" on public.audit_log for select using (public.is_admin());

-- ผู้ทำ: Edge Function ตั้ง set_config('app.actor', <user_id>, true) · ฟังก์ชันที่รับ p_by ตั้งให้เอง
create or replace function public.audit_row()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_pk text := tg_argv[0];
  v_actor uuid := nullif(current_setting('app.actor', true), '')::uuid;
begin
  if tg_op = 'UPDATE' and to_jsonb(old) = to_jsonb(new) then return new; end if;
  insert into audit_log (table_name, row_id, action, actor, before, after)
  values (tg_table_name, coalesce(to_jsonb(new) ->> v_pk, to_jsonb(old) ->> v_pk), lower(tg_op), coalesce(v_actor, auth.uid()),
          case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return coalesce(new, old);
end $$;
revoke all on function public.audit_row() from public, anon, authenticated;

-- ผู้ทำจากพารามิเตอร์ p_by (ฟังก์ชันจองเดิม) — trigger อ่าน decided_by/requested_by แทนเมื่อไม่มี app.actor
create or replace function public.audit_resv()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if nullif(current_setting('app.actor', true), '') is null then
    perform set_config('app.actor', coalesce(new.decided_by, new.requested_by, old.decided_by)::text, true);
    perform audit_row_inner(tg_op, to_jsonb(old), to_jsonb(new));
    perform set_config('app.actor', '', true);
  else
    perform audit_row_inner(tg_op, to_jsonb(old), to_jsonb(new));
  end if;
  return coalesce(new, old);
end $$;
create or replace function public.audit_row_inner(p_op text, p_old jsonb, p_new jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_op = 'UPDATE' and p_old = p_new then return; end if;
  insert into audit_log (table_name, row_id, action, actor, before, after)
  values ('room_reservations', coalesce(p_new ->> 'reservation_id', p_old ->> 'reservation_id'), lower(p_op),
          coalesce(nullif(current_setting('app.actor', true), '')::uuid, auth.uid()),
          case when p_op <> 'INSERT' then p_old end, case when p_op <> 'DELETE' then p_new end);
end $$;
revoke all on function public.audit_resv(), public.audit_row_inner(text, jsonb, jsonb) from public, anon, authenticated;

create trigger trg_audit_staff_assignments after insert or update or delete on public.staff_assignments
  for each row execute function public.audit_row('assignment_id');
create trigger trg_audit_schedules after insert or update or delete on public.schedules
  for each row execute function public.audit_row('schedule_id');
create trigger trg_audit_room_reservations after insert or update or delete on public.room_reservations
  for each row execute function public.audit_resv();

-- ============================================================
-- ผู้ประสานรายวิชา หลัก/รอง
-- ============================================================
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
create unique index if not exists uq_course_primary on public.staff_assignments (course_id, semester_id) where kind = 'course_owner';
create unique index if not exists uq_course_backup on public.staff_assignments (course_id, semester_id) where kind = 'course_backup';

create or replace function public.user_is_away(p_user uuid, p_on date)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from user_away w where w.user_id = p_user and p_on between w.from_date and w.to_date);
$$;

-- ใครต้องตัดสินเรื่องของรายวิชา ณ วันหนึ่ง: หลัก → รอง (หลักไม่อยู่) → ทั้งคู่แบบด่วน (ไม่อยู่ทั้งคู่)
create or replace function public.course_coordinators(p_course uuid, p_semester uuid, p_on date default (now() at time zone 'Asia/Bangkok')::date)
returns table (user_id uuid, role text, urgent boolean)
language sql stable set search_path = public as $$
  with p as (select a.user_id from staff_assignments a where a.kind = 'course_owner' and a.course_id = p_course and a.semester_id = p_semester),
       b as (select a.user_id from staff_assignments a where a.kind = 'course_backup' and a.course_id = p_course and a.semester_id = p_semester),
       st as (select (select bool_or(not user_is_away(user_id, p_on)) from p) p_here,
                     (select bool_or(not user_is_away(user_id, p_on)) from b) b_here)
  select p.user_id, 'primary', not coalesce(st.b_here, false) and not coalesce(st.p_here, false) from p, st
   where coalesce(st.p_here, false) or not coalesce(st.b_here, false)
  union all
  select b.user_id, 'backup', not coalesce(st.p_here, false) and not coalesce(st.b_here, false) from b, st
   where not coalesce(st.p_here, false);
$$;

-- ห้อง: กติกาเดียวกัน + ผู้แทนชั่วคราวในช่วงวันที่ (แอดมินอนุมัติได้เสมอ แต่ไม่อยู่ในรายการแจ้ง)
create or replace function public.room_approvers(p_location uuid, p_on date)
returns table (user_id uuid, role text, urgent boolean)
language sql stable set search_path = public as $$
  with p as (select a.user_id from staff_assignments a where a.kind = 'room_manager' and a.location_id = p_location),
       b as (select a.user_id from staff_assignments a where a.kind = 'room_backup' and a.location_id = p_location),
       st as (select (select bool_or(not user_is_away(user_id, p_on)) from p) p_here,
                     (select bool_or(not user_is_away(user_id, p_on)) from b) b_here)
  select p.user_id, 'manager', not coalesce(st.b_here, false) and not coalesce(st.p_here, false) from p, st
   where coalesce(st.p_here, false) or not coalesce(st.b_here, false)
  union all
  select b.user_id, 'backup', not coalesce(st.p_here, false) and not coalesce(st.b_here, false) from b, st
   where not coalesce(st.p_here, false)
  union all
  select a.user_id, 'delegate', false from staff_assignments a
   where a.kind = 'room_delegate' and a.location_id = p_location and p_on between a.valid_from and a.valid_to;
$$;

create or replace function public.user_is_admin(p_user uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from users where user_id = p_user and role = 'admin');
$$;

create or replace function public.room_can_approve(p_user uuid, p_location uuid, p_on date)
returns boolean language sql stable set search_path = public as $$
  select user_is_admin(p_user) or exists (select 1 from room_approvers(p_location, p_on) r where r.user_id = p_user);
$$;

-- จัดการรายวิชา (คาบ เลื่อน/งด บท งานมอบหมาย): หลักเสมอ · รองเมื่อหลักไม่อยู่ (หรือไม่อยู่ทั้งคู่) · แอดมิน
create or replace function public.user_manages_course(p_user uuid, p_course uuid, p_semester uuid, p_on date default (now() at time zone 'Asia/Bangkok')::date)
returns boolean language sql stable set search_path = public as $$
  select user_is_admin(p_user)
      or exists (select 1 from staff_assignments a where a.user_id = p_user and a.kind = 'course_owner' and a.course_id = p_course and a.semester_id = p_semester)
      or exists (select 1 from course_coordinators(p_course, p_semester, p_on) c where c.user_id = p_user);
$$;

create or replace function public.user_teaches_section(p_user uuid, p_section uuid)
returns boolean language sql stable set search_path = public as $$
  select user_is_admin(p_user) or exists (select 1 from staff_assignments a where a.user_id = p_user and a.kind = 'instructor' and a.section_id = p_section);
$$;

-- ผู้ควบคุมการจอง = ผู้ขอใช้ · คาบเรียน = ผู้ประสานรายวิชา · แอดมิน
create or replace function public.user_controls_reservation(p_user uuid, p_res public.room_reservations)
returns boolean language sql stable set search_path = public as $$
  select user_is_admin(p_user) or p_res.requested_by = p_user
      or (p_res.schedule_id is not null and p_res.course_id is not null and user_manages_course(p_user, p_res.course_id, p_res.semester_id));
$$;

-- ============================================================
-- เจ้าของห้องขอให้ย้าย (ไม่บังคับ — ผู้ขอใช้ตัดสิน เพราะเคยอนุมัติแล้ว)
-- ============================================================
create table if not exists public.room_move_requests (
  move_request_id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.room_reservations(reservation_id) on delete cascade,
  requested_by uuid not null references public.users(user_id),
  reason text not null check (char_length(reason) between 1 and 500),
  urgent boolean not null default false,
  suggestion jsonb,                                  -- {location_id, starts_at, ends_at} ที่เสนอ
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  responded_by uuid references public.users(user_id),
  responded_at timestamptz,
  response_note text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_move_request_pending on public.room_move_requests (reservation_id) where status = 'pending';
alter table public.room_move_requests enable row level security;
create policy "staff read room_move_requests" on public.room_move_requests for select using (public.is_staff());
create policy "admin full access room_move_requests" on public.room_move_requests for all using (public.is_admin());
create trigger trg_audit_room_move_requests after insert or update or delete on public.room_move_requests
  for each row execute function public.audit_row('move_request_id');

create or replace function public.room_move_request(p_by uuid, p_reservation uuid, p_reason text, p_urgent boolean default false, p_suggestion jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r room_reservations; v_id uuid;
begin
  perform set_config('app.actor', p_by::text, true);
  select * into r from room_reservations where reservation_id = p_reservation and status in ('pending', 'approved');
  if not found then return jsonb_build_object('ok', false, 'result', 'not_active'); end if;
  if not room_can_approve(p_by, r.location_id, (r.starts_at at time zone 'Asia/Bangkok')::date) then
    return jsonb_build_object('ok', false, 'result', 'not_room_owner');
  end if;
  insert into room_move_requests (reservation_id, requested_by, reason, urgent, suggestion)
  values (r.reservation_id, p_by, p_reason, p_urgent, p_suggestion) returning move_request_id into v_id;
  return jsonb_build_object('ok', true, 'move_request_id', v_id, 'notify', r.requested_by, 'course_id', r.course_id, 'semester_id', r.semester_id);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'result', 'already_requested');
end $$;

create or replace function public.room_move_respond(p_by uuid, p_move_request uuid, p_accept boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m room_move_requests; r room_reservations;
begin
  perform set_config('app.actor', p_by::text, true);
  select * into m from room_move_requests where move_request_id = p_move_request and status = 'pending' for update;
  if not found then return jsonb_build_object('ok', false, 'result', 'not_pending'); end if;
  select * into r from room_reservations where reservation_id = m.reservation_id;
  if not user_controls_reservation(p_by, r) then return jsonb_build_object('ok', false, 'result', 'not_requester'); end if;
  update room_move_requests set status = case when p_accept then 'accepted' else 'declined' end,
    responded_by = p_by, responded_at = now(), response_note = p_note
  where move_request_id = m.move_request_id;
  return jsonb_build_object('ok', true, 'notify', m.requested_by, 'reservation_id', r.reservation_id);
end $$;

-- ============================================================
-- คาบ: เหตุผลงด · ชม.ใช้ห้องของคาบที่ผ่านแล้ว
-- ============================================================
-- not_needed = ไม่ต้องเรียนแล้ว (ไม่นับ) · postponed = เลื่อน (นับที่คาบชดเชย) · other_held = เหตุอื่นแต่เกิดการเรียน (นับคาบนี้)
alter table public.schedules alter column booking_id drop not null;   -- คาบไม่ต้องผูก room_bookings เดิมแล้ว
alter table public.schedules
  add column if not exists cancel_reason text check (cancel_reason in ('not_needed', 'postponed', 'other_held')),
  add column if not exists cancel_note text;
comment on column public.schedules.cancel_reason is 'นับต้นทุน/ชม.ห้องเมื่อ status = scheduled หรือ cancel_reason = other_held';


-- ============================================================
-- ฟังก์ชันเดิมที่แก้ (สร้างคาบไม่ล้มเมื่อห้องชน · ย้าย/ยกเลิกได้เฉพาะผู้ขอใช้)
-- ============================================================
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
  -- ห้องชน → คาบยังบันทึกได้ (คาบ/บทคงอยู่ทุกเทอม แต่ห้องต้องจองใหม่) · คาบขึ้นเป็น "ยังไม่มีห้อง" ในแดชบอร์ด/ความพร้อม
  begin
    insert into room_reservations (location_id, kind, status, starts_at, ends_at, setup_minutes, teardown_minutes, schedule_id, section_id, course_id, semester_id, requested_by)
    values (new.location_id, v_kind, 'pending', v_start, v_end, coalesce(v_setup, 0), coalesce(v_tear, 0), new.schedule_id, new.section_id, v_course, v_sem, v_req);
  exception when exclusion_violation then
    null;
  end;
  return new;
end $$;

create or replace function public.booking_change(p_id uuid, p_location uuid, p_starts timestamptz, p_ends timestamptz,
  p_setup int, p_teardown int, p_by uuid, p_auto boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r room_reservations; v_block tstzrange; v_ids uuid[]; v_new uuid; v_setup int; v_tear int;
begin
  select * into r from room_reservations where reservation_id = p_id for update;
  if r.reservation_id is null or r.status not in ('pending', 'approved') then return jsonb_build_object('ok', false, 'result', 'not_active'); end if;
  -- ผู้ขอใช้เป็นผู้ย้ายการจองของตน (คาบเรียน = ผู้ประสานรายวิชา) · เจ้าของห้องใช้ "ขอให้ย้าย" แทน
  if not user_controls_reservation(p_by, r) then return jsonb_build_object('ok', false, 'result', 'not_requester'); end if;
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
   where reservation_id = any(p_ids) and status in ('pending', 'approved')
     and user_controls_reservation(p_by, room_reservations);   -- ผู้ขอใช้ยกเลิกเอง · เจ้าของห้องยกเลิกของคนอื่นไม่ได้
  get diagnostics n = row_count;
  return n;
end $$;

-- ============================================================
-- ห้องว่าง + แดชบอร์ดการจองต้นเทอม
-- ============================================================
create or replace function public.rooms_free(p_starts timestamptz, p_ends timestamptz, p_zone uuid default null)
returns table (location_id uuid, name text, room_code text, zone_id uuid)
language sql stable set search_path = public as $$
  select l.location_id, l.name, l.room_code, l.zone_id from locations l
  where l.room_status = 'active' and (p_zone is null or l.zone_id = p_zone)
    and not exists (select 1 from room_reservations r where r.location_id = l.location_id and r.status in ('pending', 'approved')
                    and r.block && tstzrange(p_starts - make_interval(mins => l.setup_minutes), p_ends + make_interval(mins => l.teardown_minutes), '[)'))
  order by l.zone_id nulls last, l.name;
$$;

-- นับเฉพาะคาบที่ยังไม่ถึง: ยังไม่มีห้อง / รออนุมัติ / อนุมัติครบ
create or replace function public.booking_term_dashboard(p_semester uuid)
returns table (course_id uuid, course_code text, course_name text, first_class date, request_due date, approve_due date,
               sessions int, no_room int, pending int, approved int)
language sql stable set search_path = public as $$
  with sch as (
    select s.schedule_id, s.class_date, ls.course_id from schedules s
    join lab_sections ls on ls.section_id = s.section_id
    where ls.semester_id = p_semester and s.status = 'scheduled'
  ), st as (
    select sch.course_id, sch.schedule_id,
      bool_or(r.status = 'pending') has_pending, bool_or(r.status = 'approved') has_approved, count(r.reservation_id) n
    from sch left join room_reservations r on r.schedule_id = sch.schedule_id and r.status in ('pending', 'approved')
    where sch.class_date >= (now() at time zone 'Asia/Bangkok')::date
    group by sch.course_id, sch.schedule_id
  )
  select c.course_id, c.course_code, c.course_name,
    coalesce(cts.first_class_date, min(sch.class_date)),
    coalesce(cts.first_class_date, min(sch.class_date)) - case when cts.course_id is null then 14 else cts.request_lead_days end,
    coalesce(cts.first_class_date, min(sch.class_date)) - case when cts.course_id is null then 7 else cts.approve_lead_days end,
    count(distinct sch.schedule_id)::int,
    (select count(*) from st where st.course_id = c.course_id and st.n = 0)::int,
    (select count(*) from st where st.course_id = c.course_id and st.has_pending)::int,
    (select count(*) from st where st.course_id = c.course_id and st.has_approved and not st.has_pending)::int
  from sch join courses c on c.course_id = sch.course_id
  left join course_term_settings cts on cts.course_id = c.course_id and cts.semester_id = p_semester
  group by c.course_id, c.course_code, c.course_name, cts.course_id, cts.first_class_date, cts.request_lead_days, cts.approve_lead_days
  order by 5 nulls last, 2;
$$;

-- ============================================================
-- คาบหลายบท (รวมแล็บ) · schedules.topic_id = บทแรก ให้โค้ดเดิม/Telegram ทำงาน
-- ============================================================
alter table public.lab_sections add column if not exists expected_students int check (expected_students >= 0);
alter table public.lab_topics
  add column if not exists setup_minutes int check (setup_minutes between 0 and 600),
  add column if not exists teardown_minutes int check (teardown_minutes between 0 and 600);

create table if not exists public.session_topics (
  schedule_id uuid not null references public.schedules(schedule_id) on delete cascade,
  topic_id uuid not null references public.lab_topics(topic_id) on delete cascade,
  seq smallint not null default 1,
  time_share numeric(5, 2),
  primary key (schedule_id, topic_id)
);
create index if not exists idx_session_topics_topic on public.session_topics (topic_id);
insert into public.session_topics (schedule_id, topic_id, seq)
select schedule_id, topic_id, 1 from public.schedules where topic_id is not null on conflict do nothing;

create or replace function public.sync_first_topic()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_sid uuid := coalesce(new.schedule_id, old.schedule_id);
begin
  if pg_trigger_depth() > 1 then return null; end if;
  update schedules set topic_id = (select topic_id from session_topics where schedule_id = v_sid order by seq, topic_id limit 1)
  where schedule_id = v_sid;
  return null;
end $$;
create trigger trg_session_topics_first after insert or update or delete on public.session_topics
  for each row execute function public.sync_first_topic();

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

-- ============================================================
-- สิ่งที่ต้องเตรียมต่อบท (นักวิทย์ตั้งเอง) + ตารางงาน (ผู้ใช้สร้าง/แก้เอง)
-- ============================================================
create table if not exists public.topic_task_rules (
  rule_id uuid primary key default gen_random_uuid(),
  topic_id uuid not null references public.lab_topics(topic_id) on delete cascade,
  task_type text not null check (task_type in ('prep', 'supervise', 'reading', 'cleanup', 'other')),
  title text,
  offset_days int not null default 0,
  start_time time,
  duration_hours numeric(5, 2),
  needs_room boolean not null default false,
  default_assignee uuid references public.users(user_id) on delete set null,
  note text,
  sort_order int not null default 0,
  created_by uuid references public.users(user_id),
  created_at timestamptz not null default now()
);
create index if not exists idx_task_rules_topic on public.topic_task_rules (topic_id);

create table if not exists public.tasks (
  task_id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('rule', 'manual', 'general', 'personal')),
  rule_id uuid references public.topic_task_rules(rule_id) on delete set null,
  schedule_id uuid references public.schedules(schedule_id) on delete cascade,
  course_id uuid references public.courses(course_id) on delete cascade,
  semester_id uuid references public.semesters(semester_id) on delete cascade,
  task_type text not null check (task_type in ('prep', 'supervise', 'reading', 'cleanup', 'other')),
  title text not null,
  assignee_id uuid references public.users(user_id) on delete set null,
  task_date date not null,
  start_time time,
  duration_hours numeric(5, 2),
  status text not null default 'todo' check (status in ('todo', 'done', 'cancelled')),
  actual_hours numeric(5, 2),
  manually_edited boolean not null default false,
  is_private boolean not null default false,
  reservation_id uuid references public.room_reservations(reservation_id) on delete set null,
  handed_over_from uuid references public.users(user_id) on delete set null,
  done_by uuid references public.users(user_id),
  done_at timestamptz,
  note text,
  created_by uuid references public.users(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source in ('general', 'personal') or course_id is not null)
);
create unique index if not exists uq_tasks_rule_schedule on public.tasks (rule_id, schedule_id) where rule_id is not null;
create index if not exists idx_tasks_assignee_date on public.tasks (assignee_id, task_date);
create index if not exists idx_tasks_schedule on public.tasks (schedule_id);
create trigger trg_audit_tasks after insert or update or delete on public.tasks
  for each row execute function public.audit_row('task_id');

create or replace function public.sync_schedule_tasks()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    update tasks set status = 'cancelled', updated_at = now() where schedule_id = new.schedule_id and status = 'todo';
  elsif new.class_date <> old.class_date then
    update tasks t set task_date = new.class_date + r.offset_days, updated_at = now()
    from topic_task_rules r
    where t.rule_id = r.rule_id and t.schedule_id = new.schedule_id and t.status = 'todo' and not t.manually_edited;
  end if;
  return new;
end $$;
create trigger trg_schedule_tasks after update of class_date, status on public.schedules
  for each row execute function public.sync_schedule_tasks();

-- กด "สร้างงานจากสิ่งที่ต้องเตรียม" ให้คาบที่เลือก (ไม่สร้างซ้ำ) — ผู้ใช้แก้ต่อได้
create or replace function public.generate_rule_tasks(p_schedule_ids uuid[], p_by uuid default null)
returns int language sql security definer set search_path = public as $$
  with ins as (
    insert into tasks (source, rule_id, schedule_id, course_id, semester_id, task_type, title, assignee_id, task_date, start_time, duration_hours, created_by)
    select 'rule', r.rule_id, s.schedule_id, ls.course_id, ls.semester_id, r.task_type,
      coalesce(r.title, case r.task_type when 'prep' then 'เตรียมแล็บ' when 'supervise' then 'คุมแล็บ' when 'reading' then 'อ่านผล'
                                         when 'cleanup' then 'เก็บแล็บ' else 'งาน' end) || ' · ' || t.title_th,
      coalesce(r.default_assignee, (select a.user_id from staff_assignments a where a.course_id = ls.course_id and a.semester_id = ls.semester_id
                                     and a.kind in ('lab_staff', 'lab_worker') order by a.kind, a.created_at limit 1), p_by),
      s.class_date + r.offset_days, coalesce(r.start_time, case when r.offset_days = 0 then s.start_time end), r.duration_hours, p_by
    from schedules s
    join lab_sections ls on ls.section_id = s.section_id
    join session_topics st on st.schedule_id = s.schedule_id
    join lab_topics t on t.topic_id = st.topic_id
    join topic_task_rules r on r.topic_id = st.topic_id
    where s.schedule_id = any (p_schedule_ids) and s.status = 'scheduled'
    on conflict do nothing
    returning 1
  ) select count(*)::int from ins;
$$;

create table if not exists public.staff_leaves (
  leave_id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(user_id) on delete cascade,
  from_date date not null,
  to_date date not null check (to_date >= from_date),
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_staff_leaves_user on public.staff_leaves (user_id, from_date);

create table if not exists public.room_items (
  item_id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(location_id) on delete cascade,
  description text not null,
  position text,
  course_id uuid references public.courses(course_id) on delete set null,
  schedule_id uuid references public.schedules(schedule_id) on delete set null,
  reuse_schedule_id uuid references public.schedules(schedule_id) on delete set null,
  reuse_at timestamptz,
  movable text not null default 'no' check (movable in ('no', 'temporary')),
  contact_user_id uuid references public.users(user_id) on delete set null,
  contact_note text,
  status text not null default 'active' check (status in ('active', 'closed')),
  created_by uuid references public.users(user_id),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists idx_room_items_loc on public.room_items (location_id) where status = 'active';

create table if not exists public.readiness_checks (
  schedule_id uuid not null references public.schedules(schedule_id) on delete cascade,
  check_key text not null check (check_key in ('rooms', 'topic', 'roster', 'worksheet', 'materials', 'equipment', 'room_items')),
  checked_by uuid not null references public.users(user_id),
  checked_at timestamptz not null default now(),
  note text,
  primary key (schedule_id, check_key)
);

create or replace function public.schedule_readiness(p_schedule_ids uuid[])
returns table (schedule_id uuid, rooms_ok boolean, rooms_pending int, topic_ok boolean, roster_ok boolean, checks jsonb)
language sql stable set search_path = public as $$
  select s.schedule_id,
    exists (select 1 from room_reservations r where r.schedule_id = s.schedule_id and r.status = 'approved')
      and not exists (select 1 from room_reservations r where r.schedule_id = s.schedule_id and r.status = 'pending'),
    (select count(*)::int from room_reservations r where r.schedule_id = s.schedule_id and r.status = 'pending'),
    exists (select 1 from session_topics t where t.schedule_id = s.schedule_id),
    exists (select 1 from section_enrollments e where e.section_id = s.section_id),
    coalesce((select jsonb_object_agg(c.check_key, jsonb_build_object('by', c.checked_by, 'at', c.checked_at, 'note', c.note))
              from readiness_checks c where c.schedule_id = s.schedule_id), '{}'::jsonb)
  from schedules s where s.schedule_id = any (p_schedule_ids);
$$;

-- ปฏิทินของฉัน (แบบ Google Calendar): ค่าเริ่มเห็นเฉพาะของตัวเอง · เลือกซ้อนของคนอื่น/ห้อง/วิชาได้
alter table public.users add column if not exists calendar_settings jsonb not null default '{"show": "mine"}'::jsonb;
comment on column public.users.calendar_settings is '{"show":"mine"|"selected"|"all","people":[],"rooms":[],"courses":[],"layers":["sessions","tasks","bookings","holidays","leaves"]}';

-- ============================================================
-- Check-in: ยืนยันตัวตน · ห้องที่เช็ค · คำขอลา (อาจารย์ผู้สอนอนุมัติ)
-- ============================================================
alter table public.students
  add column if not exists identity_status text not null default 'verified' check (identity_status in ('pending', 'verified', 'rejected')),
  add column if not exists verified_by uuid references public.users(user_id),
  add column if not exists verified_at timestamptz;
create index if not exists idx_students_identity_pending on public.students (identity_status) where identity_status = 'pending';

alter table public.attendance_records add column if not exists location_id uuid references public.locations(location_id);

create table if not exists public.leave_requests (
  request_id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.schedules(schedule_id) on delete cascade,
  student_id uuid not null references public.students(student_id) on delete cascade,
  submitted_via text not null check (submitted_via in ('student', 'instructor')),
  requested_by uuid references public.users(user_id),
  reason text not null check (char_length(reason) between 1 and 500),
  attachment_file_id text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references public.users(user_id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_leave_active on public.leave_requests (schedule_id, student_id) where status in ('pending', 'approved');
create trigger trg_audit_leave_requests after insert or update or delete on public.leave_requests
  for each row execute function public.audit_row('request_id');

create or replace function public.leave_decide(p_by uuid, p_request uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r leave_requests;
begin
  perform set_config('app.actor', p_by::text, true);
  if not exists (select 1 from leave_requests q join schedules s on s.schedule_id = q.schedule_id
                 where q.request_id = p_request and user_teaches_section(p_by, s.section_id)) then
    return jsonb_build_object('ok', false, 'result', 'not_instructor');
  end if;
  update leave_requests set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = p_by, decided_at = now(), decision_note = p_note
  where request_id = p_request and status = 'pending' returning * into r;
  if not found then return jsonb_build_object('ok', false, 'result', 'not_pending'); end if;
  if p_approve then
    insert into attendance_records (student_id, schedule_id, status, is_manual, marked_by, marked_at, note)
    values (r.student_id, r.schedule_id, 'excused', true, p_by, now(), left('ลา: ' || r.reason, 300))
    on conflict (student_id, schedule_id) do update set status = 'excused', is_manual = true,
      marked_by = excluded.marked_by, marked_at = excluded.marked_at, note = coalesce(attendance_records.note, excluded.note);
  end if;
  return jsonb_build_object('ok', true, 'status', r.status, 'student_id', r.student_id);
end $$;

alter table public.notification_logs drop constraint notification_logs_notification_type_check;
alter table public.notification_logs add constraint notification_logs_notification_type_check
  check (notification_type = any (array[
    'mid_class_15min', 'end_of_class', 'auto_absent', 'roster_ready', 'class_reminder',
    'booking_submitted', 'booking_approved', 'booking_rejected', 'booking_change', 'booking_cancelled', 'booking_overridden',
    'booking_due', 'booking_partial', 'room_move_request', 'room_move_response',
    'session_cancelled', 'session_moved', 'task_assigned', 'task_handover', 'task_needs_cover',
    'leave_submitted', 'leave_decided', 'identity_pending', 'owner_request', 'urgent_contact']));
alter table public.notification_logs add column if not exists reservation_id uuid references public.room_reservations(reservation_id) on delete set null;

-- ============================================================
-- RLS: ผู้ใช้เห็นข้อมูลกลาง + ของตนเอง · แอดมินเห็นทั้งหมด · เขียนผ่าน Edge Function
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['session_topics', 'topic_task_rules', 'staff_leaves', 'room_items', 'readiness_checks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "staff read %s" on public.%I for select using (public.is_staff())', t, t);
    execute format('create policy "admin full access %s" on public.%I for all using (public.is_admin())', t, t);
  end loop;
end $$;
alter table public.tasks enable row level security;
create policy "own tasks" on public.tasks for select using (assignee_id = auth.uid() or created_by = auth.uid());
create policy "staff read shared tasks" on public.tasks for select using (public.is_staff() and not is_private);
create policy "admin full access tasks" on public.tasks for all using (public.is_admin());
create policy "student read own session_topics" on public.session_topics for select using (
  exists (select 1 from public.schedules s join public.section_enrollments e on e.section_id = s.section_id
          where s.schedule_id = session_topics.schedule_id and e.student_id = auth.uid()));
alter table public.leave_requests enable row level security;
create policy "own leave_requests" on public.leave_requests for select using (student_id = auth.uid());
create policy "instructor read leave_requests" on public.leave_requests for select using (
  exists (select 1 from public.schedules s join public.staff_assignments a on a.section_id = s.section_id and a.kind = 'instructor'
          where s.schedule_id = leave_requests.schedule_id and a.user_id = auth.uid()));
create policy "admin full access leave_requests" on public.leave_requests for all using (public.is_admin());

-- ฟังก์ชันทั้งหมดเรียกได้เฉพาะ service role
do $$
declare f text;
begin
  foreach f in array array[
    'public.user_is_away(uuid, date)', 'public.course_coordinators(uuid, uuid, date)', 'public.room_approvers(uuid, date)',
    'public.user_is_admin(uuid)', 'public.room_can_approve(uuid, uuid, date)', 'public.user_manages_course(uuid, uuid, uuid, date)',
    'public.user_teaches_section(uuid, uuid)', 'public.user_controls_reservation(uuid, public.room_reservations)',
    'public.room_move_request(uuid, uuid, text, boolean, jsonb)', 'public.room_move_respond(uuid, uuid, boolean, text)',
    'public.rooms_free(timestamptz, timestamptz, uuid)', 'public.booking_term_dashboard(uuid)',
    'public.generate_rule_tasks(uuid[], uuid)', 'public.schedule_readiness(uuid[])', 'public.leave_decide(uuid, uuid, boolean, text)',
    'public.sync_first_topic()', 'public.sync_topic_to_session()', 'public.sync_schedule_tasks()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    if f not like '%sync_%' then execute format('grant execute on function %s to service_role', f); end if;
  end loop;
end $$;
