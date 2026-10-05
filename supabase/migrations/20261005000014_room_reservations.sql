-- ⚠️ สถานะ: ร่างไว้ ยังไม่ได้ apply กับฐานข้อมูลจริง (5 ต.ค. 2569 — รอผู้ใช้อนุมัติ) ดู docs/plan.md หัวข้อ 4
-- 014 การจองห้อง: "ระบุห้องให้คาบเรียน = จองห้อง"
-- ทุกการใช้ห้อง (คาบเรียน, สอนชดเชย, เตรียมแล็บ, วันอ่านผล, วิจัย, สอบ, กิจกรรม, ปิดซ่อม) เป็นแถวเดียวกันใน room_reservations
-- ฐานข้อมูลบังคับเอง: ห้องเดียวกันมีการจองที่อนุมัติแล้วทับเวลากันไม่ได้ (exclusion constraint)
-- คาบเรียน (schedules) สร้าง/แก้/งด/ลบ → ระบบซิงก์การจองให้เองด้วย trigger — ไม่มีทางที่คาบกับการจองจะไม่ตรงกัน

create extension if not exists btree_gist with schema extensions;

create table if not exists public.room_reservations (
  reservation_id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(location_id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  kind text not null check (kind in ('class','makeup','prep','reading','research','exam','event','maintenance','other')),
  status text not null default 'approved' check (status in ('pending','approved','rejected','cancelled')),
  schedule_id uuid unique references public.schedules(schedule_id) on delete cascade,   -- มีค่า = เป็นคาบเรียน
  section_id uuid references public.lab_sections(section_id) on delete cascade,
  series_id uuid,                      -- การจองซ้ำทุกสัปดาห์ชุดเดียวกัน
  title text,
  purpose text,
  attendees int,
  requested_by uuid references public.users(user_id),
  approved_by uuid references public.users(user_id),
  approved_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  constraint room_no_overlap exclude using gist (
    location_id with =, tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'approved')
);
create index if not exists idx_reservations_loc_time on public.room_reservations (location_id, starts_at);
create index if not exists idx_reservations_series on public.room_reservations (series_id);
create index if not exists idx_reservations_section on public.room_reservations (section_id);

alter table public.room_reservations enable row level security;
create policy "staff read room_reservations" on public.room_reservations for select
  using (exists (select 1 from public.users u where u.user_id = auth.uid() and u.role in ('instructor', 'admin')));
create policy "admin full access room_reservations" on public.room_reservations for all using (public.is_admin());

-- ---------- ซิงก์คาบเรียน → การจอง ----------
create or replace function public.sync_schedule_reservation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
begin
  if tg_op = 'DELETE' then
    return old; -- การจองถูกลบตาม (on delete cascade)
  end if;
  select case when b.booking_type = 'makeup' then 'makeup' else 'class' end into v_kind
    from room_bookings b where b.booking_id = new.booking_id;
  insert into room_reservations (location_id, starts_at, ends_at, kind, status, schedule_id, section_id, requested_by, approved_at, updated_at)
  values (
    new.location_id,
    (new.class_date + new.start_time) at time zone 'Asia/Bangkok',
    (new.class_date + new.end_time) at time zone 'Asia/Bangkok',
    coalesce(v_kind, 'class'),
    case when new.status = 'scheduled' then 'approved' else 'cancelled' end,
    new.schedule_id, new.section_id,
    (select requested_by from room_bookings where booking_id = new.booking_id),
    now(), now()
  )
  on conflict (schedule_id) do update set
    location_id = excluded.location_id, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
    status = excluded.status, section_id = excluded.section_id, updated_at = now();
  return new;
end;
$$;
revoke all on function public.sync_schedule_reservation() from public, anon, authenticated;

drop trigger if exists trg_schedule_reservation on public.schedules;
create trigger trg_schedule_reservation
  after insert or update of class_date, start_time, end_time, location_id, status, section_id on public.schedules
  for each row execute function public.sync_schedule_reservation();

-- คาบที่มีอยู่แล้ว → สร้างการจองย้อนหลัง (ถ้าชนกันอยู่แล้วจะ error ให้แก้ข้อมูลก่อน)
insert into public.room_reservations (location_id, starts_at, ends_at, kind, status, schedule_id, section_id, requested_by, approved_at)
select s.location_id,
       (s.class_date + s.start_time) at time zone 'Asia/Bangkok',
       (s.class_date + s.end_time) at time zone 'Asia/Bangkok',
       case when b.booking_type = 'makeup' then 'makeup' else 'class' end,
       case when s.status = 'scheduled' then 'approved' else 'cancelled' end,
       s.schedule_id, s.section_id, b.requested_by, now()
from public.schedules s
left join public.room_bookings b on b.booking_id = s.booking_id
on conflict (schedule_id) do nothing;

comment on table public.room_reservations is 'การใช้ห้องทุกประเภท — คาบเรียน (schedule_id) ซิงก์จาก schedules อัตโนมัติ, การจองอื่นสร้างผ่าน Edge Function booking';
comment on table public.room_bookings is 'หัวเรื่องของชุดคาบเรียน (1 รายการต่อกลุ่มเรียน/การสอนชดเชย) — การใช้ห้องจริงรายครั้งอยู่ที่ room_reservations';
