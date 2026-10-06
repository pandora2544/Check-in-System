-- ⚠️ ร่าง — ยังไม่ apply กับฐานข้อมูลจริง (6 ต.ค. 2569 · รอผู้ใช้อนุมัติ) · ดู docs/plan.md ส่วนที่ 3 + ภาคผนวก ก
-- 016 จองห้อง: ทุกการใช้ห้องอยู่ในตารางเดียว · ห้องเดียวกันช่วงกันห้องทับกันมีรายการ รออนุมัติ/อนุมัติ ได้รายการเดียว
-- แทนร่าง 014 เดิม (ไม่ได้ apply) · room_bookings เดิมคงไว้เป็นข้อมูลเก่า · schedules.booking_id ไม่บังคับแล้ว
-- ทุกการเขียนผ่านฟังก์ชันในไฟล์นี้ (Edge Function `booking` เรียกด้วย service role และส่ง p_actor)

create extension if not exists btree_gist with schema extensions;

-- ---------- ชุดการจอง (รูปแบบซ้ำ 4 แบบ · 3.4) ----------
create table if not exists public.reservation_series (
  series_id uuid primary key default gen_random_uuid(),
  pattern text not null check (pattern in ('once', 'consecutive', 'weekly', 'custom')),
  rule jsonb not null default '{}'::jsonb,   -- เช่น {"weekdays":[2,4],"every_weeks":1,"until":"2026-12-20","skip_weekends":true}
  kind text,
  section_id uuid references public.lab_sections(section_id) on delete set null,
  course_id uuid references public.courses(course_id) on delete set null,
  title text,
  source text not null default 'manual' check (source in ('manual', 'term_setup', 'migrated')),
  legacy_booking_id uuid references public.room_bookings(booking_id) on delete set null,
  requested_by uuid references public.users(user_id),
  created_at timestamptz not null default now()
);
create index if not exists idx_series_section on public.reservation_series (section_id);

-- ---------- การจองห้อง (3.2) ----------
create table if not exists public.room_reservations (
  reservation_id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(location_id),
  kind text not null check (kind in (
    'class', 'makeup',                 -- คาบเรียน / ชดเชย (สร้างและแก้ผ่านคาบเท่านั้น)
    'prep', 'reading',                 -- เตรียมแล็บ / อ่านผล
    'research', 'project', 'service',  -- วิจัย / โครงงาน / บริการ
    'exam', 'event', 'training',       -- สอบ / กิจกรรม / อบรม
    'maintenance'                      -- ปิดซ่อม ล้าง พ่นยา ติดตั้ง (B7)
  )),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  starts_at timestamptz not null,                          -- เวลาใช้จริง (ตามคาบหรือที่ขอ)
  ends_at timestamptz not null,
  setup_minutes int not null default 0 check (setup_minutes between 0 and 600),
  teardown_minutes int not null default 0 check (teardown_minutes between 0 and 600),
  block tstzrange not null,                                -- ช่วงกันห้อง [เริ่ม − จัด, จบ + เก็บ) ตั้งด้วย trigger
  schedule_id uuid references public.schedules(schedule_id) on delete cascade,  -- คาบ (1 คาบมีได้หลายห้อง)
  section_id uuid references public.lab_sections(section_id) on delete set null,
  course_id uuid references public.courses(course_id) on delete set null,      -- คิดต้นทุนนอกคาบ (B4)
  project_name text,                                                           -- หรือ โครงการ/บริการ
  title text,
  purpose text,
  attendees int,
  requested_by uuid references public.users(user_id),
  used_by_name text,                                       -- ผู้ใช้ห้องจริงเมื่อจองแทน (R1.7)
  self_approved boolean not null default false,            -- R1.4
  decided_by uuid references public.users(user_id),
  decided_at timestamptz,
  decision_note text,
  series_id uuid references public.reservation_series(series_id) on delete set null,
  replaces_id uuid references public.room_reservations(reservation_id) on delete set null,  -- ย้ายห้อง/เวลา (1.4A)
  pending_change jsonb,                                    -- คำขอเปลี่ยนบนรายการเดิม (ห้องเดิม ช่วงทับเดิม)
  actual_hours numeric(6, 2),                              -- ชม.ใช้จริง (ค่าเริ่ม = เวลาจอง · ต้นทุน)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((kind in ('class', 'makeup')) = (schedule_id is not null)),
  check (kind not in ('research', 'project', 'service') or course_id is not null or project_name is not null),
  constraint room_no_overlap exclude using gist (location_id with =, block with &&)
    where (status in ('pending', 'approved'))
);
create unique index if not exists room_reservations_schedule_room on public.room_reservations (schedule_id, location_id)
  where status in ('pending', 'approved');
create index if not exists idx_resv_loc_time on public.room_reservations (location_id, starts_at);
create index if not exists idx_resv_schedule on public.room_reservations (schedule_id);
create index if not exists idx_resv_series on public.room_reservations (series_id);
create index if not exists idx_resv_status on public.room_reservations (status) where status = 'pending' or pending_change is not null;
create index if not exists idx_resv_course on public.room_reservations (course_id);

create or replace function public.room_reservations_block()
returns trigger language plpgsql as $$
begin
  new.block := tstzrange(new.starts_at - make_interval(mins => new.setup_minutes),
                         new.ends_at + make_interval(mins => new.teardown_minutes), '[)');
  new.updated_at := now();
  return new;
end $$;
create trigger trg_resv_block before insert or update of starts_at, ends_at, setup_minutes, teardown_minutes, status, pending_change
  on public.room_reservations for each row execute function public.room_reservations_block();
create trigger trg_audit_room_reservations after insert or update or delete on public.room_reservations
  for each row execute function public.audit_row('reservation_id');

-- บุคลากรทุกคนเห็นทุกห้องและรายละเอียด (B8) · นักศึกษาไม่เห็น · เขียนผ่านฟังก์ชันเท่านั้น
alter table public.room_reservations enable row level security;
alter table public.reservation_series enable row level security;
create policy "staff read room_reservations" on public.room_reservations for select using (public.is_staff());
create policy "admin full access room_reservations" on public.room_reservations for all using (public.is_admin());
create policy "staff read reservation_series" on public.reservation_series for select using (public.is_staff());
create policy "admin full access reservation_series" on public.reservation_series for all using (public.is_admin());

-- ---------- ค่ากำหนดการจองต่อวิชา-เทอม (B6) ----------
create table if not exists public.course_term_settings (
  course_id uuid not null references public.courses(course_id) on delete cascade,
  semester_id uuid not null references public.semesters(semester_id) on delete cascade,
  request_due_days int default 14 check (request_due_days >= 0),   -- null = ไม่กำหนด (ปลายเปิด)
  approve_due_days int default 7 check (approve_due_days >= 0),
  first_class_date date,                                           -- null = คำนวณจากคาบแรก
  source_file_id text,                                             -- ไฟล์ต้นฉบับจากสำนักวิชา (Drive · ระยะ 3)
  updated_by uuid references public.users(user_id),
  updated_at timestamptz not null default now(),
  primary key (course_id, semester_id)
);
alter table public.course_term_settings enable row level security;
create policy "staff read course_term_settings" on public.course_term_settings for select using (public.is_staff());
create policy "admin full access course_term_settings" on public.course_term_settings for all using (public.is_admin());

-- ---------- คาบไม่ต้องผูก room_bookings แล้ว ----------
alter table public.schedules alter column booking_id drop not null;

-- ---------- เหตุผลที่งดคาบ (ใช้ตัดสินว่านับเข้าต้นทุน/ชั่วโมงใช้ห้องหรือไม่) ----------
-- not_needed  = ไม่ต้องเรียนแล้ว            → ไม่นับ
-- postponed   = เลื่อน (มีคาบชดเชย)          → นับที่คาบชดเชย ไม่นับคาบนี้ซ้ำ
-- other_held  = เหตุอื่น แต่เกิดการเรียนจริง  → นับคาบนี้
alter table public.schedules
  add column if not exists cancel_reason text check (cancel_reason in ('not_needed', 'postponed', 'other_held')),
  add column if not exists cancel_note text;
comment on column public.schedules.cancel_reason is 'เหตุผลที่งด — นับต้นทุนเมื่อ status = scheduled หรือ cancel_reason = other_held';

-- ============================================================
-- ฟังก์ชัน
-- ============================================================

create or replace function public.bkk_ts(p_date date, p_time time)
returns timestamptz language sql immutable as $$ select (p_date + p_time) at time zone 'Asia/Bangkok' $$;

create or replace function public.bkk_date(p_ts timestamptz)
returns date language sql immutable as $$ select (p_ts at time zone 'Asia/Bangkok')::date $$;

-- ผู้อนุมัติห้อง ณ วันหนึ่ง: หลัก (ถ้าไม่ตั้ง "ไม่อยู่") · สำรอง (เมื่อหลักไม่อยู่/ไม่มี) · ผู้แทนในช่วง · แอดมินเสมอ (3.5)
create or replace function public.room_approvers(p_location uuid, p_on date)
returns table (user_id uuid, via text, full_name text, phone text, email text, line_id text, telegram_chat_id text)
language sql stable set search_path = public as $$
  with a as (
    select s.user_id, s.kind from staff_assignments s
    where s.location_id = p_location and s.kind in ('room_manager', 'room_backup', 'room_delegate')
      and (s.valid_from is null or s.valid_from <= p_on) and (s.valid_to is null or s.valid_to >= p_on)
  ), mgr_here as (
    select a.user_id from a where a.kind = 'room_manager'
      and not exists (select 1 from user_away w where w.user_id = a.user_id and p_on between w.starts_on and w.ends_on)
  ), pick as (
    select user_id, 'manager' via from mgr_here
    union all
    select a.user_id, 'backup' from a where a.kind = 'room_backup' and not exists (select 1 from mgr_here)
    union all
    select a.user_id, 'delegate' from a where a.kind = 'room_delegate'
    union all
    select u.user_id, 'admin' from users u where u.role = 'admin'
  )
  select distinct on (p.user_id) p.user_id, p.via, u.full_name, u.phone, u.email, u.line_id, u.telegram_chat_id
  from pick p join users u on u.user_id = p.user_id
  order by p.user_id, array_position(array['manager', 'backup', 'delegate', 'admin'], p.via);
$$;

create or replace function public.room_can_approve(p_user uuid, p_location uuid, p_on date)
returns boolean language sql stable set search_path = public as $$
  select exists (select 1 from room_approvers(p_location, p_on) r where r.user_id = p_user);
$$;

-- ผู้ดูแลห้อง (หลัก + สำรอง) พร้อมช่องทางติดต่อ — แสดงทุกครั้งที่ชนหรือรออนุมัติ (A5)
create or replace function public.room_contacts(p_location uuid)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', u.user_id, 'role', s.kind, 'name', u.full_name, 'phone', u.phone,
           'email', u.email, 'line_id', u.line_id, 'telegram', u.telegram_chat_id is not null) order by s.kind desc), '[]'::jsonb)
  from staff_assignments s join users u on u.user_id = s.user_id
  where s.location_id = p_location and s.kind in ('room_manager', 'room_backup');
$$;

-- รายการที่ชน (กันห้องอยู่) + ใครขอ + ช่องทางติดต่อ (R1.8)
create or replace function public.reservation_conflicts(p_location uuid, p_block tstzrange, p_exclude uuid[] default '{}')
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'reservation_id', r.reservation_id, 'kind', r.kind, 'status', r.status,
      'starts_at', r.starts_at, 'ends_at', r.ends_at, 'title', r.title,
      'course_code', c.course_code, 'section_no', ls.section_no, 'project_name', r.project_name,
      'requested_by', jsonb_build_object('user_id', u.user_id, 'name', u.full_name, 'phone', u.phone, 'email', u.email, 'line_id', u.line_id)
    ) order by r.starts_at), '[]'::jsonb)
  from room_reservations r
  left join lab_sections ls on ls.section_id = r.section_id
  left join courses c on c.course_id = coalesce(r.course_id, ls.course_id)
  left join users u on u.user_id = r.requested_by
  where r.location_id = p_location and r.status in ('pending', 'approved')
    and r.block && p_block and r.reservation_id <> all (p_exclude);
$$;

-- คาบเรียนตามการจองที่อนุมัติ (ย้ายห้อง/เวลาสำเร็จ) — ห้องหลักของคาบ = schedules.location_id
create or replace function public._apply_reservation_to_schedule(p_res public.room_reservations, p_old_location uuid)
returns void language plpgsql set search_path = public as $$
begin
  if p_res.schedule_id is null then return; end if;
  perform set_config('app.skip_schedule_sync', 'on', true);
  update schedules s set
    class_date = bkk_date(p_res.starts_at),
    start_time = (p_res.starts_at at time zone 'Asia/Bangkok')::time,
    end_time   = (p_res.ends_at at time zone 'Asia/Bangkok')::time,
    location_id = case when s.location_id = p_old_location then p_res.location_id else s.location_id end
  where s.schedule_id = p_res.schedule_id;
  -- ห้องอื่นของคาบเดียวกันเลื่อนเวลาตาม (คงห้องเดิม) — ถ้าชนจะ error ทั้ง transaction
  update room_reservations o set starts_at = p_res.starts_at, ends_at = p_res.ends_at
  where o.schedule_id = p_res.schedule_id and o.reservation_id <> p_res.reservation_id
    and o.status in ('pending', 'approved') and (o.starts_at, o.ends_at) is distinct from (p_res.starts_at, p_res.ends_at);
  perform set_config('app.skip_schedule_sync', 'off', true);
end $$;

-- แทรกหนึ่งรายการ (ใช้ภายใน) — คืน {ok, reservation_id, status} หรือ {ok:false, conflicts, room_contacts}
create or replace function public._reservation_insert(p_actor uuid, p_item jsonb, p_series uuid, p_replaces uuid, p_override boolean)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_loc locations;
  v_starts timestamptz := (p_item ->> 'starts_at')::timestamptz;
  v_ends timestamptz := (p_item ->> 'ends_at')::timestamptz;
  v_setup int;
  v_tear int;
  v_block tstzrange;
  v_conf jsonb;
  v_can boolean;
  v_id uuid;
  v_status text;
  v_section uuid := (p_item ->> 'section_id')::uuid;
  v_schedule uuid := (p_item ->> 'schedule_id')::uuid;
begin
  select * into v_loc from locations where location_id = (p_item ->> 'location_id')::uuid for update;  -- ล็อกห้อง: คิวทีละคำขอ
  if not found then return jsonb_build_object('ok', false, 'error', 'ROOM_NOT_FOUND'); end if;
  if v_loc.room_status <> 'active' or not v_loc.bookable then
    return jsonb_build_object('ok', false, 'error', 'ROOM_NOT_BOOKABLE');
  end if;
  if v_starts is null or v_ends is null or v_ends <= v_starts then
    return jsonb_build_object('ok', false, 'error', 'BAD_TIME');
  end if;
  if v_schedule is not null and v_section is null then
    select section_id into v_section from schedules where schedule_id = v_schedule;
  end if;
  v_setup := coalesce((p_item ->> 'setup_minutes')::int, v_loc.setup_minutes);
  v_tear := coalesce((p_item ->> 'teardown_minutes')::int, v_loc.teardown_minutes);
  v_block := tstzrange(v_starts - make_interval(mins => v_setup), v_ends + make_interval(mins => v_tear), '[)');
  v_can := room_can_approve(p_actor, v_loc.location_id, bkk_date(v_starts));

  v_conf := reservation_conflicts(v_loc.location_id, v_block, case when p_replaces is null then '{}'::uuid[] else array[p_replaces] end);
  if jsonb_array_length(v_conf) > 0 then
    -- R1.9 ผู้ดูแลห้องแทรกได้เฉพาะเมื่อทุกรายการที่ชนยัง "รออนุมัติ"
    if p_override and v_can and not exists (select 1 from jsonb_array_elements(v_conf) e where e ->> 'status' = 'approved') then
      update room_reservations set status = 'rejected', decided_by = p_actor, decided_at = now(),
        decision_note = 'ผู้ดูแลห้องใช้ช่วงนี้' || coalesce(' — ' || nullif(p_item ->> 'override_note', ''), '')
      where reservation_id in (select (e ->> 'reservation_id')::uuid from jsonb_array_elements(v_conf) e);
    else
      return jsonb_build_object('ok', false, 'error', 'CONFLICT', 'conflicts', v_conf,
                                'can_override', v_can and not exists (select 1 from jsonb_array_elements(v_conf) e where e ->> 'status' = 'approved'),
                                'room_contacts', room_contacts(v_loc.location_id));
    end if;
  end if;

  v_status := case when v_can then 'approved' else 'pending' end;
  begin
    insert into room_reservations (location_id, kind, status, starts_at, ends_at, setup_minutes, teardown_minutes, block,
      schedule_id, section_id, course_id, project_name, title, purpose, attendees, requested_by, used_by_name,
      self_approved, decided_by, decided_at, series_id, replaces_id)
    values (v_loc.location_id, p_item ->> 'kind', v_status, v_starts, v_ends, v_setup, v_tear, v_block,
      v_schedule, v_section,
      coalesce((p_item ->> 'course_id')::uuid, (select course_id from lab_sections where section_id = v_section)),
      nullif(p_item ->> 'project_name', ''), nullif(p_item ->> 'title', ''), nullif(p_item ->> 'purpose', ''),
      (p_item ->> 'attendees')::int, p_actor, nullif(p_item ->> 'used_by_name', ''),
      v_can, case when v_can then p_actor end, case when v_can then now() end, p_series, p_replaces)
    returning reservation_id into v_id;
  exception when exclusion_violation or unique_violation then
    return jsonb_build_object('ok', false, 'error', 'CONFLICT',
      'conflicts', reservation_conflicts(v_loc.location_id, v_block, case when p_replaces is null then '{}'::uuid[] else array[p_replaces] end),
      'room_contacts', room_contacts(v_loc.location_id));
  end;
  return jsonb_build_object('ok', true, 'reservation_id', v_id, 'status', v_status);
end $$;

-- ขอจอง (รายการเดียวหรือทั้งชุด) — ครั้งที่ชนไม่ถูกบันทึก ไม่ทำให้ทั้งชุดล้ม (3.4)
-- p_items: [{location_id, kind, starts_at, ends_at, setup_minutes?, teardown_minutes?, schedule_id?, section_id?, course_id?,
--            project_name?, title?, purpose?, attendees?, used_by_name?, override_note?}, ...]
-- p_series: null หรือ {pattern, rule, kind, section_id, course_id, title, source}
create or replace function public.booking_request(p_actor uuid, p_items jsonb, p_series jsonb default null, p_override boolean default false)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_series uuid;
  v_item jsonb;
  v_idx int := 0;
  v_res jsonb;
  v_created jsonb := '[]'::jsonb;
  v_failed jsonb := '[]'::jsonb;
begin
  perform set_config('app.actor', p_actor::text, true);
  if p_series is not null and jsonb_array_length(p_items) > 0 then
    insert into reservation_series (pattern, rule, kind, section_id, course_id, title, source, requested_by)
    values (coalesce(p_series ->> 'pattern', 'custom'), coalesce(p_series -> 'rule', '{}'::jsonb), p_series ->> 'kind',
            (p_series ->> 'section_id')::uuid, (p_series ->> 'course_id')::uuid, p_series ->> 'title',
            coalesce(p_series ->> 'source', 'manual'), p_actor)
    returning series_id into v_series;
  end if;
  for v_item in select * from jsonb_array_elements(p_items) loop
    v_res := _reservation_insert(p_actor, v_item, v_series, null, p_override) || jsonb_build_object('index', v_idx);
    if (v_res ->> 'ok')::boolean then v_created := v_created || v_res; else v_failed := v_failed || v_res; end if;
    v_idx := v_idx + 1;
  end loop;
  if v_series is not null and jsonb_array_length(v_created) = 0 then
    delete from reservation_series where series_id = v_series;
    v_series := null;
  end if;
  return jsonb_build_object('series_id', v_series, 'created', v_created, 'failed', v_failed);
end $$;

-- อนุมัติ/ปฏิเสธ (รายการ หรือทั้งชุดโดยส่ง id ทุกครั้ง) — ใช้ได้ทั้งคำขอใหม่ คำขอย้าย และคำขอเปลี่ยน
create or replace function public.booking_decide(p_actor uuid, p_ids uuid[], p_approve boolean, p_note text default null)
returns jsonb language plpgsql set search_path = public as $$
declare
  r room_reservations;
  v_old room_reservations;
  v_new_starts timestamptz;
  v_new_ends timestamptz;
  v_done jsonb := '[]'::jsonb;
  v_skip jsonb := '[]'::jsonb;
begin
  perform set_config('app.actor', p_actor::text, true);
  for r in select * from room_reservations where reservation_id = any (p_ids) order by starts_at for update loop
    if not room_can_approve(p_actor, r.location_id, bkk_date(r.starts_at)) then
      v_skip := v_skip || jsonb_build_object('reservation_id', r.reservation_id, 'reason', 'NOT_APPROVER'); continue;
    end if;

    if r.status = 'approved' and r.pending_change is not null then
      -- คำขอเปลี่ยนบนรายการเดิม
      if p_approve then
        v_new_starts := (r.pending_change ->> 'starts_at')::timestamptz;
        v_new_ends := (r.pending_change ->> 'ends_at')::timestamptz;
        begin
          update room_reservations set starts_at = v_new_starts, ends_at = v_new_ends,
            setup_minutes = coalesce((pending_change ->> 'setup_minutes')::int, setup_minutes),
            teardown_minutes = coalesce((pending_change ->> 'teardown_minutes')::int, teardown_minutes),
            pending_change = null, decided_by = p_actor, decided_at = now(), decision_note = p_note
          where reservation_id = r.reservation_id returning * into r;
          perform _apply_reservation_to_schedule(r, r.location_id);
        exception when exclusion_violation then
          v_skip := v_skip || jsonb_build_object('reservation_id', r.reservation_id, 'reason', 'CONFLICT'); continue;
        end;
      else
        update room_reservations set pending_change = null, decided_by = p_actor, decided_at = now(), decision_note = p_note
        where reservation_id = r.reservation_id;
      end if;

    elsif r.status = 'pending' then
      if p_approve then
        update room_reservations set status = 'approved', decided_by = p_actor, decided_at = now(), decision_note = p_note
        where reservation_id = r.reservation_id returning * into r;
        if r.replaces_id is not null then
          -- ย้ายสำเร็จ → ยกเลิกรายการเดิม แล้วย้ายคาบตาม (1.4A)
          select * into v_old from room_reservations where reservation_id = r.replaces_id;
          update room_reservations set status = 'cancelled', decided_by = p_actor, decided_at = now(),
            decision_note = 'ย้ายไปรายการใหม่', pending_change = null
          where reservation_id = r.replaces_id and status in ('pending', 'approved');
          perform _apply_reservation_to_schedule(r, coalesce(v_old.location_id, r.location_id));
        end if;
      else
        update room_reservations set status = 'rejected', decided_by = p_actor, decided_at = now(), decision_note = p_note
        where reservation_id = r.reservation_id;
      end if;
    else
      v_skip := v_skip || jsonb_build_object('reservation_id', r.reservation_id, 'reason', 'NOT_PENDING'); continue;
    end if;
    v_done := v_done || jsonb_build_object('reservation_id', r.reservation_id, 'requested_by', r.requested_by);
  end loop;
  return jsonb_build_object('done', v_done, 'skipped', v_skip);
end $$;

-- ย้าย/แก้เวลา (3.3 ข้อ 6 · 1.4A) — การจองเดิมคงอยู่จนอนุมัติ
create or replace function public.booking_change(p_actor uuid, p_id uuid, p_location uuid, p_starts timestamptz, p_ends timestamptz,
  p_setup int default null, p_teardown int default null, p_note text default null)
returns jsonb language plpgsql set search_path = public as $$
declare
  r room_reservations;
  v_setup int;
  v_tear int;
  v_block tstzrange;
  v_conf jsonb;
  v_can boolean;
  v_res jsonb;
  v_new room_reservations;
begin
  perform set_config('app.actor', p_actor::text, true);
  select * into r from room_reservations where reservation_id = p_id for update;
  if not found or r.status not in ('pending', 'approved') then
    return jsonb_build_object('ok', false, 'error', 'NOT_ACTIVE');
  end if;
  if p_ends <= p_starts then return jsonb_build_object('ok', false, 'error', 'BAD_TIME'); end if;
  v_setup := coalesce(p_setup, r.setup_minutes);
  v_tear := coalesce(p_teardown, r.teardown_minutes);
  v_block := tstzrange(p_starts - make_interval(mins => v_setup), p_ends + make_interval(mins => v_tear), '[)');
  v_can := room_can_approve(p_actor, p_location, bkk_date(p_starts));

  if p_location = r.location_id and v_block && r.block then
    -- ห้องเดิม ช่วงใหม่ทับช่วงเดิม → ตรวจชนโดยไม่นับตัวเอง
    perform 1 from locations where location_id = p_location for update;
    v_conf := reservation_conflicts(p_location, v_block, array[r.reservation_id]);
    if jsonb_array_length(v_conf) > 0 then
      return jsonb_build_object('ok', false, 'error', 'CONFLICT', 'conflicts', v_conf, 'room_contacts', room_contacts(p_location));
    end if;
    if r.status = 'pending' or v_can then
      update room_reservations set starts_at = p_starts, ends_at = p_ends, setup_minutes = v_setup, teardown_minutes = v_tear,
        pending_change = null,
        decided_by = case when r.status = 'approved' then p_actor else decided_by end,
        decided_at = case when r.status = 'approved' then now() else decided_at end
      where reservation_id = r.reservation_id returning * into r;
      if r.status = 'approved' then perform _apply_reservation_to_schedule(r, r.location_id); end if;
      return jsonb_build_object('ok', true, 'mode', 'applied', 'reservation_id', r.reservation_id);
    end if;
    update room_reservations set pending_change = jsonb_build_object('starts_at', p_starts, 'ends_at', p_ends,
        'setup_minutes', v_setup, 'teardown_minutes', v_tear, 'requested_by', p_actor, 'requested_at', now(), 'note', p_note)
    where reservation_id = r.reservation_id;
    return jsonb_build_object('ok', true, 'mode', 'pending_change', 'reservation_id', r.reservation_id);
  end if;

  -- ห้องใหม่ หรือช่วงไม่ทับ → รายการใหม่ "แทนรายการเดิม"
  v_res := _reservation_insert(p_actor, jsonb_build_object(
      'location_id', p_location, 'kind', r.kind, 'starts_at', p_starts, 'ends_at', p_ends,
      'setup_minutes', v_setup, 'teardown_minutes', v_tear, 'schedule_id', r.schedule_id, 'section_id', r.section_id,
      'course_id', r.course_id, 'project_name', r.project_name, 'title', r.title, 'purpose', coalesce(p_note, r.purpose),
      'attendees', r.attendees, 'used_by_name', r.used_by_name),
    r.series_id, r.reservation_id, false);
  if not (v_res ->> 'ok')::boolean then return v_res; end if;

  if (v_res ->> 'status') = 'approved' or r.status = 'pending' then
    -- อนุมัติทันที (R1.4) หรือของเดิมยังไม่ได้อนุมัติ → ยกเลิกของเดิมเลย
    update room_reservations set status = 'cancelled', decision_note = 'ย้ายไปรายการใหม่', pending_change = null
    where reservation_id = r.reservation_id;
    select * into v_new from room_reservations where reservation_id = (v_res ->> 'reservation_id')::uuid;
    if v_new.status = 'approved' then perform _apply_reservation_to_schedule(v_new, r.location_id); end if;
  end if;
  return v_res || jsonb_build_object('mode', 'replacement', 'replaces_id', r.reservation_id);
end $$;

-- ยกเลิก (ครั้งนี้ / ครั้งนี้และถัดไป / ทั้งชุด — Edge Function เลือก id ให้)
create or replace function public.booking_cancel(p_actor uuid, p_ids uuid[], p_note text default null)
returns jsonb language plpgsql set search_path = public as $$
declare v_ids uuid[];
begin
  perform set_config('app.actor', p_actor::text, true);
  with u as (
    update room_reservations set status = 'cancelled', pending_change = null, decided_by = p_actor, decided_at = now(),
      decision_note = coalesce(p_note, 'ผู้ขอยกเลิก')
    where reservation_id = any (p_ids) and status in ('pending', 'approved')
    returning reservation_id
  ) select array_agg(reservation_id) into v_ids from u;
  -- คำขอย้ายที่ค้างอยู่ของรายการที่ยกเลิก ก็ยกเลิกตาม
  update room_reservations set status = 'cancelled', decision_note = 'รายการเดิมถูกยกเลิก'
  where replaces_id = any (coalesce(v_ids, '{}')) and status = 'pending';
  return jsonb_build_object('cancelled', coalesce(to_jsonb(v_ids), '[]'::jsonb));
end $$;

-- ---------- คาบ → การจอง (ทางเดิมของโค้ดตั้งค่าเทอม + งดคาบ 1.4C) ----------
-- ฟังก์ชันจองข้างบนแก้คาบเองโดยตั้ง app.skip_schedule_sync = on
create or replace function public.sync_schedule_reservation()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_actor uuid;
  v_kind text;
  v_res jsonb;
begin
  if coalesce(current_setting('app.skip_schedule_sync', true), 'off') = 'on' then return new; end if;

  if tg_op = 'UPDATE' and new.status = 'cancelled' and old.status <> 'cancelled' then
    update room_reservations set status = 'cancelled', pending_change = null, decision_note = 'คาบถูกงด'
    where schedule_id = new.schedule_id and status in ('pending', 'approved');
    update room_reservations set status = 'cancelled', decision_note = 'คาบถูกงด'
    where replaces_id in (select reservation_id from room_reservations where schedule_id = new.schedule_id) and status = 'pending';
    return new;
  end if;

  if tg_op = 'UPDATE' and new.status = 'scheduled' and old.status = 'scheduled'
     and exists (select 1 from room_reservations where schedule_id = new.schedule_id and status in ('pending', 'approved')) then
    -- แก้วัน/เวลา/ห้องตรงที่คาบ (ทางเดิม) → เลื่อนการจองทันที ชน = error ทั้งคำสั่ง (ห้องชนบล็อก)
    update room_reservations set
      starts_at = bkk_ts(new.class_date, new.start_time), ends_at = bkk_ts(new.class_date, new.end_time),
      location_id = case when location_id = old.location_id then new.location_id else location_id end,
      section_id = new.section_id
    where schedule_id = new.schedule_id and status in ('pending', 'approved');
    return new;
  end if;

  if new.status <> 'scheduled' then return new; end if;
  -- สร้างคาบใหม่ / ยกเลิกงด → ขอห้องหลักของคาบ
  v_actor := coalesce(nullif(current_setting('app.actor', true), '')::uuid, auth.uid(),
                      (select requested_by from room_bookings where booking_id = new.booking_id));
  select case when b.booking_type = 'makeup' then 'makeup' else 'class' end into v_kind from room_bookings b where b.booking_id = new.booking_id;
  v_res := _reservation_insert(v_actor, jsonb_build_object(
      'location_id', new.location_id, 'kind', coalesce(v_kind, 'class'),
      'starts_at', bkk_ts(new.class_date, new.start_time), 'ends_at', bkk_ts(new.class_date, new.end_time),
      'schedule_id', new.schedule_id, 'section_id', new.section_id), null, null, false);
  -- ห้องไม่ว่าง → คาบยังบันทึกได้ (คาบ/บทคงอยู่ทุกเทอม แต่ห้องต้องจองใหม่) · คาบนี้ขึ้นเป็น "ยังไม่มีห้อง"
  -- ในแดชบอร์ดต้นเทอม/ความพร้อม ให้ผู้ตั้งรายวิชาขอห้องอื่น (rooms_free) หรือเจรจากับผู้จองเดิม
  return new;
end $$;
revoke all on function public.sync_schedule_reservation() from public, anon, authenticated;

drop trigger if exists trg_schedule_reservation on public.schedules;
create trigger trg_schedule_reservation
  after insert or update of class_date, start_time, end_time, location_id, status, section_id on public.schedules
  for each row execute function public.sync_schedule_reservation();

-- ---------- แดชบอร์ดการจองต้นเทอม (3.6) ----------
create or replace function public.booking_term_dashboard(p_semester uuid)
returns table (course_id uuid, course_code text, course_name text, first_class date, request_due date, approve_due date,
               sessions int, no_request int, pending int, approved int)
language sql stable set search_path = public as $$
  with sch as (
    select s.schedule_id, s.class_date, ls.course_id from schedules s
    join lab_sections ls on ls.section_id = s.section_id
    where ls.semester_id = p_semester and s.status = 'scheduled'
  ), st as (
    select sch.course_id, sch.schedule_id,
      bool_or(r.status = 'pending') has_pending, bool_or(r.status = 'approved') has_approved, count(r.*) n
    from sch left join room_reservations r on r.schedule_id = sch.schedule_id and r.status in ('pending', 'approved')
    where sch.class_date >= (now() at time zone 'Asia/Bangkok')::date   -- นับเฉพาะคาบที่ยังไม่ถึง
    group by sch.course_id, sch.schedule_id
  )
  select c.course_id, c.course_code, c.course_name,
    coalesce(cts.first_class_date, min(sch.class_date)) first_class,
    coalesce(cts.first_class_date, min(sch.class_date)) - coalesce(cts.request_due_days, case when cts.course_id is null then 14 end),
    coalesce(cts.first_class_date, min(sch.class_date)) - coalesce(cts.approve_due_days, case when cts.course_id is null then 7 end),
    count(distinct sch.schedule_id)::int,
    (select count(*) from st where st.course_id = c.course_id and st.n = 0)::int,
    (select count(*) from st where st.course_id = c.course_id and st.has_pending)::int,
    (select count(*) from st where st.course_id = c.course_id and st.has_approved and not st.has_pending)::int
  from sch join courses c on c.course_id = sch.course_id
  left join course_term_settings cts on cts.course_id = c.course_id and cts.semester_id = p_semester
  group by c.course_id, c.course_code, c.course_name, cts.course_id, cts.first_class_date, cts.request_due_days, cts.approve_due_days
  order by 5 nulls last, 2;
$$;

-- ห้องที่ว่างทั้งช่วง (แนะนำเมื่อคาบหลายห้องอนุมัติไม่ครบ B5 · หน้าขอจอง)
create or replace function public.rooms_free(p_starts timestamptz, p_ends timestamptz, p_zone uuid default null)
returns table (location_id uuid, name text, room_code text, zone_id uuid)
language sql stable set search_path = public as $$
  select l.location_id, l.name, l.room_code, l.zone_id from locations l
  where l.room_status = 'active' and l.bookable and (p_zone is null or l.zone_id = p_zone)
    and not exists (select 1 from room_reservations r where r.location_id = l.location_id and r.status in ('pending', 'approved')
                    and r.block && tstzrange(p_starts - make_interval(mins => l.setup_minutes), p_ends + make_interval(mins => l.teardown_minutes), '[)'))
  order by l.zone_id nulls last, l.name;
$$;

-- ทุกฟังก์ชันจองเรียกได้เฉพาะ service role (Edge Function ตรวจสิทธิ์ผู้ใช้ก่อน)
do $$
declare f text;
begin
  foreach f in array array[
    'public.bkk_ts(date, time)', 'public.bkk_date(timestamptz)',
    'public.room_approvers(uuid, date)', 'public.room_can_approve(uuid, uuid, date)', 'public.room_contacts(uuid)',
    'public.reservation_conflicts(uuid, tstzrange, uuid[])',
    'public._apply_reservation_to_schedule(public.room_reservations, uuid)',
    'public._reservation_insert(uuid, jsonb, uuid, uuid, boolean)',
    'public.booking_request(uuid, jsonb, jsonb, boolean)', 'public.booking_decide(uuid, uuid[], boolean, text)',
    'public.booking_change(uuid, uuid, uuid, timestamptz, timestamptz, int, int, text)',
    'public.booking_cancel(uuid, uuid[], text)', 'public.booking_term_dashboard(uuid)',
    'public.rooms_free(timestamptz, timestamptz, uuid)',
    'public.room_reservations_block()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ============================================================
-- ย้ายข้อมูลเดิม: คาบที่เกิดการเรียน (ผ่านไปแล้ว) และคาบที่ยังไม่ถึง → การจองอนุมัติแล้ว
-- คาบที่งดไปแล้ว (ข้อมูลเดิมไม่มีเหตุผล) ไม่สร้างการจอง — ภายหลังเจ้าหน้าที่ระบุเหตุผลย้อนหลังได้ ถ้าเป็น other_held จะนับต้นทุน
-- ============================================================
insert into public.reservation_series (pattern, rule, kind, section_id, course_id, title, source, legacy_booking_id, requested_by)
select 'weekly', jsonb_build_object('legacy_recurrence', b.recurrence_rule),
       case when b.booking_type = 'makeup' then 'makeup' else 'class' end,
       b.section_id, ls.course_id, b.purpose, 'migrated', b.booking_id, b.requested_by
from public.room_bookings b join public.lab_sections ls on ls.section_id = b.section_id
where exists (select 1 from public.schedules s where s.booking_id = b.booking_id and s.status = 'scheduled');

insert into public.room_reservations (location_id, kind, status, starts_at, ends_at, block, schedule_id, section_id, course_id,
  requested_by, decided_by, decided_at, decision_note, series_id)
select s.location_id,
       case when b.booking_type = 'makeup' then 'makeup' else 'class' end, 'approved',
       public.bkk_ts(s.class_date, s.start_time), public.bkk_ts(s.class_date, s.end_time),
       tstzrange(public.bkk_ts(s.class_date, s.start_time), public.bkk_ts(s.class_date, s.end_time), '[)'),
       s.schedule_id, s.section_id, ls.course_id, b.requested_by, b.approved_by, now(), 'ย้ายจากระบบเดิม', rs.series_id
from public.schedules s
join public.lab_sections ls on ls.section_id = s.section_id
left join public.room_bookings b on b.booking_id = s.booking_id
left join public.reservation_series rs on rs.legacy_booking_id = s.booking_id
where s.status = 'scheduled';

-- ชม.ใช้ห้องจริงของคาบที่ผ่านไปแล้ว = เวลาคาบ (แก้ได้ภายหลัง)
update public.room_reservations set actual_hours = round(extract(epoch from (ends_at - starts_at)) / 3600.0, 2)
where schedule_id is not null and ends_at < now() and actual_hours is null;

comment on table public.room_reservations is 'การใช้ห้องทุกประเภท — คาบเรียน/ชดเชย (schedule_id) สร้างผ่านคาบ · อื่นๆ ผ่าน booking_request · ฐานข้อมูลกันจองทับ (room_no_overlap)';
comment on table public.room_bookings is 'ข้อมูลเก่า (ก่อน 016) — ใช้ reservation_series + room_reservations แทน';
