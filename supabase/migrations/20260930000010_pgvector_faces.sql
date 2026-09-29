-- 010 เก็บ/เทียบใบหน้าด้วย pgvector
-- เดิม: embedding เก็บเป็นข้อความ JSON แล้วดึงมาเทียบทีละคนใน Edge Function
--       (enroll ดึงทุกคนในระบบ ~7.8KB/คน → 5,000 คน ≈ 40MB ต่อการลงทะเบียน 1 ครั้ง)
-- ใหม่: คอลัมน์ vector(1024) + index HNSW (cosine) เทียบในฐานข้อมูล ส่งกลับแค่ผลลัพธ์ที่ดีที่สุด
--
-- ขั้นที่ 1 (ไฟล์นี้): เพิ่มคอลัมน์ + ย้ายข้อมูล + ฟังก์ชันเทียบ — คอลัมน์ข้อความเดิมยังอยู่ (trigger ซิงก์ให้) เพื่อให้
--                    function รุ่นเก่าที่ยัง deploy อยู่ทำงานได้ระหว่างอัปเดต
-- ขั้นที่ 2 (migration 011): ลบคอลัมน์ข้อความหลัง deploy function ใหม่ครบ

create extension if not exists vector with schema extensions;

alter table public.face_templates add column if not exists embedding extensions.vector(1024);
update public.face_templates set embedding = embedding_vector::extensions.vector where embedding is null;
alter table public.face_templates alter column embedding_vector drop not null;

-- ช่วงเปลี่ยนผ่าน: ใครเขียนคอลัมน์ข้อความ ให้เติมคอลัมน์ vector ให้ด้วย (และกลับกัน)
create or replace function public.face_templates_sync_embedding() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  if new.embedding is null and new.embedding_vector is not null then
    new.embedding := new.embedding_vector::vector;
  elsif new.embedding is not null and new.embedding_vector is null then
    new.embedding_vector := new.embedding::text;
  end if;
  return new;
end $$;
drop trigger if exists trg_face_templates_sync on public.face_templates;
create trigger trg_face_templates_sync before insert or update on public.face_templates
  for each row execute function public.face_templates_sync_embedding();

alter table public.face_templates alter column embedding set not null;
create index if not exists idx_face_templates_embedding_hnsw on public.face_templates
  using hnsw (embedding extensions.vector_cosine_ops);

-- เทียบกับกลุ่มคนที่กำหนด (เช็คชื่อ = คนในกลุ่มเรียน, สแกนออก = คนที่เช็คชื่อเข้าแล้ว) — เทียบครบทุกคน (exact)
-- ORDER BY เป็นนิพจน์ similarity เพื่อไม่ให้ planner ใช้ HNSW (ซึ่งกรองทีหลังและอาจพลาดคนในกลุ่มเล็ก)
create or replace function public.match_face_among(p_embedding extensions.vector, p_student_ids uuid[])
returns table (student_id uuid, similarity double precision)
language sql stable set search_path = public, extensions as $$
  select f.student_id, 1 - (f.embedding <=> p_embedding) as similarity
  from face_templates f
  where f.student_id = any (p_student_ids)
  order by 1 - (f.embedding <=> p_embedding) desc
  limit 1;
$$;

-- ค้นทั้งระบบผ่าน HNSW (ใช้กันหนึ่งหน้าลงทะเบียนหลายรหัส) — ค่าประมาณที่แม่นพอสำหรับงานนี้
create or replace function public.match_face_global(p_embedding extensions.vector, p_limit int default 3)
returns table (student_id uuid, similarity double precision)
language sql stable set search_path = public, extensions as $$
  select f.student_id, 1 - (f.embedding <=> p_embedding) as similarity
  from face_templates f
  order by f.embedding <=> p_embedding
  limit greatest(1, least(p_limit, 20));
$$;

revoke all on function public.match_face_among(extensions.vector, uuid[]) from public, anon, authenticated;
revoke all on function public.match_face_global(extensions.vector, int) from public, anon, authenticated;
grant execute on function public.match_face_among(extensions.vector, uuid[]) to service_role;
grant execute on function public.match_face_global(extensions.vector, int) to service_role;
