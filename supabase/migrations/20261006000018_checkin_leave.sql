-- ⚠️ ร่าง — ยังไม่ apply กับฐานข้อมูลจริง (6 ต.ค. 2569 · รอผู้ใช้อนุมัติ) · ดู docs/plan.md ภาคผนวก ก.2 (018)
-- 018 Check-in: สถานะยืนยันตัวตน · ห้องที่เช็คชื่อ (คาบหลายห้อง A10) · คำขอลา → อนุมัติ = ลา (excused) · แจ้งเตือนชนิดใหม่

-- ---------- นักศึกษา: ยืนยันตัวตน (ลงทะเบียนหน้าแล้วรอเจ้าหน้าที่ยืนยัน) ----------
alter table public.students
  add column if not exists identity_status text not null default 'verified'
    check (identity_status in ('pending', 'verified', 'rejected')),   -- ของเดิมทั้งหมด = verified · enroll ใหม่ตั้ง pending
  add column if not exists verified_by uuid references public.users(user_id),
  add column if not exists verified_at timestamptz;
create index if not exists idx_students_identity_pending on public.students (identity_status) where identity_status = 'pending';

-- ---------- การเข้าเรียน: เช็คที่ห้องไหน ----------
alter table public.attendance_records
  add column if not exists location_id uuid references public.locations(location_id);
comment on column public.attendance_records.location_id is 'ห้องที่สแกนเช็คชื่อ (คาบมีได้หลายห้อง) · null = เช็คแทน/ข้อมูลเดิม';

-- ---------- คำขอลา ----------
create table if not exists public.leave_requests (
  request_id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.schedules(schedule_id) on delete cascade,
  student_id uuid not null references public.students(student_id) on delete cascade,
  submitted_via text not null check (submitted_via in ('student', 'instructor')),  -- นักศึกษาขอเอง (สแกนหน้ายืนยัน) / ผู้สอนบันทึกแทน
  requested_by uuid references public.users(user_id),
  reason text not null check (char_length(reason) between 1 and 500),
  attachment_file_id text,                     -- ใบรับรองแพทย์ ฯลฯ — อัปโหลดจริงระยะ 3 (Drive · DEC-042)
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references public.users(user_id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create unique index if not exists leave_requests_one_active on public.leave_requests (schedule_id, student_id)
  where status in ('pending', 'approved');
create index if not exists idx_leave_requests_pending on public.leave_requests (schedule_id) where status = 'pending';
create trigger trg_audit_leave_requests after insert or update or delete on public.leave_requests
  for each row execute function public.audit_row('request_id');

alter table public.leave_requests enable row level security;
create policy "own leave_requests" on public.leave_requests for select using (student_id = auth.uid());
create policy "instructor read leave_requests" on public.leave_requests for select using (
  exists (select 1 from public.schedules s join public.staff_assignments a on a.section_id = s.section_id and a.kind = 'instructor'
          where s.schedule_id = leave_requests.schedule_id and a.user_id = auth.uid()));
create policy "admin full access leave_requests" on public.leave_requests for all using (public.is_admin());

-- อาจารย์ผู้สอนของ Section เป็นผู้อนุมัติ (แอดมินได้เสมอ) · อนุมัติ → การเข้าเรียน = ลา · ปฏิเสธ → ไม่แตะการเข้าเรียน
create or replace function public.leave_decide(p_actor uuid, p_request uuid, p_approve boolean, p_note text default null)
returns jsonb language plpgsql set search_path = public as $$
declare r leave_requests;
begin
  perform set_config('app.actor', p_actor::text, true);
  if not exists (select 1 from leave_requests q join schedules s on s.schedule_id = q.schedule_id
                 where q.request_id = p_request and user_teaches_section(p_actor, s.section_id)) then
    return jsonb_build_object('ok', false, 'error', 'NOT_INSTRUCTOR');
  end if;
  update leave_requests set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = p_actor, decided_at = now(), decision_note = p_note
  where request_id = p_request and status = 'pending' returning * into r;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); end if;
  if p_approve then
    insert into attendance_records (student_id, schedule_id, status, is_manual, marked_by, marked_at, note)
    values (r.student_id, r.schedule_id, 'excused', true, p_actor, now(), left('ลา: ' || r.reason, 300))
    on conflict (student_id, schedule_id) do update set status = 'excused', is_manual = true,
      marked_by = excluded.marked_by, marked_at = excluded.marked_at,
      note = coalesce(attendance_records.note, excluded.note);
  end if;
  return jsonb_build_object('ok', true, 'request_id', r.request_id, 'status', r.status, 'student_id', r.student_id);
end $$;
revoke all on function public.leave_decide(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.leave_decide(uuid, uuid, boolean, text) to service_role;

-- ---------- แจ้งเตือนชนิดใหม่ ----------
alter table public.notification_logs drop constraint notification_logs_notification_type_check;
alter table public.notification_logs add constraint notification_logs_notification_type_check
  check (notification_type = any (array[
    'mid_class_15min', 'end_of_class', 'auto_absent', 'roster_ready', 'class_reminder',
    'booking_submitted', 'booking_approved', 'booking_rejected', 'booking_change', 'booking_cancelled',
    'booking_overridden', 'booking_due', 'booking_partial',
    'session_cancelled', 'session_moved', 'task_assigned', 'task_handover', 'task_needs_cover',
    'leave_submitted', 'leave_decided', 'identity_pending', 'owner_request', 'room_move_request', 'room_move_response']));
alter table public.notification_logs
  add column if not exists reservation_id uuid references public.room_reservations(reservation_id) on delete set null;
