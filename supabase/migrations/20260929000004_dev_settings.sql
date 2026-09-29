-- ค่าตั้งค่าสำหรับช่วงทดสอบเท่านั้น (เช่น รหัสเครื่องมือทดสอบ) — ลบตารางนี้ + function dev-tools ก่อนใช้งานจริง
-- เปิด RLS แต่ไม่มี policy = anon/authenticated อ่านไม่ได้เลย ใช้ได้เฉพาะ service_role ใน Edge Function
create table public.dev_settings (
  key    text primary key,
  value  text not null,
  updated_at timestamptz not null default now()
);
alter table public.dev_settings enable row level security;
comment on table public.dev_settings is 'TEST ONLY — ลบก่อน production';
-- ค่า dev_code ใส่แยกด้วยมือ ไม่เก็บใน repo:  insert into public.dev_settings (key, value) values ('dev_code', '<รหัส>');
