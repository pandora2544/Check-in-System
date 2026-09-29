-- 008 Telegram notifications
-- เปลี่ยนจาก LINE OA → Telegram: ผูกกลุ่ม Telegram กับกลุ่มเรียน + สวิตช์เปิด/ปิด
-- cron ทุก 1 นาทีเรียก Edge Function `notify` (สรุประหว่างคาบ / ตัดขาดอัตโนมัติ / สรุปจบคาบ)

-- 1) line_channels (ยังว่าง) → telegram_channels
alter table public.line_channels rename to telegram_channels;
alter table public.telegram_channels rename column line_channel_id to channel_id;
alter table public.telegram_channels rename column line_group_id to chat_id;
alter table public.telegram_channels
  add column title text,
  add column notify_mid boolean not null default true,   -- สรุประหว่างคาบ (ครบเกณฑ์สาย)
  add column notify_end boolean not null default true,   -- สรุปจบคาบ
  add column updated_at timestamptz not null default now();
alter table public.telegram_channels alter column is_active set default false;
alter table public.telegram_channels add constraint telegram_channels_section_chat_key unique (section_id, chat_id);
alter policy "admin full access line_channels" on public.telegram_channels rename to "admin full access telegram_channels";
alter policy "instructor own line_channels" on public.telegram_channels rename to "instructor own telegram_channels";

-- 2) ตัด "ขาด" อัตโนมัติเมื่อจบคาบ (รายกลุ่มเรียน)
alter table public.lab_sections add column auto_absent boolean not null default true;

-- 3) notification_logs: รองรับ telegram + กันส่งซ้ำ
alter table public.notification_logs drop constraint notification_logs_channel_check;
alter table public.notification_logs add constraint notification_logs_channel_check
  check (channel = any (array['line','web_push','email','telegram','system']));
alter table public.notification_logs drop constraint notification_logs_notification_type_check;
alter table public.notification_logs add constraint notification_logs_notification_type_check
  check (notification_type = any (array['mid_class_15min','end_of_class','auto_absent','booking_submitted','booking_approved',
                                        'booking_rejected','roster_ready','class_reminder']));
alter table public.notification_logs drop constraint notification_logs_status_check;
alter table public.notification_logs add constraint notification_logs_status_check
  check (status = any (array['pending','sent','failed','skipped']));
alter table public.notification_logs
  add column recipient_chat_id text not null default '',
  add column error text;
alter table public.notification_logs add constraint notification_logs_once_key
  unique (schedule_id, notification_type, channel, recipient_chat_id);

-- 4) ค่าลับภายในระบบ (ไม่มี policy = อ่านได้เฉพาะ service role / postgres)
create table if not exists public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
insert into public.app_settings (key, value)
values ('cron_secret', encode(extensions.gen_random_bytes(24), 'hex'))
on conflict (key) do nothing;

-- 5) pg_cron: เรียก notify ทุก 1 นาที
create extension if not exists pg_cron;
select cron.schedule(
  'notify-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://rpaqvrpuhdadhirzrlrf.supabase.co/functions/v1/notify',
    body := '{"action":"tick"}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json',
                                  'x-cron-secret', (select value from public.app_settings where key = 'cron_secret')),
    timeout_milliseconds := 20000
  );
  $$
);

-- 6) ล้างประวัติ cron เก่ากว่า 3 วัน (cron ทุกนาที = ~1,440 แถว/วัน)
select cron.schedule('cleanup-cron-history', '17 3 * * *',
  $$ delete from cron.job_run_details where end_time < now() - interval '3 days' $$);
