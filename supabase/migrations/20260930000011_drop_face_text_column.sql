-- 011 ลบคอลัมน์ embedding แบบข้อความ (JSON) หลังย้าย enroll/checkin/checkout ไปใช้ pgvector ครบแล้ว (migration 010)
drop trigger if exists trg_face_templates_sync on public.face_templates;
drop function if exists public.face_templates_sync_embedding();
alter table public.face_templates drop column if exists embedding_vector;
