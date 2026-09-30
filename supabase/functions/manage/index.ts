// POST /functions/v1/manage   — จัดการเทอม/วิชา/กลุ่มเรียน + อัปโหลดรายชื่อนักศึกษารายเทอม (ต้องล็อกอิน)
// deploy ด้วย verify_jwt: false (ตรวจ token เองใน authStaff)
//
// สิทธิ์: แอดมิน = ทุกอย่าง · อาจารย์ = ดูกลุ่มเรียนในสาขา, อัปโหลด/แก้รายชื่อได้เฉพาะกลุ่มที่ตัวเองสอน
//
// actions:
//   bootstrap                                  เทอมทั้งหมด (+จำนวนกลุ่ม), สาขา, วิชา, อาจารย์ (แอดมิน)
//   term_sections  { semester_id }             กลุ่มเรียนในเทอม + จำนวนนักศึกษา/ลงทะเบียนหน้าแล้ว
//   term_save      { academic_year, term, start_date, end_date }                       (แอดมิน)
//   course_save    { course_code, course_name, department_id?, credit? }               (แอดมิน)
//   section_save   { section_id?, course_id, semester_id, section_no, instructor_id?, late_threshold_minutes? } (แอดมิน)
//   roster_get     { section_id }              รายชื่อในกลุ่มเรียน
//   roster_preview { section_id, rows, remove_missing? }   ตรวจไฟล์ก่อนนำเข้า (ไม่บันทึก)
//   roster_import  { section_id, rows, remove_missing? }   นำเข้าจริง
//     rows = [{ code, full_name, group? }]  (หน้าเว็บอ่าน Excel/CSV แล้วส่งมาเป็นข้อมูลแถว — ไม่อัปโหลดไฟล์ขึ้นเซิร์ฟเวอร์)
//   ตั้งค่าเทอมล่วงหน้า (ดู _shared/term-setup.ts):
//   rooms_save, holidays_get, holidays_save, setup_get, slots_plan, topics_save, topics_copy, session_plan_save, plan_autofill

import { CORS, fail, json, serviceClient } from '../_shared/http.ts';
import { authStaff, visibleSections, type Staff } from '../_shared/staff-auth.ts';
import { handleSetup } from '../_shared/term-setup.ts';

const supabase = serviceClient();
const MAX_ROWS = 1000;
const CODE_RE = /^\d{6,12}$/;
const STUDENT_EMAIL = (code: string) => `${code}@student.cph-smart-checkin.invalid`; // บัญชีเงา — นักศึกษาไม่ได้ล็อกอิน

type Row = { code: string; full_name: string; group: string | null };

function cleanRows(input: unknown) {
  const rows: Row[] = [], invalid: { row: number; code: string; reason: string }[] = [];
  const seen = new Map<string, number>();
  if (!Array.isArray(input)) return { rows, invalid: [{ row: 0, code: '', reason: 'ไม่มีข้อมูลแถว' }] };
  input.slice(0, MAX_ROWS + 1).forEach((r: any, i: number) => {
    const code = String(r?.code ?? '').replace(/[\s-]/g, '');
    const name = String(r?.full_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const group = r?.group == null || String(r.group).trim() === '' ? null : String(r.group).trim().slice(0, 20);
    if (!CODE_RE.test(code)) return invalid.push({ row: i + 1, code, reason: 'รหัสนักศึกษาต้องเป็นตัวเลข 6–12 หลัก' });
    if (!name) return invalid.push({ row: i + 1, code, reason: 'ไม่มีชื่อ' });
    if (seen.has(code)) return invalid.push({ row: i + 1, code, reason: `รหัสซ้ำกับแถว ${seen.get(code)}` });
    seen.set(code, i + 1);
    rows.push({ code, full_name: name, group });
  });
  if (input.length > MAX_ROWS) invalid.push({ row: MAX_ROWS + 1, code: '', reason: `เกิน ${MAX_ROWS} แถว — แยกไฟล์` });
  return { rows, invalid };
}

async function sectionFor(me: Staff, sectionId: string) {
  return (await visibleSections(supabase, me)).find((s) => s.section_id === sectionId) ?? null;
}

// เปรียบเทียบไฟล์กับข้อมูลในระบบ
async function diff(sectionId: string, rows: Row[], removeMissing: boolean) {
  const codes = rows.map((r) => r.code);
  const existing = new Map<string, { student_id: string; full_name: string; status: string }>();
  for (let i = 0; i < codes.length; i += 200) {
    const { data, error } = await supabase.from('students').select('student_id, student_code, status, users ( full_name )').in('student_code', codes.slice(i, i + 200));
    if (error) throw error;
    for (const s of data ?? []) existing.set(s.student_code, { student_id: s.student_id, full_name: (s.users as any)?.full_name ?? '', status: s.status });
  }
  const { data: enr, error: e2 } = await supabase.from('section_enrollments')
    .select('student_id, work_group, students ( student_code, users ( full_name ) )').eq('section_id', sectionId);
  if (e2) throw e2;
  type Enr = { student_id: string; work_group: string | null; full_name: string };
  const enrolled = new Map<string, Enr>((enr ?? []).map((e: any): [string, Enr] => [e.students?.student_code as string, { student_id: e.student_id, work_group: e.work_group ?? null, full_name: e.students?.users?.full_name ?? '' }]));

  const newStudents: Row[] = [], nameChanges: { code: string; old: string; new: string }[] = [], toEnroll: string[] = [], already: string[] = [];
  const groupChanges: { code: string; old: string | null; new: string | null }[] = [], inactive: { code: string; status: string }[] = [];
  for (const r of rows) {
    const ex = existing.get(r.code);
    if (!ex) newStudents.push(r);
    else {
      if (ex.full_name !== r.full_name) nameChanges.push({ code: r.code, old: ex.full_name, new: r.full_name });
      if (ex.status !== 'active') inactive.push({ code: r.code, status: ex.status });
    }
    const en = enrolled.get(r.code);
    if (en) { already.push(r.code); if ((en.work_group ?? null) !== r.group) groupChanges.push({ code: r.code, old: en.work_group ?? null, new: r.group }); }
    else toEnroll.push(r.code);
  }
  const inFile = new Set(codes);
  const missingList = [...enrolled.entries()].filter(([c]) => !inFile.has(c)).map(([code, v]) => ({ code, full_name: v.full_name, student_id: v.student_id }));
  // คนที่จะถูกเอาออก มีประวัติเช็คชื่อในกลุ่มนี้หรือยัง (ประวัติไม่ถูกลบ แต่ควรรู้ไว้)
  let withAttendance = new Set<string>();
  if (removeMissing && missingList.length) {
    const { data: sch } = await supabase.from('schedules').select('schedule_id').eq('section_id', sectionId);
    const schIds = (sch ?? []).map((s) => s.schedule_id);
    if (schIds.length) {
      const { data: att } = await supabase.from('attendance_records').select('student_id').in('student_id', missingList.map((m) => m.student_id)).in('schedule_id', schIds).limit(5000);
      withAttendance = new Set((att ?? []).map((a) => a.student_id));
    }
  }
  const missing = missingList.map((m) => ({ code: m.code, full_name: m.full_name, has_attendance: withAttendance.has(m.student_id) }));
  return { existing, enrolled, newStudents, nameChanges, toEnroll, already, groupChanges, inactive, missing };
}

async function ensureStudent(r: Row): Promise<string> {
  const email = STUDENT_EMAIL(r.code);
  let userId: string | null = null;
  const { data, error } = await supabase.auth.admin.createUser({ email, email_confirm: true, user_metadata: { full_name: r.full_name, app_role: 'student', student_code: r.code } });
  if (data?.user) userId = data.user.id;
  else {
    // สร้างไว้แล้วจากรอบก่อนที่ล้มกลางทาง → ใช้ id เดิม
    const { data: id } = await supabase.rpc('auth_user_id_by_email', { p_email: email });
    if (!id) throw new Error(`สร้างบัญชี ${r.code} ไม่ได้: ${error?.message ?? 'unknown'}`);
    userId = id as string;
  }
  const { error: e1 } = await supabase.from('users').upsert({ user_id: userId, email, role: 'student', full_name: r.full_name }, { onConflict: 'user_id' });
  if (e1) throw e1;
  const { error: e2 } = await supabase.from('students').upsert({ student_id: userId, student_code: r.code, status: 'active' }, { onConflict: 'student_id' });
  if (e2) throw e2;
  return userId!;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 'ใช้ POST เท่านั้น', 405);
  const me = await authStaff(supabase, req);
  if (me instanceof Response) return me;
  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail('BAD_REQUEST', 'JSON body ไม่ถูกต้อง', 400); }
  const isAdmin = me.role === 'admin';
  const adminOnly = () => fail('FORBIDDEN', 'เฉพาะแอดมิน', 403);

  try {
    switch (body.action) {
      case 'bootstrap': {
        const [{ data: terms }, { data: depts }, { data: courses }, sections, instr, { data: rooms }] = await Promise.all([
          supabase.from('semesters').select('semester_id, academic_year, term, start_date, end_date').order('start_date', { ascending: false }),
          supabase.from('departments').select('department_id, code, name').order('code'),
          supabase.from('courses').select('course_id, course_code, course_name, credit, department_id').order('course_code'),
          visibleSections(supabase, me),
          isAdmin ? supabase.from('users').select('user_id, full_name, role, department_id').in('role', ['instructor', 'admin']).order('full_name') : Promise.resolve({ data: [] }),
          supabase.from('locations').select('location_id, name, building, floor, latitude, longitude, radius_meters').order('name'),
        ]);
        const count = new Map<string, number>();
        for (const s of sections) count.set(s.semester_id, (count.get(s.semester_id) ?? 0) + 1);
        const visibleCourses = isAdmin ? courses ?? [] : (courses ?? []).filter((c) => sections.some((s) => s.course_id === c.course_id) || (me.department_id && c.department_id === me.department_id));
        return json({ data: {
          user: { user_id: me.user_id, full_name: me.full_name, role: me.role, department_id: me.department_id },
          terms: (terms ?? []).map((t) => ({ ...t, label: `${t.term === 'summer' ? 'ภาคฤดูร้อน' : `ภาคเรียนที่ ${t.term}`}/${t.academic_year}`, sections: count.get(t.semester_id) ?? 0 })),
          departments: depts ?? [], courses: visibleCourses, instructors: (instr as any).data ?? [], rooms: rooms ?? [],
        } });
      }

      case 'term_sections': {
        const sections = await visibleSections(supabase, me, { semester_id: String(body.semester_id ?? '') });
        const ids = sections.map((s) => s.section_id);
        const counts = new Map<string, { n: number; face: number }>();
        if (ids.length) {
          const { data: enr } = await supabase.from('section_enrollments').select('section_id, students ( face_templates ( template_id ) )').in('section_id', ids);
          for (const e of enr ?? []) {
            const c = counts.get(e.section_id) ?? { n: 0, face: 0 };
            c.n++; if (((e.students as any)?.face_templates ?? []).length) c.face++;
            counts.set(e.section_id, c);
          }
        }
        // สถานะการตั้งค่า: ช่วงเวลาประจำสัปดาห์ + จำนวนคาบ / คาบที่มีบทแล้ว
        const slotMap = new Map<string, { weekday: number; start_time: string; end_time: string; room: string }[]>();
        const sess = new Map<string, { n: number; topic: number }>();
        const topicN = new Map<string, number>();
        if (ids.length) {
          const [{ data: sl }, { data: sc }, { data: tp }] = await Promise.all([
            supabase.from('section_slots').select('section_id, weekday, start_time, end_time, locations ( name )').in('section_id', ids).order('weekday').order('start_time'),
            supabase.from('schedules').select('section_id, topic_id').in('section_id', ids).eq('status', 'scheduled').limit(10000),
            supabase.from('lab_topics').select('course_id').in('course_id', [...new Set(sections.map((s) => s.course_id))]),
          ]);
          for (const x of sl ?? []) { const a = slotMap.get(x.section_id) ?? []; a.push({ weekday: x.weekday, start_time: String(x.start_time).slice(0, 5), end_time: String(x.end_time).slice(0, 5), room: (x.locations as any)?.name ?? '' }); slotMap.set(x.section_id, a); }
          for (const x of sc ?? []) { const c = sess.get(x.section_id) ?? { n: 0, topic: 0 }; c.n++; if (x.topic_id) c.topic++; sess.set(x.section_id, c); }
          for (const x of tp ?? []) topicN.set(x.course_id, (topicN.get(x.course_id) ?? 0) + 1);
        }
        return json({ data: { sections: sections.map((s) => ({
          ...s, enrolled: counts.get(s.section_id)?.n ?? 0, face_enrolled: counts.get(s.section_id)?.face ?? 0,
          slots: slotMap.get(s.section_id) ?? [], sessions: sess.get(s.section_id)?.n ?? 0, sessions_with_topic: sess.get(s.section_id)?.topic ?? 0,
          course_topics: topicN.get(s.course_id) ?? 0,
        })) } });
      }

      case 'term_save': {
        if (!isAdmin) return adminOnly();
        const year = String(body.academic_year ?? '').trim(), term = String(body.term ?? '');
        if (!/^25\d\d$/.test(year)) return fail('BAD_REQUEST', 'ปีการศึกษาเป็น พ.ศ. 4 หลัก เช่น 2569', 400);
        if (!['1', '2', 'summer'].includes(term)) return fail('BAD_REQUEST', 'ภาคเรียนต้องเป็น 1, 2 หรือ summer', 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.start_date)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.end_date)) || body.end_date < body.start_date) return fail('BAD_REQUEST', 'วันเริ่ม/สิ้นสุดเทอมไม่ถูกต้อง', 400);
        const { data, error } = await supabase.from('semesters').upsert({ academic_year: year, term, start_date: body.start_date, end_date: body.end_date }, { onConflict: 'academic_year,term' }).select().single();
        if (error) throw error;
        return json({ data });
      }

      case 'course_save': {
        if (!isAdmin) return adminOnly();
        const code = String(body.course_code ?? '').trim().toUpperCase(), name = String(body.course_name ?? '').trim();
        if (!/^[A-Z0-9-]{3,20}$/.test(code)) return fail('BAD_REQUEST', 'รหัสวิชาไม่ถูกต้อง (ตัวอักษรอังกฤษ/ตัวเลข)', 400);
        if (!name) return fail('BAD_REQUEST', 'ต้องมีชื่อวิชา', 400);
        const { data, error } = await supabase.from('courses').upsert({ course_code: code, course_name: name.slice(0, 200), department_id: body.department_id || null, credit: body.credit ?? null }, { onConflict: 'course_code' }).select().single();
        if (error) throw error;
        return json({ data });
      }

      case 'section_save': {
        if (!isAdmin) return adminOnly();
        const sectionNo = String(body.section_no ?? '').trim();
        if (!/^[0-9A-Za-z-]{1,10}$/.test(sectionNo)) return fail('BAD_REQUEST', 'เลขกลุ่มเรียนไม่ถูกต้อง', 400);
        const row: Record<string, unknown> = { course_id: body.course_id, semester_id: body.semester_id, section_no: sectionNo, instructor_id: body.instructor_id || null };
        if (Number.isFinite(Number(body.late_threshold_minutes))) row.late_threshold_minutes = Math.max(0, Math.min(120, Number(body.late_threshold_minutes)));
        const q = body.section_id
          ? supabase.from('lab_sections').update(row).eq('section_id', body.section_id)
          : supabase.from('lab_sections').insert(row);
        const { data, error } = await q.select().single();
        if (error) return fail(error.code === '23505' ? 'DUPLICATE' : 'BAD_REQUEST', error.code === '23505' ? 'มีกลุ่มเรียนนี้ในเทอมนี้แล้ว' : error.message, 400);
        return json({ data });
      }

      case 'roster_get': {
        const sec = await sectionFor(me, String(body.section_id ?? ''));
        if (!sec) return fail('NOT_FOUND', 'ไม่พบกลุ่มเรียน หรือไม่มีสิทธิ์', 404);
        const { data } = await supabase.from('section_enrollments')
          .select('work_group, source, enrolled_at, students ( student_code, status, users ( full_name ), face_templates ( template_id ) )').eq('section_id', sec.section_id);
        const roster = (data ?? []).map((e: any) => ({
          code: e.students?.student_code, full_name: e.students?.users?.full_name, status: e.students?.status, group: e.work_group,
          face_enrolled: (e.students?.face_templates ?? []).length > 0, source: e.source,
        })).sort((a, b) => String(a.code).localeCompare(String(b.code)));
        return json({ data: { section: sec, roster } });
      }

      case 'roster_preview':
      case 'roster_import': {
        const sec = await sectionFor(me, String(body.section_id ?? ''));
        if (!sec) return fail('NOT_FOUND', 'ไม่พบกลุ่มเรียน หรือไม่มีสิทธิ์', 404);
        if (!sec.editable) return fail('FORBIDDEN', 'อัปโหลดรายชื่อได้เฉพาะกลุ่มเรียนที่ตัวเองสอน', 403);
        const { rows, invalid } = cleanRows(body.rows);
        const removeMissing = body.remove_missing === true;
        const d = await diff(sec.section_id, rows, removeMissing);
        const summary = {
          total: rows.length, invalid,
          new_students: d.newStudents, name_changes: d.nameChanges, to_enroll: d.toEnroll.length, already: d.already.length,
          group_changes: d.groupChanges, inactive: d.inactive, missing: d.missing, remove_missing: removeMissing,
        };
        if (body.action === 'roster_preview') return json({ data: summary });

        if (invalid.length) return fail('INVALID_ROWS', `มี ${invalid.length} แถวที่ไม่ถูกต้อง — แก้ไฟล์ก่อนนำเข้า`, 400, { invalid });
        if (!rows.length) return fail('BAD_REQUEST', 'ไม่มีรายชื่อ', 400);

        // 1) สร้างนักศึกษาใหม่ (บัญชีเงา + users + students)
        const ids = new Map<string, string>([...d.existing.entries()].map(([c, v]) => [c, v.student_id]));
        const failed: { code: string; error: string }[] = [];
        await pool(d.newStudents, 5, async (r) => {
          try { ids.set(r.code, await ensureStudent(r)); } catch (e) { failed.push({ code: r.code, error: String((e as Error).message) }); }
        });
        // 2) อัปเดตชื่อที่เปลี่ยน
        for (const c of d.nameChanges) {
          const id = ids.get(c.code);
          if (id) await supabase.from('users').update({ full_name: c.new }).eq('user_id', id);
        }
        // 3) ลงกลุ่มเรียน + กลุ่มทำงาน
        const now = new Date().toISOString();
        const enrollRows = rows.filter((r) => ids.has(r.code)).map((r) => ({ section_id: sec.section_id, student_id: ids.get(r.code)!, work_group: r.group, source: 'import', updated_at: now }));
        for (let i = 0; i < enrollRows.length; i += 200) {
          const { error } = await supabase.from('section_enrollments').upsert(enrollRows.slice(i, i + 200), { onConflict: 'section_id,student_id' });
          if (error) throw error;
        }
        // 4) เอาคนที่ไม่มีในไฟล์ออก (ถ้าเลือก) — ประวัติเช็คชื่อยังอยู่
        let removed = 0;
        if (removeMissing && d.missing.length) {
          const rmIds = d.missing.map((m) => d.enrolled.get(m.code)?.student_id).filter(Boolean) as string[];
          const { error, count } = await supabase.from('section_enrollments').delete({ count: 'exact' }).eq('section_id', sec.section_id).in('student_id', rmIds);
          if (error) throw error;
          removed = count ?? rmIds.length;
        }
        return json({ data: {
          created: d.newStudents.length - failed.length, renamed: d.nameChanges.length, enrolled: d.toEnroll.length - failed.length,
          already: d.already.length, groups_updated: d.groupChanges.length, removed, failed,
        } });
      }

      default: {
        const r = await handleSetup(supabase, me, body);
        if (r) return r;
        return fail('BAD_REQUEST', 'action ไม่รู้จัก', 400);
      }
    }
  } catch (err) {
    console.error(err);
    return fail('INTERNAL_ERROR', String((err as Error)?.message ?? err), 500);
  }
});
