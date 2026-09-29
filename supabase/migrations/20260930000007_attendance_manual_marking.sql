-- อาจารย์/แอดมินเช็คชื่อแทน หรือแก้สถานะ (ลา/ขาด) — เก็บว่าใครแก้ เมื่อไหร่
alter table public.attendance_records
  add column is_manual   boolean not null default false,
  add column marked_by   uuid references public.users(user_id),
  add column marked_at   timestamptz;
comment on column public.attendance_records.is_manual is 'true = อาจารย์/แอดมินบันทึกหรือแก้สถานะเอง (ไม่ได้มาจากการสแกนหน้า)';
