-- ============================================================
-- ระบบเช็คชื่อเข้าเรียนแล็บ — Supabase / PostgreSQL Schema
-- อ้างอิงจาก lab-attendance-system-design.md (หัวข้อ 3)
-- วิธีใช้: วางทั้งไฟล์นี้ใน Supabase Dashboard → SQL Editor → Run
-- (รันครั้งเดียวตอนตั้งโปรเจกต์ใหม่)
--
-- หมายเหตุ: Presence Tracking (presence_logs, required_stay_minutes ฯลฯ)
-- ถูกตัดออกจาก scope ปัจจุบันแล้วตามที่ตัดสินใจไว้ — ไม่มีในไฟล์นี้
-- ดูหัวข้อ 8 ของเอกสารออกแบบถ้าต้องการเพิ่มกลับมาภายหลัง
-- ============================================================

create extension if not exists pgcrypto; -- สำหรับ gen_random_uuid() (Supabase เปิดให้โดยปกติอยู่แล้ว)

-- ============================================================
-- 3.1 ผู้ใช้งานและนักศึกษา
-- ============================================================

-- ผูกกับ auth.users ของ Supabase Auth โดยตรง (id เดียวกัน) — ไม่เก็บ password เอง
create table public.users (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text unique,
  role        text not null check (role in ('student','instructor','admin')),
  full_name   text not null,
  phone       text,
  created_at  timestamptz not null default now()
);
comment on table public.users is 'บัญชีผู้ใช้ทุกบทบาท ผูกกับ Supabase Auth โดยตรง (ไม่มีล็อกอินแยกสำหรับนักศึกษาระหว่างเช็คชื่อ — ใช้แค่ตอนลงทะเบียนครั้งแรก)';

create table public.students (
  student_id    uuid primary key references public.users(user_id) on delete cascade,
  student_code  text unique not null,
  major_id      uuid,
  year_level    int,
  status        text not null default 'active' check (status in ('active','graduated','leave'))
);

create table public.face_templates (
  template_id       uuid primary key default gen_random_uuid(),
  student_id        uuid not null references public.students(student_id) on delete cascade,
  embedding_vector  text not null, -- JSON array ของตัวเลข เช่น "[0.12,-0.05,...]" — ห้ามเก็บภาพใบหน้าดิบ
  model_version     text not null,
  enrolled_at       timestamptz not null default now(),
  device_info       text
);
comment on table public.face_templates is 'ข้อมูลชีวมาตร — sensitive personal data ตาม PDPA ต้องมี consent ก่อนบันทึกและนโยบายลบเมื่อพ้นสภาพนักศึกษา';
create index idx_face_templates_student on public.face_templates(student_id);

-- ============================================================
-- 3.2 วิชา / เทอม / กลุ่มเรียน
-- ============================================================

create table public.courses (
  course_id    uuid primary key default gen_random_uuid(),
  course_code  text unique not null,
  course_name  text not null,
  credit       int
);

create table public.semesters (
  semester_id    uuid primary key default gen_random_uuid(),
  academic_year  text not null,
  term           text not null check (term in ('1','2','summer')),
  start_date     date not null,
  end_date       date not null
);

create table public.lab_sections (
  section_id              uuid primary key default gen_random_uuid(),
  course_id               uuid not null references public.courses(course_id),
  semester_id             uuid not null references public.semesters(semester_id),
  section_no              text not null,
  instructor_id           uuid references public.users(user_id),
  max_students            int,
  late_threshold_minutes  int not null default 15
);
comment on column public.lab_sections.late_threshold_minutes is 'ช่วงเวลาที่ยังไม่นับสายหลังคาบเริ่ม (นาที) ใช้ตัดสินปกติ/สาย และจังหวะแจ้งเตือน LINE';
create index idx_lab_sections_semester on public.lab_sections(semester_id);
create index idx_lab_sections_instructor on public.lab_sections(instructor_id);

create table public.section_enrollments (
  enrollment_id  uuid primary key default gen_random_uuid(),
  section_id     uuid not null references public.lab_sections(section_id) on delete cascade,
  student_id     uuid not null references public.students(student_id) on delete cascade,
  enrolled_at    timestamptz not null default now(),
  unique (section_id, student_id)
);
create index idx_enrollments_student on public.section_enrollments(student_id);

-- ============================================================
-- 3.3 ตารางเรียนและพื้นที่
-- ============================================================

create table public.locations (
  location_id    uuid primary key default gen_random_uuid(),
  name           text not null,
  building       text,
  floor          text,
  latitude       double precision not null,
  longitude      double precision not null,
  radius_meters  int not null default 30
);
comment on table public.locations is 'พื้นที่ที่อนุญาตให้สแกน — QR ต่อห้องคือ URL ที่ encode location_id นี้ตรงๆ ไม่ต้องมี field เพิ่ม';

create table public.room_bookings (
  booking_id       uuid primary key default gen_random_uuid(),
  location_id      uuid not null references public.locations(location_id),
  booking_type     text not null check (booking_type in ('class_schedule','makeup')),
  section_id       uuid not null references public.lab_sections(section_id),
  requested_by     uuid not null references public.users(user_id),
  purpose          text,
  start_datetime   timestamptz not null,
  end_datetime     timestamptz not null,
  recurrence_rule  text,
  status           text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  approved_by      uuid references public.users(user_id),
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  check (end_datetime > start_datetime)
);
comment on table public.room_bookings is 'อาจารย์เจ้าของแล็บอนุมัติเอง ไม่ผ่านแอดมินกลาง (ดู lab-attendance-system-design.md 4.5)';
create index idx_bookings_location_time on public.room_bookings(location_id, start_datetime, end_datetime);
create index idx_bookings_section on public.room_bookings(section_id);

create table public.schedules (
  schedule_id  uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references public.room_bookings(booking_id) on delete cascade,
  section_id   uuid not null references public.lab_sections(section_id),
  location_id  uuid not null references public.locations(location_id),
  class_date   date not null,
  start_time   time not null,
  end_time     time not null,
  status       text not null default 'scheduled' check (status in ('scheduled','cancelled'))
);
comment on table public.schedules is 'Generate อัตโนมัติจาก room_bookings ที่อนุมัติแล้ว — 1 booking รายสัปดาห์ = หลายแถวที่นี่';
create index idx_schedules_section_date on public.schedules(section_id, class_date);
create index idx_schedules_location_date on public.schedules(location_id, class_date);

-- ============================================================
-- 3.4 การเช็คชื่อและรายงาน
-- ============================================================

create table public.attendance_records (
  attendance_id           uuid primary key default gen_random_uuid(),
  student_id              uuid not null references public.students(student_id),
  schedule_id             uuid not null references public.schedules(schedule_id),
  check_in_time           timestamptz not null default now(),
  check_in_lat            double precision,
  check_in_lng            double precision,
  distance_from_location  double precision,
  face_match_score        double precision,
  status                  text not null check (status in ('present','late','absent','excused')),
  device_id               text,
  created_at              timestamptz not null default now(),
  unique (student_id, schedule_id) -- กันเช็คชื่อซ้ำคาบเดียวกัน
);
create index idx_attendance_schedule on public.attendance_records(schedule_id);
create index idx_attendance_student on public.attendance_records(student_id);

create table public.line_channels (
  line_channel_id  uuid primary key default gen_random_uuid(),
  section_id       uuid not null references public.lab_sections(section_id),
  line_group_id    text not null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);
comment on table public.line_channels is 'ต้องใช้ LINE OA บัญชีใหม่แยกเฉพาะระบบนี้ ห้ามใช้บัญชีเดิมของคณะ/มหาวิทยาลัย (กันโควต้าตีกัน — ดูเอกสารออกแบบ)';

create table public.notification_logs (
  notification_id          uuid primary key default gen_random_uuid(),
  notification_type        text not null check (notification_type in
    ('mid_class_15min','end_of_class','booking_submitted','booking_approved','booking_rejected','roster_ready','class_reminder')),
  recipient_user_id        uuid references public.users(user_id),
  recipient_line_group_id  text,
  schedule_id              uuid references public.schedules(schedule_id),
  channel                  text not null check (channel in ('line','web_push','email')),
  sent_at                  timestamptz not null default now(),
  message_content          text,
  status                   text not null default 'sent' check (status in ('sent','failed'))
);
create index idx_notification_logs_schedule on public.notification_logs(schedule_id);

create table public.push_subscriptions (
  subscription_id  uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(user_id) on delete cascade,
  endpoint         text not null unique,
  keys_p256dh      text not null,
  keys_auth        text not null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);
create index idx_push_subscriptions_user on public.push_subscriptions(user_id);

create table public.rosters (
  roster_id          uuid primary key default gen_random_uuid(),
  semester_id        uuid not null references public.semesters(semester_id),
  section_id         uuid not null references public.lab_sections(section_id),
  generated_at       timestamptz not null default now(),
  generated_by       uuid references public.users(user_id),
  drive_file_id      text,
  drive_folder_path  text
);
comment on table public.rosters is 'Log การสร้างไฟล์รายชื่อที่อัปโหลดขึ้น Google Drive Pro (ไม่ใช่ที่เก็บไฟล์เอง)';

-- ============================================================
-- Row Level Security (RLS)
-- นี่คือ policy ตัวอย่างหลักๆ ที่แสดง pattern — ควรทำเพิ่มให้ครบทุกตาราง
-- ตามนโยบายจริงก่อนใช้งานจริง (ยังไม่ครอบคลุมทุกตารางในไฟล์นี้)
-- ============================================================

alter table public.users enable row level security;
alter table public.students enable row level security;
alter table public.face_templates enable row level security;
alter table public.attendance_records enable row level security;
alter table public.room_bookings enable row level security;
alter table public.push_subscriptions enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable as $$
  select exists (select 1 from public.users where user_id = auth.uid() and role = 'admin');
$$;

-- นักศึกษาเห็น/แก้ข้อมูลตัวเองเท่านั้น
create policy "own profile" on public.users
  for select using (auth.uid() = user_id);

create policy "own attendance" on public.attendance_records
  for select using (auth.uid() = student_id);

create policy "own push subscription" on public.push_subscriptions
  for all using (auth.uid() = user_id);

-- อาจารย์เห็น attendance ของ section ตัวเอง (join ผ่าน schedules → lab_sections)
create policy "instructor section attendance" on public.attendance_records
  for select using (
    exists (
      select 1 from public.schedules s
      join public.lab_sections ls on ls.section_id = s.section_id
      where s.schedule_id = attendance_records.schedule_id
      and ls.instructor_id = auth.uid()
    )
  );

-- อาจารย์เจ้าของแล็บอนุมัติ booking ของ section ตัวเองได้ (ดู 4.5 — ไม่ผ่านแอดมิน)
create policy "instructor manage own section bookings" on public.room_bookings
  for all using (
    exists (
      select 1 from public.lab_sections ls
      where ls.section_id = room_bookings.section_id
      and ls.instructor_id = auth.uid()
    )
  );

-- แอดมินเข้าถึงได้ทุกอย่าง
create policy "admin full access users" on public.users for all using (public.is_admin());
create policy "admin full access attendance" on public.attendance_records for all using (public.is_admin());
create policy "admin full access bookings" on public.room_bookings for all using (public.is_admin());
