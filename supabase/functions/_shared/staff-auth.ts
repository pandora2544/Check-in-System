// ตรวจผู้ใช้หน้าอาจารย์/แอดมิน + กลุ่มเรียนที่ดู/แก้ได้ — ใช้ร่วมระหว่าง function ฝั่งบุคลากร
// (staff/index.ts ยังมีสำเนาเดิมของตัวเอง — ย้ายมาใช้ไฟล์นี้เมื่อแก้ครั้งถัดไป)
// deno-lint-ignore-file no-explicit-any
import { fail } from './http.ts';

export type Staff = { user_id: string; full_name: string; role: string; email: string | null; department_id: string | null };
export type Section = {
  section_id: string; section_no: string; semester_id: string; course_id: string; instructor_id: string | null; instructor_name: string | null;
  course_code: string; course_name: string; department_id: string | null; department_code: string | null;
  department_name: string | null; term: string | null; mine: boolean; editable: boolean;
};

export async function authStaff(sb: any, req: Request): Promise<Staff | Response> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return fail('UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ', 401);
  const { data: auth, error } = await sb.auth.getUser(token);
  if (error || !auth?.user) return fail('UNAUTHORIZED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  const { data: me } = await sb.from('users').select('user_id, full_name, role, email, department_id').eq('user_id', auth.user.id).maybeSingle();
  if (!me || !['instructor', 'admin'].includes(me.role)) return fail('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์เข้าหน้าอาจารย์/แอดมิน', 403);
  return me as Staff;
}

// ดู: แอดมิน = ทุกกลุ่ม · มีสาขา = ทุกกลุ่มของวิชาในสาขา + ที่ตัวเองสอน · ไม่มีสาขา = เฉพาะที่สอน
// แก้: แอดมิน หรือ อาจารย์ผู้สอนของกลุ่มนั้น
export async function visibleSections(sb: any, me: Staff, filter: { semester_id?: string | null; department_id?: string | null } = {}): Promise<Section[]> {
  let q = sb.from('lab_sections').select(
    'section_id, section_no, semester_id, course_id, instructor_id, instructor:instructor_id ( full_name ), semesters ( academic_year, term ), ' +
    'courses!inner ( course_code, course_name, department_id, departments ( code, name ) )',
  );
  if (filter.semester_id) q = q.eq('semester_id', filter.semester_id);
  const { data } = await q;
  const all = (data ?? []).map((s: any): Section => ({
    section_id: s.section_id, section_no: s.section_no, semester_id: s.semester_id, course_id: s.course_id,
    instructor_id: s.instructor_id, instructor_name: s.instructor?.full_name ?? null,
    course_code: s.courses?.course_code, course_name: s.courses?.course_name,
    department_id: s.courses?.department_id ?? null, department_code: s.courses?.departments?.code ?? null,
    department_name: s.courses?.departments?.name ?? null,
    term: s.semesters ? `${s.semesters.term}/${s.semesters.academic_year}` : null,
    mine: s.instructor_id === me.user_id, editable: me.role === 'admin' || s.instructor_id === me.user_id,
  }));
  let list = me.role === 'admin' ? all : all.filter((s: Section) => s.mine || (me.department_id && s.department_id === me.department_id));
  if (filter.department_id) list = list.filter((s: Section) => s.department_id === filter.department_id);
  return list.sort((a: Section, b: Section) => a.course_code.localeCompare(b.course_code) || a.section_no.localeCompare(b.section_no));
}
