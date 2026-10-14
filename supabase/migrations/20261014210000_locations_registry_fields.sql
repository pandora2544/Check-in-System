-- ข้อมูลห้องจากทะเบียนห้องปฏิบัติการ (ESPReL) — 14 ต.ค. 2569
-- ฝ่าย ≠ โซน: โซนหนึ่งมีหลายฝ่ายได้ จึงเก็บฝ่ายเป็นคุณสมบัติของห้อง (zone_id คงเดิม)
alter table public.locations
  add column if not exists division text,          -- ฝ่ายที่ดูแลห้อง
  add column if not exists lab_code text,          -- รหัส WUCSE-… (ไม่บังคับ ไม่ unique — ทะเบียนเดิมใช้ซ้ำบางห้อง)
  add column if not exists room_no text,           -- เลขที่ห้อง
  add column if not exists caretaker_name text,    -- ชื่อผู้ดูแลตามทะเบียน (ผูกบัญชีภายหลังผ่าน staff_assignments)
  add column if not exists coords_set boolean not null default true; -- false = ยังไม่ปักพิกัด (radius 0 → สแกนเช็กชื่อไม่ผ่านจนกว่าจะตั้ง)
comment on column public.locations.room_code is 'รหัสห้อง (ห้องจริงใช้เลขทะเบียน 2-0220-xxxx-x · T0- = ห้องระบบ/ทดสอบ)';
create index if not exists idx_locations_division on public.locations (division);
