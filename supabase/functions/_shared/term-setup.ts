// ตั้งค่าเทอมล่วงหน้า (ใช้ใน manage): ห้อง, วันหยุด, ช่วงเวลาประจำสัปดาห์ → สร้างคาบทั้งเทอม, บทปฏิบัติการ, แผนบทรายคาบ
// หลักความปลอดภัยของข้อมูล: ไม่แตะคาบในอดีต · ไม่ลบคาบที่มีประวัติเช็คชื่อ · ทุกการเปลี่ยนคาบดูตัวอย่าง (diff) ก่อนบันทึก
// deno-lint-ignore-file no-explicit-any
import { bkkDate, fail, json } from './http.ts';
import { visibleSections, type Section, type Staff } from './staff-auth.ts';

type SB = any;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const t5 = (t: string) => String(t).slice(0, 5);
const isoDow = (d: string) => { const x = new Date(`${d}T00:00:00Z`).getUTCDay(); return x === 0 ? 7 : x; };
const addDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

async function sectionFor(sb: SB, me: Staff, id: string): Promise<Section | null> {
  return (await visibleSections(sb, me)).find((s) => s.section_id === id) ?? null;
}
async function courseEditable(sb: SB, me: Staff, courseId: string) {
  if (me.role === 'admin') return true;
  const { data } = await sb.from('lab_sections').select('section_id').eq('course_id', courseId).eq('instructor_id', me.user_id).limit(1);
  return (data ?? []).length > 0;
}

// ---------- วางแผนคาบจากช่วงเวลาประจำสัปดาห์ ----------
type Slot = { weekday: number; start_time: string; end_time: string; location_id: string };

async function planSessions(sb: SB, sec: Section, slots: Slot[], from: string, to: string) {
  const { data: term } = await sb.from('semesters').select('semester_id, start_date, end_date').eq('semester_id', sec.semester_id).single();
  const { data: hol } = await sb.from('term_holidays').select('holiday_date, name').eq('semester_id', sec.semester_id);
  const holidays = new Map<string, string>((hol ?? []).map((h: any): [string, string] => [h.holiday_date, h.name]));
  const today = bkkDate(new Date());

  // คาบที่ควรมี
  const desired = new Map<string, { class_date: string; start_time: string; end_time: string; location_id: string; slot_idx: number }>();
  const skippedHoliday: { date: string; name: string }[] = [];
  let pastSkipped = 0;
  for (let d = from; d <= to; d = addDay(d, 1)) {
    slots.forEach((s, i) => {
      if (isoDow(d) !== s.weekday) return;
      if (holidays.has(d)) { skippedHoliday.push({ date: d, name: holidays.get(d)! }); return; }
      desired.set(`${d}|${t5(s.start_time)}`, { class_date: d, start_time: t5(s.start_time), end_time: t5(s.end_time), location_id: s.location_id, slot_idx: i });
    });
  }
  // คาบที่มีอยู่แล้ว (ทั้งกลุ่มเรียน) + มีประวัติเช็คชื่อไหม
  const { data: ex } = await sb.from('schedules').select('schedule_id, class_date, start_time, end_time, location_id, status, topic_id').eq('section_id', sec.section_id).order('class_date');
  const ids = (ex ?? []).map((s: any) => s.schedule_id);
  const attended = new Set<string>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data: att } = await sb.from('attendance_records').select('schedule_id').in('schedule_id', ids.slice(i, i + 300));
    for (const a of att ?? []) attended.add(a.schedule_id);
  }
  const create: any[] = [], update: any[] = [], keep: any[] = [], remove: any[] = [], blocked: any[] = [];
  const matched = new Set<string>();
  const leftover: any[] = [];
  for (const s of ex ?? []) {
    const key = `${s.class_date}|${t5(s.start_time)}`;
    const want = desired.get(key);
    if (want && !matched.has(key)) {
      matched.add(key);
      const same = t5(s.end_time) === want.end_time && s.location_id === want.location_id;
      if (s.class_date < today || same || attended.has(s.schedule_id)) keep.push({ ...s, slot_idx: want.slot_idx });
      else update.push({ schedule_id: s.schedule_id, class_date: s.class_date, from_start: t5(s.start_time), start_time: want.start_time, from_end: t5(s.end_time), end_time: want.end_time, from_location: s.location_id, location_id: want.location_id, slot_idx: want.slot_idx });
    } else if (s.class_date >= today) leftover.push(s);
  }
  // เปลี่ยนเวลาในวันเดิม (เช่น 09:00 → 10:00) = แก้คาบเดิม ไม่ลบแล้วสร้างใหม่ → บทที่ผูกไว้ไม่หาย
  for (const s of leftover) {
    const pair = attended.has(s.schedule_id) ? undefined : [...desired.entries()].find(([k, w]) => !matched.has(k) && w.class_date === s.class_date);
    if (pair) {
      matched.add(pair[0]);
      const w = pair[1];
      update.push({ schedule_id: s.schedule_id, class_date: s.class_date, from_start: t5(s.start_time), start_time: w.start_time, from_end: t5(s.end_time), end_time: w.end_time, from_location: s.location_id, location_id: w.location_id, slot_idx: w.slot_idx });
    } else {
      (attended.has(s.schedule_id) ? blocked : remove).push({ schedule_id: s.schedule_id, class_date: s.class_date, start_time: t5(s.start_time), end_time: t5(s.end_time), has_topic: !!s.topic_id });
    }
  }
  for (const [key, w] of desired) {
    if (matched.has(key)) continue;
    if (w.class_date < today) { pastSkipped++; continue; }
    create.push(w);
  }
  // ห้องชนกับกลุ่มเรียนอื่น (เตือน ไม่บล็อก — บางห้องใช้ร่วมกันได้จริง)
  const conflicts: any[] = [];
  const check = [...create, ...update];
  const locs = [...new Set(check.map((c: any) => c.location_id))];
  if (locs.length) {
    const { data: others } = await sb.from('schedules').select('class_date, start_time, end_time, location_id, lab_sections ( section_no, courses ( course_code ) )')
      .in('location_id', locs).gte('class_date', from).lte('class_date', to).eq('status', 'scheduled').neq('section_id', sec.section_id);
    const byKey = new Map<string, any[]>();
    for (const o of others ?? []) { const k = `${o.location_id}|${o.class_date}`; const a = byKey.get(k) ?? []; a.push(o); byKey.set(k, a); }
    for (const c of check) {
      for (const o of byKey.get(`${c.location_id}|${c.class_date}`) ?? []) {
        if (t5(o.start_time) < c.end_time && t5(o.end_time) > c.start_time) {
          conflicts.push({ class_date: c.class_date, start_time: c.start_time, end_time: c.end_time, with: `${o.lab_sections?.courses?.course_code ?? ''} กลุ่ม ${o.lab_sections?.section_no ?? ''} ${t5(o.start_time)}–${t5(o.end_time)}` });
        }
      }
    }
  }
  return { term, today, create, update, keep, remove, blocked, skippedHoliday, pastSkipped, conflicts };
}

async function applySessions(sb: SB, me: Staff, sec: Section, slots: Slot[], from: string, to: string, plan: any) {
  await sb.from('lab_sections').update({ teach_from: from, teach_to: to }).eq('section_id', sec.section_id);
  // แทนที่ช่วงเวลาประจำสัปดาห์ (คาบเดิมจะถูกผูกกับช่วงใหม่ด้านล่าง)
  await sb.from('section_slots').delete().eq('section_id', sec.section_id);
  let slotIds: string[] = [];
  if (slots.length) {
    const { data, error } = await sb.from('section_slots').insert(slots.map((s) => ({ section_id: sec.section_id, ...s }))).select('slot_id');
    if (error) throw error;
    slotIds = (data ?? []).map((x: any) => x.slot_id);
  }
  // การจองห้องของคาบที่ระบบสร้าง (1 รายการต่อกลุ่มเรียน)
  let bookingId: string | null = null;
  if (plan.create.length) {
    const { data: bk } = await sb.from('room_bookings').select('booking_id').eq('section_id', sec.section_id).eq('recurrence_rule', 'GENERATED_WEEKLY').limit(1);
    bookingId = bk?.[0]?.booking_id ?? null;
    if (!bookingId) {
      const first = plan.create[0];
      const { data, error } = await sb.from('room_bookings').insert({
        location_id: first.location_id, booking_type: 'class_schedule', section_id: sec.section_id, requested_by: me.user_id,
        purpose: 'สร้างจากช่วงเวลาประจำสัปดาห์', start_datetime: `${first.class_date}T${first.start_time}:00+07:00`,
        end_datetime: `${first.class_date}T${first.end_time}:00+07:00`, recurrence_rule: 'GENERATED_WEEKLY', status: 'approved',
        approved_by: me.user_id, approved_at: new Date().toISOString(),
      }).select('booking_id').single();
      if (error) throw error;
      bookingId = data.booking_id;
    }
  }
  const rows = plan.create.map((c: any) => ({
    booking_id: bookingId, section_id: sec.section_id, location_id: c.location_id, class_date: c.class_date,
    start_time: c.start_time, end_time: c.end_time, slot_id: slotIds[c.slot_idx] ?? null, status: 'scheduled',
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from('schedules').insert(rows.slice(i, i + 200));
    if (error) throw error;
  }
  for (const u of plan.update) {
    const { error } = await sb.from('schedules').update({ start_time: u.start_time, end_time: u.end_time, location_id: u.location_id, slot_id: slotIds[u.slot_idx] ?? null }).eq('schedule_id', u.schedule_id);
    if (error) throw error;
  }
  // ผูกคาบเดิมที่ตรงกับช่วงใหม่
  const bySlot = new Map<number, string[]>();
  for (const k of plan.keep) { const a = bySlot.get(k.slot_idx) ?? []; a.push(k.schedule_id); bySlot.set(k.slot_idx, a); }
  for (const [idx, ids] of bySlot) if (slotIds[idx]) await sb.from('schedules').update({ slot_id: slotIds[idx] }).in('schedule_id', ids);
  // ลบคาบอนาคตที่ไม่มีในแผน (เฉพาะที่ไม่มีประวัติเช็คชื่อ)
  const rm = plan.remove.map((r: any) => r.schedule_id);
  for (let i = 0; i < rm.length; i += 200) {
    const chunk = rm.slice(i, i + 200);
    await sb.from('notification_logs').delete().in('schedule_id', chunk);
    const { error } = await sb.from('schedules').delete().in('schedule_id', chunk);
    if (error) throw error;
  }
  return { created: rows.length, updated: plan.update.length, removed: rm.length };
}

function cleanSlots(input: unknown): Slot[] | string {
  if (!Array.isArray(input)) return 'ไม่มีช่วงเวลา';
  const out: Slot[] = [];
  for (const s of input as any[]) {
    const w = Number(s?.weekday);
    if (!(w >= 1 && w <= 7)) return 'วันในสัปดาห์ไม่ถูกต้อง';
    if (!TIME.test(String(s?.start_time)) || !TIME.test(String(s?.end_time)) || t5(s.end_time) <= t5(s.start_time)) return 'เวลาเริ่ม/เลิกไม่ถูกต้อง';
    if (!s?.location_id) return 'ต้องเลือกห้อง';
    out.push({ weekday: w, start_time: t5(s.start_time), end_time: t5(s.end_time), location_id: String(s.location_id) });
  }
  const keys = out.map((s) => `${s.weekday}|${s.start_time}`);
  if (new Set(keys).size !== keys.length) return 'มีช่วงเวลาซ้ำกัน';
  return out;
}

// ---------- ตัวจัดการ action ----------
export async function handleSetup(sb: SB, me: Staff, body: Record<string, any>): Promise<Response | null> {
  const isAdmin = me.role === 'admin';
  switch (body.action) {
    case 'rooms_save': {
      if (!isAdmin) return fail('FORBIDDEN', 'เฉพาะแอดมิน', 403);
      const lat = Number(body.latitude), lng = Number(body.longitude), r = Number(body.radius_meters ?? 30);
      const name = String(body.name ?? '').trim();
      if (!name) return fail('BAD_REQUEST', 'ต้องมีชื่อห้อง', 400);
      if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || (lat === 0 && lng === 0)) return fail('BAD_REQUEST', 'พิกัดไม่ถูกต้อง', 400);
      if (!(r >= 5 && r <= 500)) return fail('BAD_REQUEST', 'รัศมีต้องอยู่ระหว่าง 5–500 เมตร', 400);
      const row = { name: name.slice(0, 100), building: String(body.building ?? '').trim() || null, floor: String(body.floor ?? '').trim() || null, latitude: lat, longitude: lng, radius_meters: Math.round(r) };
      const q = body.location_id ? sb.from('locations').update(row).eq('location_id', body.location_id) : sb.from('locations').insert(row);
      const { data, error } = await q.select().single();
      if (error) throw error;
      return json({ data });
    }

    case 'holidays_get': {
      const { data } = await sb.from('term_holidays').select('holiday_date, name').eq('semester_id', String(body.semester_id ?? '')).order('holiday_date');
      return json({ data: { holidays: data ?? [] } });
    }
    case 'holidays_save': {
      if (!isAdmin) return fail('FORBIDDEN', 'เฉพาะแอดมิน', 403);
      const semesterId = String(body.semester_id ?? '');
      const list = (Array.isArray(body.holidays) ? body.holidays : []).filter((h: any) => DATE.test(String(h?.date)));
      const dates = list.map((h: any) => h.date);
      let del = sb.from('term_holidays').delete().eq('semester_id', semesterId);
      if (dates.length) del = del.not('holiday_date', 'in', `(${dates.join(',')})`);
      await del;
      if (list.length) {
        const { error } = await sb.from('term_holidays').upsert(list.map((h: any) => ({ semester_id: semesterId, holiday_date: h.date, name: String(h.name || 'วันหยุด').slice(0, 100) })), { onConflict: 'semester_id,holiday_date' });
        if (error) throw error;
      }
      return json({ data: { saved: list.length } });
    }

    case 'setup_get': {
      const sec = await sectionFor(sb, me, String(body.section_id ?? ''));
      if (!sec) return fail('NOT_FOUND', 'ไม่พบกลุ่มเรียน หรือไม่มีสิทธิ์', 404);
      const [{ data: s2 }, { data: term }, { data: slots }, { data: sch }, { data: topics }, { data: hol }] = await Promise.all([
        sb.from('lab_sections').select('teach_from, teach_to').eq('section_id', sec.section_id).single(),
        sb.from('semesters').select('start_date, end_date').eq('semester_id', sec.semester_id).single(),
        sb.from('section_slots').select('slot_id, weekday, start_time, end_time, location_id').eq('section_id', sec.section_id).order('weekday'),
        sb.from('schedules').select('schedule_id, class_date, start_time, end_time, status, location_id, topic_id, slot_id, note, locations ( name )').eq('section_id', sec.section_id).order('class_date').order('start_time'),
        sb.from('lab_topics').select('topic_id, seq, title_th, title_en, note').eq('course_id', sec.course_id).order('seq'),
        sb.from('term_holidays').select('holiday_date, name').eq('semester_id', sec.semester_id).order('holiday_date'),
      ]);
      const ids = (sch ?? []).map((s: any) => s.schedule_id);
      const attended = new Set<string>();
      for (let i = 0; i < ids.length; i += 300) {
        const { data: att } = await sb.from('attendance_records').select('schedule_id').in('schedule_id', ids.slice(i, i + 300));
        for (const a of att ?? []) attended.add(a.schedule_id);
      }
      return json({ data: {
        section: sec, teach_from: s2?.teach_from ?? term?.start_date, teach_to: s2?.teach_to ?? term?.end_date, term,
        slots: (slots ?? []).map((s: any) => ({ ...s, start_time: t5(s.start_time), end_time: t5(s.end_time) })),
        sessions: (sch ?? []).map((s: any) => ({ schedule_id: s.schedule_id, class_date: s.class_date, start_time: t5(s.start_time), end_time: t5(s.end_time), status: s.status, room: s.locations?.name, location_id: s.location_id, topic_id: s.topic_id, slot_id: s.slot_id, note: s.note, has_attendance: attended.has(s.schedule_id) })),
        topics: topics ?? [], holidays: hol ?? [], course_editable: await courseEditable(sb, me, sec.course_id),
      } });
    }

    case 'slots_plan': {
      const sec = await sectionFor(sb, me, String(body.section_id ?? ''));
      if (!sec) return fail('NOT_FOUND', 'ไม่พบกลุ่มเรียน หรือไม่มีสิทธิ์', 404);
      if (!sec.editable) return fail('FORBIDDEN', 'ตั้งเวลาได้เฉพาะอาจารย์ผู้สอนหรือแอดมิน', 403);
      const slots = cleanSlots(body.slots);
      if (typeof slots === 'string') return fail('BAD_REQUEST', slots, 400);
      const from = String(body.teach_from ?? ''), to = String(body.teach_to ?? '');
      if (!DATE.test(from) || !DATE.test(to) || to < from) return fail('BAD_REQUEST', 'ช่วงวันที่สอนไม่ถูกต้อง', 400);
      if ((new Date(to).getTime() - new Date(from).getTime()) / 86400000 > 200) return fail('BAD_REQUEST', 'ช่วงวันที่ยาวเกิน 200 วัน', 400);
      const plan = await planSessions(sb, sec, slots, from, to);
      const brief = (arr: any[]) => arr.slice(0, 60);
      const summary = {
        create: brief(plan.create), update: brief(plan.update), remove: brief(plan.remove), blocked: brief(plan.blocked),
        counts: { conflicts: plan.conflicts.length, create: plan.create.length, update: plan.update.length, keep: plan.keep.length, remove: plan.remove.length, blocked: plan.blocked.length, past_skipped: plan.pastSkipped, holidays: plan.skippedHoliday.length },
        holidays: plan.skippedHoliday, today: plan.today, conflicts: brief(plan.conflicts),
      };
      if (body.apply !== true) return json({ data: summary });
      const res = await applySessions(sb, me, sec, slots, from, to, plan);
      return json({ data: { ...summary, applied: res } });
    }

    case 'topics_save': {
      const courseId = String(body.course_id ?? '');
      if (!(await courseEditable(sb, me, courseId))) return fail('FORBIDDEN', 'แก้บทได้เฉพาะอาจารย์ที่สอนวิชานี้หรือแอดมิน', 403);
      const list = (Array.isArray(body.topics) ? body.topics : []).map((t: any, i: number) => ({
        topic_id: t?.topic_id || undefined, seq: Number.isFinite(Number(t?.seq)) ? Number(t.seq) : i + 1,
        title_th: String(t?.title_th ?? '').trim().slice(0, 200), title_en: String(t?.title_en ?? '').trim().slice(0, 200) || null,
        note: String(t?.note ?? '').trim().slice(0, 500) || null,
      }));
      if (list.some((t: any) => !t.title_th)) return fail('BAD_REQUEST', 'ทุกบทต้องมีชื่อภาษาไทย', 400);
      const keepIds = list.filter((t: any) => t.topic_id).map((t: any) => t.topic_id);
      let del = sb.from('lab_topics').delete().eq('course_id', courseId);
      if (keepIds.length) del = del.not('topic_id', 'in', `(${keepIds.join(',')})`);
      await del; // คาบที่ผูกบทที่ถูกลบ → topic_id เป็นว่าง (on delete set null)
      const now = new Date().toISOString();
      for (const t of list) {
        const row = { course_id: courseId, seq: t.seq, title_th: t.title_th, title_en: t.title_en, note: t.note, updated_at: now };
        const { error } = t.topic_id ? await sb.from('lab_topics').update(row).eq('topic_id', t.topic_id).eq('course_id', courseId) : await sb.from('lab_topics').insert(row);
        if (error) throw error;
      }
      const { data } = await sb.from('lab_topics').select('topic_id, seq, title_th, title_en, note').eq('course_id', courseId).order('seq');
      return json({ data: { topics: data ?? [] } });
    }

    case 'topics_copy': {
      const to = String(body.to_course_id ?? ''), from = String(body.from_course_id ?? '');
      if (!(await courseEditable(sb, me, to))) return fail('FORBIDDEN', 'ไม่มีสิทธิ์แก้บทของวิชานี้', 403);
      const { data: src } = await sb.from('lab_topics').select('seq, title_th, title_en, note').eq('course_id', from).order('seq');
      if (!src?.length) return fail('NOT_FOUND', 'วิชาต้นทางยังไม่มีบท', 404);
      const { data: cur } = await sb.from('lab_topics').select('seq').eq('course_id', to);
      const base = Math.max(0, ...(cur ?? []).map((x: any) => x.seq));
      const { error } = await sb.from('lab_topics').insert(src.map((t: any, i: number) => ({ ...t, course_id: to, seq: (cur?.length ? base + i + 1 : t.seq) })));
      if (error) throw error;
      return json({ data: { copied: src.length } });
    }

    case 'session_plan_save': {
      // { assignments: [{ schedule_id, topic_id?: string|null, status?: 'scheduled'|'cancelled', note?: string }] }
      const list = Array.isArray(body.assignments) ? body.assignments.slice(0, 500) : [];
      if (!list.length) return json({ data: { updated: 0 } });
      const { data: sch } = await sb.from('schedules').select('schedule_id, section_id, class_date').in('schedule_id', list.map((a: any) => a.schedule_id));
      const secs = new Map((await visibleSections(sb, me)).map((s) => [s.section_id, s]));
      const { data: att } = await sb.from('attendance_records').select('schedule_id').in('schedule_id', list.map((a: any) => a.schedule_id)).limit(5000);
      const attended = new Set((att ?? []).map((a: any) => a.schedule_id));
      let updated = 0;
      for (const a of list) {
        const s = (sch ?? []).find((x: any) => x.schedule_id === a.schedule_id);
        if (!s || !secs.get(s.section_id)?.editable) continue;
        const patch: Record<string, unknown> = {};
        if ('topic_id' in a) patch.topic_id = a.topic_id || null;
        if (a.status === 'scheduled' || (a.status === 'cancelled' && !attended.has(a.schedule_id))) patch.status = a.status; // คาบที่มีเช็คชื่อแล้วงดไม่ได้
        if (typeof a.note === 'string') patch.note = a.note.trim().slice(0, 300) || null;
        if (!Object.keys(patch).length) continue;
        const { error } = await sb.from('schedules').update(patch).eq('schedule_id', a.schedule_id);
        if (error) throw error;
        updated++;
      }
      return json({ data: { updated } });
    }

    case 'plan_autofill': {
      // เรียงบทตามลำดับให้คาบของกลุ่มเรียน (คาบที่ k = บทที่ k) — ข้ามคาบที่ยกเลิก · only_empty = ไม่ทับที่ตั้งไว้แล้ว
      const ids: string[] = Array.isArray(body.section_ids) ? body.section_ids : [];
      const secs = (await visibleSections(sb, me)).filter((s) => ids.includes(s.section_id) && s.editable);
      if (!secs.length) return fail('FORBIDDEN', 'ไม่มีกลุ่มเรียนที่แก้ได้', 403);
      const out: Record<string, number> = {};
      for (const sec of secs) {
        const { data: topics } = await sb.from('lab_topics').select('topic_id, seq').eq('course_id', sec.course_id).order('seq');
        const { data: sch } = await sb.from('schedules').select('schedule_id, topic_id, status').eq('section_id', sec.section_id).eq('status', 'scheduled').order('class_date').order('start_time');
        let n = 0;
        for (let k = 0; k < (sch ?? []).length; k++) {
          const s = sch[k], t = topics?.[k]?.topic_id ?? null;
          if (body.only_empty && s.topic_id) continue;
          if (s.topic_id === t) continue;
          await sb.from('schedules').update({ topic_id: t }).eq('schedule_id', s.schedule_id);
          n++;
        }
        out[sec.section_id] = n;
      }
      return json({ data: { updated: out } });
    }
  }
  return null;
}
