-- ใช้เรียก Edge Function จากฐานข้อมูล (จำเป็นสำหรับ Supabase Cron แจ้งเตือน LINE/Web Push ในอนาคต และใช้ทดสอบ)
create extension if not exists pg_net with schema extensions;
