// เทียบใบหน้าด้วย pgvector ในฐานข้อมูล (migration 010)
// deno-lint-ignore-file no-explicit-any
type SB = any;

export const EMBEDDING_DIMS = 1024; // Human faceres
export const MATCH_THRESHOLD = 0.6;  // ค่าเริ่มต้น ยังไม่ปรับจูนกับอุปกรณ์จริง

export function validEmbedding(e: unknown): e is number[] {
  return Array.isArray(e) && e.length === EMBEDDING_DIMS && e.every((v) => typeof v === 'number' && Number.isFinite(v));
}

// รูปแบบข้อความที่ pgvector รับ: [0.1,0.2,...] (ตัดทศนิยม 6 ตำแหน่งเหมือนตอนเก็บ)
export const toVector = (e: number[]) => `[${e.map((v) => Number(v.toFixed(6))).join(',')}]`;

// เทียบกับกลุ่มคนที่กำหนด (exact) → คนที่ใกล้สุด 1 คน
export async function matchAmong(sb: SB, embedding: number[], studentIds: string[]) {
  if (!studentIds.length) return null;
  const { data, error } = await sb.rpc('match_face_among', { p_embedding: toVector(embedding), p_student_ids: studentIds });
  if (error) throw error;
  const r = data?.[0];
  return r ? { student_id: r.student_id as string, similarity: Number(r.similarity) } : null;
}

// ค้นทั้งระบบผ่าน index HNSW (กันหนึ่งหน้าลงทะเบียนหลายรหัส)
export async function matchGlobal(sb: SB, embedding: number[], limit = 3) {
  const { data, error } = await sb.rpc('match_face_global', { p_embedding: toVector(embedding), p_limit: limit });
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ student_id: r.student_id as string, similarity: Number(r.similarity) }));
}
