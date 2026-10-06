// ตรวจผู้ใช้บุคลากร + สิทธิ์ตามงานมอบหมาย (plan.md ส่วนที่ 1.1 · DEC-034) — ใช้ร่วมทุก function ฝั่งบุคลากร
// สิทธิ์ = บทบาทบัญชี (admin / instructor = บุคลากร) + งานมอบหมาย (staff_assignments: หน้าที่ × ขอบเขต × ช่วงวันที่)
// คงเงื่อนไขเดิมไว้: ผู้สอนตาม lab_sections.instructor_id ยังแก้กลุ่มของตนได้ · บุคลากรในสาขาดูวิชาในสาขาได้
// deno-lint-ignore-file no-explicit-any
import { bkkDate, fail } from './http.ts';

export type Staff = {
  user_id: string; full_name: string; role: string; email: string | null; department_id: string | null;
  is_scientist: boolean; phone?: string | null; line_id?: string | null; telegram_chat_id?: string | null;
};
export type Section = {
  section_id: string; section_no: string; semester_id: string; course_id: string; instructor_id: string | null; instructor_name: string | null;
  course_code: string; course_name: string; department_id: string | null; department_code: string | null;
  department_name: string | null; color: string | null; term: string | null;
  mine: boolean;            // มีงานมอบหมายเกี่ยวกับกลุ่ม/วิชานี้
  owner: boolean;           // ผู้ตั้งรายวิชา (วิชา × เทอม)
  teach: boolean;           // ผู้สอนของกลุ่มนี้
  lab: boolean;             // เจ้าหน้าที่/พนักงานห้องทดลองของวิชา
  editable: boolean;        // แก้กลุ่มนี้ได้ (เวลา บทรายคาบ เลื่อน/งด รายชื่อ เช็คชื่อแทน) = แอดมิน | ผู้ตั้งรายวิชา | ผู้สอน
  course_editable: boolean; // แก้ทั้งวิชา (รายการบท เพิ่ม Section มอบหมาย) = แอดมิน | ผู้ตั้งรายวิชา
  can_price: boolean;       // เห็นราคาละเอียด (A4)
};
export type Assignment = {
  assignment_id: string; user_id: string; kind: string; course_id: string | null; semester_id: string | null;
  section_id: string | null; location_id: string | null; department_id: string | null; valid_from: string | null; valid_to: string | null;
};
export type Perms = {
  list: Assignment[];
  owner: Set<string>; labStaff: Set<string>; labWorker: Set<string>;  // key = course_id|semester_id
  ownerCourses: Set<string>; teach: Set<string>;                       // course_id · section_id
  costViewer: boolean;
};

export const ckey = (c: string | null, s: string | null) => `${c}|${s}`;
const active = (a: Assignment, today: string) => (!a.valid_from || a.valid_from <= today) && (!a.valid_to || a.valid_to >= today);

export async function authStaff(sb: any, req: Request): Promise<Staff | Response> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return fail('UNAUTHORIZED', 'กรุณาเข้าสู่ระบบ', 401);
  const { data: auth, error } = await sb.auth.getUser(token);
  if (error || !auth?.user) return fail('UNAUTHORIZED', 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่', 401);
  const { data: me } = await sb.from('users')
    .select('user_id, full_name, role, email, department_id, is_scientist, phone, line_id, telegram_chat_id').eq('user_id', auth.user.id).maybeSingle();
  if (!me || !['instructor', 'admin'].includes(me.role)) return fail('FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์เข้าหน้าบุคลากร', 403);
  return me as Staff;
}

const permCache = new WeakMap<Staff, Promise<Perms>>();
export function loadPerms(sb: any, me: Staff): Promise<Perms> {
  let p = permCache.get(me);
  if (!p) {
    p = (async () => {
      const today = bkkDate(new Date());
      const { data } = await sb.from('staff_assignments').select('*').eq('user_id', me.user_id);
      const list = ((data ?? []) as Assignment[]).filter((a) => active(a, today));
      const perms: Perms = { list, owner: new Set(), labStaff: new Set(), labWorker: new Set(), ownerCourses: new Set(), teach: new Set(), costViewer: false };
      for (const a of list) {
        if (a.kind === 'course_owner') { perms.owner.add(ckey(a.course_id, a.semester_id)); perms.ownerCourses.add(a.course_id!); }
        else if (a.kind === 'lab_staff') perms.labStaff.add(ckey(a.course_id, a.semester_id));
        else if (a.kind === 'lab_worker') perms.labWorker.add(ckey(a.course_id, a.semester_id));
        else if (a.kind === 'instructor') perms.teach.add(a.section_id!);
        else if (a.kind === 'cost_viewer') perms.costViewer = true;
      }
      return perms;
    })();
    permCache.set(me, p);
  }
  return p;
}

export async function visibleSections(sb: any, me: Staff, filter: { semester_id?: string | null; department_id?: string | null } = {}): Promise<Section[]> {
  let q = sb.from('lab_sections').select(
    'section_id, section_no, semester_id, course_id, instructor_id, instructor:instructor_id ( full_name ), semesters ( academic_year, term ), ' +
    'courses!inner ( course_code, course_name, department_id, departments ( code, name, color ) )',
  );
  if (filter.semester_id) q = q.eq('semester_id', filter.semester_id);
  const [{ data }, perms] = await Promise.all([q, loadPerms(sb, me)]);
  const admin = me.role === 'admin';
  const all = (data ?? []).map((s: any): Section => {
    const k = ckey(s.course_id, s.semester_id);
    const owner = perms.owner.has(k);
    const teach = perms.teach.has(s.section_id) || s.instructor_id === me.user_id;
    const lab = perms.labStaff.has(k) || perms.labWorker.has(k);
    return {
      section_id: s.section_id, section_no: s.section_no, semester_id: s.semester_id, course_id: s.course_id,
      instructor_id: s.instructor_id, instructor_name: s.instructor?.full_name ?? null,
      course_code: s.courses?.course_code, course_name: s.courses?.course_name,
      department_id: s.courses?.department_id ?? null, department_code: s.courses?.departments?.code ?? null,
      department_name: s.courses?.departments?.name ?? null, color: s.courses?.departments?.color ?? null,
      term: s.semesters ? `${s.semesters.term}/${s.semesters.academic_year}` : null,
      mine: owner || teach || lab, owner, teach, lab,
      editable: admin || owner || teach, course_editable: admin || owner,
      can_price: admin || owner || perms.costViewer,
    };
  });
  let list = admin ? all : all.filter((s: Section) => s.mine || (me.department_id && s.department_id === me.department_id));
  if (filter.department_id) list = list.filter((s: Section) => s.department_id === filter.department_id);
  return list.sort((a: Section, b: Section) => a.course_code.localeCompare(b.course_code) || a.section_no.localeCompare(b.section_no));
}

// แก้รายการบทของวิชา (ใช้ข้ามเทอม) = แอดมิน | ผู้ตั้งรายวิชาของวิชานี้ (เทอมใดก็ได้) — A3
export async function canEditCourse(sb: any, me: Staff, courseId: string): Promise<boolean> {
  if (me.role === 'admin') return true;
  return (await loadPerms(sb, me)).ownerCourses.has(courseId);
}
export async function isCourseOwner(sb: any, me: Staff, courseId: string, semesterId: string): Promise<boolean> {
  if (me.role === 'admin') return true;
  return (await loadPerms(sb, me)).owner.has(ckey(courseId, semesterId));
}

// ---------- ผู้ดูแลห้อง (A5) ----------
// ผู้อนุมัติห้อง ณ วันที่: ผู้ดูแลหลัก (ถ้าไม่ได้ตั้งไม่อยู่) · ผู้สำรอง (เมื่อหลักไม่อยู่/ไม่มีหลัก) · ผู้แทนชั่วคราวในช่วงวันที่ · แอดมินเสมอ (ไม่อยู่ในรายการ)
export async function roomApprovers(sb: any, locationIds: string[], date: string): Promise<Map<string, { user_id: string; kind: string }[]>> {
  const out = new Map<string, { user_id: string; kind: string }[]>();
  if (!locationIds.length) return out;
  const { data: as } = await sb.from('staff_assignments').select('user_id, kind, location_id, valid_from, valid_to')
    .in('location_id', locationIds).in('kind', ['room_manager', 'room_backup', 'room_delegate']);
  const managers = (as ?? []).filter((a: any) => a.kind === 'room_manager').map((a: any) => a.user_id);
  const away = new Set<string>();
  if (managers.length) {
    const { data: aw } = await sb.from('user_away').select('user_id').in('user_id', managers).lte('from_date', date).gte('to_date', date);
    for (const a of aw ?? []) away.add(a.user_id);
  }
  for (const loc of locationIds) {
    const rows = (as ?? []).filter((a: any) => a.location_id === loc);
    const mgr = rows.find((a: any) => a.kind === 'room_manager');
    const list: { user_id: string; kind: string }[] = [];
    if (mgr && !away.has(mgr.user_id)) list.push({ user_id: mgr.user_id, kind: 'room_manager' });
    if (!mgr || away.has(mgr.user_id)) for (const b of rows.filter((a: any) => a.kind === 'room_backup')) list.push({ user_id: b.user_id, kind: 'room_backup' });
    for (const d of rows.filter((a: any) => a.kind === 'room_delegate' && a.valid_from <= date && a.valid_to >= date)) list.push({ user_id: d.user_id, kind: 'room_delegate' });
    out.set(loc, list);
  }
  return out;
}
export async function canApproveRoom(sb: any, me: Staff, locationId: string, date: string): Promise<boolean> {
  if (me.role === 'admin') return true;
  return ((await roomApprovers(sb, [locationId], date)).get(locationId) ?? []).some((a) => a.user_id === me.user_id);
}

// ดัชนีผู้อนุมัติหลายห้องหลายวัน (โหลดครั้งเดียว) — ใช้ในคิว/ตั้งค่าเทอม
export type ApproverIndex = { can: (userId: string, loc: string, date: string) => boolean; who: (loc: string, date: string) => string[] };
export async function approverIndex(sb: any, locIds: string[]): Promise<ApproverIndex> {
  const ids = [...new Set(locIds)].filter(Boolean);
  const { data: as } = ids.length
    ? await sb.from('staff_assignments').select('user_id, kind, location_id, valid_from, valid_to').in('location_id', ids).in('kind', ['room_manager', 'room_backup', 'room_delegate'])
    : { data: [] };
  const mgrIds = [...new Set((as ?? []).filter((a: any) => a.kind === 'room_manager').map((a: any) => a.user_id))];
  const { data: aw } = mgrIds.length ? await sb.from('user_away').select('user_id, from_date, to_date').in('user_id', mgrIds) : { data: [] };
  const away = (u: string, d: string) => (aw ?? []).some((x: any) => x.user_id === u && x.from_date <= d && x.to_date >= d);
  const who = (loc: string, d: string) => {
    const rows = (as ?? []).filter((a: any) => a.location_id === loc);
    const mgr = rows.find((a: any) => a.kind === 'room_manager');
    const list: string[] = [];
    if (mgr && !away(mgr.user_id, d)) list.push(mgr.user_id);
    else for (const b of rows.filter((a: any) => a.kind === 'room_backup')) list.push(b.user_id);
    for (const x of rows.filter((a: any) => a.kind === 'room_delegate' && a.valid_from <= d && a.valid_to >= d)) list.push(x.user_id);
    return list;
  };
  return { who, can: (u, loc, d) => who(loc, d).includes(u) };
}


// ช่องทางติดต่อผู้ดูแลห้อง (แสดงเมื่อห้องชน/รออนุมัติ) — หลัก + สำรอง
export async function roomContacts(sb: any, locationIds: string[]) {
  const out = new Map<string, any[]>();
  if (!locationIds.length) return out;
  const { data } = await sb.from('staff_assignments').select('location_id, kind, users:user_id ( user_id, full_name, phone, email, line_id, telegram_chat_id )')
    .in('location_id', locationIds).in('kind', ['room_manager', 'room_backup']);
  for (const r of data ?? []) {
    const a = out.get(r.location_id) ?? [];
    a.push({ kind: r.kind, user_id: r.users?.user_id, full_name: r.users?.full_name, phone: r.users?.phone, email: r.users?.email, line_id: r.users?.line_id, telegram: !!r.users?.telegram_chat_id });
    out.set(r.location_id, a.sort((x: any) => (x.kind === 'room_manager' ? -1 : 1)));
  }
  return out;
}
