/*
 * CSE-SMART-LAB · หน้าบุคลากร — ปฏิทินของฉัน · ห้อง · งาน · รออนุมัติ
 * ใช้ตัวช่วยจาก staff.html: $, esc, toast, staffApi, show, go, bkkToday, addDays, courseColor
 * API: Edge Function "work" (ปฏิทิน งาน คำขอลา เลื่อน/งดคาบ) + "booking" (ห้อง)
 *
 * หลักสิทธิ์ (ฝั่งเซิร์ฟเวอร์ตรวจซ้ำทุกครั้ง — หน้าเว็บแค่ซ่อนปุ่มที่ใช้ไม่ได้)
 *   จองห้อง: ผู้ดูแลห้องอนุมัติ/ปฏิเสธ · ผู้ขอใช้เป็นผู้ย้าย/ยกเลิก · ผู้ดูแลห้อง "ขอให้ย้าย" ได้ (ไม่บังคับ)
 *   คาบเรียน: ผู้ประสานรายวิชา (หลัก → รองเมื่อหลักไม่อยู่) เลื่อน/งด/เปลี่ยนห้อง และบันทึกเหตุผล
 *   ตารางงาน: ผู้ใช้สร้างและจัดการเอง · ผู้ประสานแก้งานของวิชาได้
 *   คำขอลา: อาจารย์ผู้สอนกลุ่มเรียนนั้นอนุมัติ
 */
(() => {
  'use strict';
  const wApi = (a, x = {}) => staffApi(a, x, 'work');
  const bApi = (a, x = {}) => staffApi(a, x, 'booking');
  const W = (window.W = {});
  let INIT = null, initP = null, pollT = null;

  // ---------- ตัวช่วย ----------
  const WD = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.'];
  const dow = (d) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = จันทร์
  const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
  const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const fmtD = (d, o = {}) => new Date(`${d}T12:00:00+07:00`).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short', ...o });
  const fmtLong = (d) => fmtD(d, { weekday: 'long', month: 'long', year: 'numeric' });
  const fmtDT = (iso) => (iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const hmIso = (iso) => new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
  const dayIso = (iso) => new Date(new Date(iso).getTime() + 7 * 3600e3).toISOString().slice(0, 10);
  const isoAt = (d, t) => `${d}T${t}:00+07:00`;
  const nowMin = () => { const n = new Date(Date.now() + 7 * 3600e3); return n.getUTCHours() * 60 + n.getUTCMinutes(); };
  const narrow = () => window.matchMedia('(max-width: 760px)').matches;
  const thMonthOf = (d) => new Date(`${d}T12:00:00+07:00`).toLocaleDateString('th-TH', { month: 'long', year: 'numeric', timeZone: 'Asia/Bangkok' });
  const roundTo = (m, step = 30) => Math.round(m / step) * step;
  const tint = (c, p = 14) => `color-mix(in srgb, ${c} ${p}%, white)`;
  const opt = (v, label, sel) => `<option value="${esc(v)}"${String(v) === String(sel ?? '') ? ' selected' : ''}>${esc(label)}</option>`;
  const person = (id) => INIT?.people.find((p) => p.user_id === id);
  const room = (id) => INIT?.rooms.find((r) => r.location_id === id);
  const isAdmin = () => !!INIT?.caps.admin;
  const myRoom = (locId) => isAdmin() || (INIT?.caps.my_rooms ?? []).includes(locId);
  const OPEN_KINDS = ['prep', 'reading', 'research', 'project', 'service', 'exam', 'event', 'training', 'maintenance'];
  const CLASS_KINDS = ['class', 'makeup'];
  const STATUS_TAG = { pending: ['amber', 'รออนุมัติ'], approved: ['teal', 'อนุมัติแล้ว'], rejected: ['red', 'ไม่อนุมัติ'], cancelled: ['', 'ยกเลิก'] };
  const statusTag = (s) => { const [c, t] = STATUS_TAG[s] ?? ['', s]; return `<span class="tag ${c}">${esc(t)}</span>`; };

  async function busy(btn, fn) {
    const old = btn?.textContent;
    if (btn) { btn.disabled = true; btn.dataset.old = old; }
    try { return await fn(); } finally { if (btn) { btn.disabled = false; } }
  }

  // ---------- หน้าต่าง (modal) + เมนู ----------
  let openMenuEl = null;
  function closeMenu() { openMenuEl?.remove(); openMenuEl = null; }
  document.addEventListener('click', (e) => { if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('[data-menu-anchor]')) closeMenu(); });
  function menu(x, y, title, items) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'menu';
    m.innerHTML = (title ? `<div class="mh">${esc(title)}</div>` : '') + items.map((it, i) => `<button data-i="${i}">${it.label}</button>`).join('');
    document.body.appendChild(m);
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = `${Math.max(8, Math.min(x, window.scrollX + document.documentElement.clientWidth - w - 8))}px`;
    m.style.top = `${Math.max(8, Math.min(y, window.scrollY + window.innerHeight - h - 8))}px`;
    m.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => { closeMenu(); items[Number(b.dataset.i)].run(); }));
    openMenuEl = m;
  }

  function modal(title, html, { wide = false, onClose } = {}) {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<div class="box" role="dialog" aria-modal="true" style="${wide ? '' : 'max-width:580px'}">
      <div class="row" style="margin-bottom:6px"><h3>${esc(title)}</h3><span class="spacer"></span><button class="btn btn-ghost btn-sm" data-x>ปิด</button></div>
      <div data-body>${html}</div><div class="err" data-err></div></div>`;
    document.body.appendChild(m);
    const key = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { m.remove(); document.removeEventListener('keydown', key); onClose?.(); };
    document.addEventListener('keydown', key);
    m.addEventListener('mousedown', (e) => { if (e.target === m) close(); });
    m.querySelector('[data-x]').onclick = close;
    const q = (s) => m.querySelector(s);
    return {
      el: m, q, qa: (s) => [...m.querySelectorAll(s)], close,
      err: (msg) => { q('[data-err]').textContent = msg || ''; },
      body: (h) => { q('[data-body]').innerHTML = h; },
    };
  }
  // ยืนยันพร้อมช่องเหตุผล (คืน null ถ้ากดยกเลิก)
  function ask(title, { label = 'เหตุผล', required = false, okText = 'ยืนยัน', danger = false, extra = '' } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const md = modal(title, `${extra}<div class="fgrid"><div class="full"><label>${esc(label)}${required ? ' *' : ''}</label><textarea data-note></textarea></div></div>
        <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ยกเลิก</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText)}</button></div>`,
      { onClose: () => { if (!done) resolve(null); } });
      md.q('[data-no]').onclick = () => md.close();
      md.q('[data-ok]').onclick = () => {
        const v = md.q('[data-note]').value.trim();
        if (required && !v) return md.err(`กรุณาใส่${label}`);
        done = true; md.close(); resolve(v);
      };
      setTimeout(() => md.q('[data-note]').focus(), 30);
    });
  }

  // ---------- เริ่มต้น ----------
  W.init = () => {
    if (!initP) {
      initP = wApi('init').then((d) => {
        INIT = d;
        assignColors(d.courses.map((c) => c.course_code).filter(Boolean));
        return d;
      }).catch((e) => { initP = null; throw e; });
    }
    return initP;
  };
  W.data = () => INIT;
  W.reset = () => { INIT = null; initP = null; cal.loaded = false; clearInterval(pollT); pollT = null; };
  W.start = () => { W.refreshBadges(); clearInterval(pollT); pollT = setInterval(() => { if (!document.hidden) W.refreshBadges(); }, 60000); };
  const setNb = (k, n) => document.querySelectorAll(`[data-nb="${k}"]`).forEach((el) => (el.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : ''));
  let badges = {};
  W.refreshBadges = async () => {
    try {
      badges = await wApi('inbox');
      setNb('inbox', badges.booking_queue + badges.move_requests + badges.leave_requests);
      setNb('tasks', badges.tasks_today + badges.tasks_overdue);
      setNb('q', badges.booking_queue); setNb('mv', badges.move_requests); setNb('lv', badges.leave_requests);
    } catch { /* เงียบ */ }
  };

  // =====================================================================
  // ปฏิทินของฉัน
  // =====================================================================
  const LAYERS = [
    ['sessions', 'คาบเรียน', '#3C6E58'], ['tasks', 'งาน', '#C68A2E'], ['bookings', 'จองห้อง', '#2F5F8F'],
    ['holidays', 'วันหยุด', '#B23A2E'], ['leaves', 'ไม่อยู่/ลา', '#6E5FA8'],
  ];
  const cal = { view: 'week', anchor: null, show: 'mine', people: [], rooms: [], courses: [], layers: LAYERS.map((l) => l[0]), items: [], pick: false, seq: 0, loaded: false };
  const itemColor = (it) => it.type === 'session' ? courseColor(it.course_code || '?') : it.type === 'task' ? '#C68A2E' : it.type === 'booking' ? '#2F5F8F' : it.type === 'holiday' ? '#B23A2E' : '#6E5FA8';
  const FLAG = { no_room: ['fl-noroom', 'ไม่มีห้อง'], room_pending: ['fl-pend', 'รอห้อง'], makeup: ['fl-mk', 'ชดเชย'], overdue: ['fl-od', 'เลยกำหนด'], pending: ['fl-pend', 'รออนุมัติ'], private: ['fl-mk', '🔒'] };
  const flagHtml = (it) => (it.flags || []).filter((f) => FLAG[f]).map((f) => `<em class="fl ${FLAG[f][0]}">${FLAG[f][1]}</em>`).join('');

  function saveCalSettings() {
    clearTimeout(saveCalSettings.t);
    saveCalSettings.t = setTimeout(() => {
      wApi('cal_settings_save', { settings: { show: cal.show, people: cal.people, rooms: cal.rooms, courses: cal.courses, layers: cal.layers, view: cal.view } }).catch(() => {});
    }, 700);
  }

  function calRange() {
    const a = cal.anchor;
    if (cal.view === 'day') return { from: a, to: a, days: [a] };
    if (cal.view === 'week') {
      const n = narrow() ? 3 : 7, from = n === 7 ? addDays(a, -dow(a)) : a;
      const days = [...Array(n)].map((_, i) => addDays(from, i));
      return { from, to: days[n - 1], days };
    }
    if (cal.view === 'month') {
      const first = `${a.slice(0, 7)}-01`, from = addDays(first, -dow(first));
      const days = [...Array(42)].map((_, i) => addDays(from, i));
      return { from, to: days[41], days, ym: a.slice(0, 7) };
    }
    const days = [...Array(21)].map((_, i) => addDays(a, i));
    return { from: a, to: days[20], days };
  }
  function calStep(dir) {
    if (cal.view === 'day') return addDays(cal.anchor, dir);
    if (cal.view === 'week') return addDays(cal.anchor, dir * (narrow() ? 3 : 7));
    if (cal.view === 'agenda') return addDays(cal.anchor, dir * 21);
    const [y, m] = cal.anchor.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10);
  }
  const myHash = (view = cal.view, d = cal.anchor) => `#my/${view}/${d}`;

  function buildMySkeleton() {
    if ($('viewMy').dataset.built) return;
    $('viewMy').dataset.built = '1';
    $('viewMy').innerHTML = `
      <div class="wbar">
        <button class="btn btn-ghost btn-sm" id="myPrev" aria-label="ก่อนหน้า">◀</button>
        <button class="btn btn-ghost btn-sm" id="myToday">วันนี้</button>
        <button class="btn btn-ghost btn-sm" id="myNext" aria-label="ถัดไป">▶</button>
        <h2 id="myTitle"></h2>
        <span class="spacer"></span>
        <div class="segc" id="myView"><button data-v="day">วัน</button><button data-v="week">สัปดาห์</button><button data-v="month">เดือน</button><button data-v="agenda">รายการ</button></div>
        <button class="btn btn-primary btn-sm" id="myNew" data-menu-anchor>+ สร้าง</button>
      </div>
      <div class="wbar">
        <span class="muted">แสดง</span>
        <div class="segc" id="myShow"><button data-s="mine">ของฉัน</button><button data-s="selected">ของฉัน + ที่เลือก</button><button data-s="all">ทั้งหมด</button></div>
        <button class="btn btn-ghost btn-sm" id="myPickBtn">เลือกคน/ห้อง/วิชา</button>
        <span class="spacer"></span><span class="muted" id="myCount"></span>
      </div>
      <div class="pickpanel" id="myPick" hidden></div>
      <div class="layers" id="myLayers"></div>
      <div id="myBody"><div class="skel"></div></div>
      <div class="err" id="myErr"></div>
      <button class="fab" id="myFab" aria-label="สร้าง" data-menu-anchor>+</button>`;
    $('myPrev').onclick = () => go(myHash(cal.view, calStep(-1)));
    $('myNext').onclick = () => go(myHash(cal.view, calStep(1)));
    $('myToday').onclick = () => go(myHash(cal.view, bkkToday()));
    $('myView').querySelectorAll('button').forEach((b) => (b.onclick = () => { cal.view = b.dataset.v; saveCalSettings(); go(myHash(b.dataset.v, cal.anchor)); }));
    $('myShow').querySelectorAll('button').forEach((b) => (b.onclick = () => {
      cal.show = b.dataset.s; if (cal.show === 'selected' && !cal.people.length && !cal.rooms.length && !cal.courses.length) cal.pick = true;
      saveCalSettings(); renderMyChrome(); loadMy();
    }));
    $('myPickBtn').onclick = () => { cal.pick = !cal.pick; renderMyChrome(); };
    const newMenu = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      createMenu(r.left + window.scrollX, r.bottom + window.scrollY + 4, { date: cal.view === 'day' ? cal.anchor : bkkToday() });
    };
    $('myNew').onclick = newMenu; $('myFab').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); createMenu(r.left + window.scrollX - 150, r.top + window.scrollY - 150, { date: cal.view === 'day' ? cal.anchor : bkkToday() }); };
    let lastNarrow = narrow();
    window.addEventListener('resize', () => { if (narrow() !== lastNarrow && !$('viewMy').hidden && cal.view === 'week') { lastNarrow = narrow(); loadMy(); } });
  }

  function renderMyChrome() {
    $('myView').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === cal.view));
    $('myShow').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.s === cal.show));
    const nSel = cal.people.length + cal.rooms.length + cal.courses.length;
    $('myPickBtn').textContent = `เลือกคน/ห้อง/วิชา${nSel ? ` (${nSel})` : ''} ${cal.pick ? '▴' : '▾'}`;
    $('myPickBtn').hidden = cal.show !== 'selected';
    $('myPick').hidden = !(cal.pick && cal.show === 'selected');
    if (!$('myPick').hidden) renderPicker();
    $('myLayers').innerHTML = LAYERS.map(([k, t, c]) => `<button class="layer ${cal.layers.includes(k) ? 'on' : ''}" data-l="${k}"><i style="background:${c}"></i>${t}</button>`).join('')
      + `<span class="muted" style="margin-left:6px">เส้นประ = ของคนอื่น · ขอบทึบ = ของฉัน</span>`;
    $('myLayers').querySelectorAll('[data-l]').forEach((b) => (b.onclick = () => {
      const k = b.dataset.l; cal.layers = cal.layers.includes(k) ? cal.layers.filter((x) => x !== k) : [...cal.layers, k];
      saveCalSettings(); renderMyChrome(); loadMy();
    }));
    const r = calRange();
    $('myTitle').textContent = cal.view === 'day' ? fmtLong(r.from)
      : cal.view === 'month' ? thMonthOf(r.ym + '-15')
      : `${fmtD(r.from, { weekday: undefined })} – ${fmtD(r.to, { weekday: undefined, year: 'numeric' })}`;
  }

  function renderPicker() {
    const box = $('myPick');
    const col = (key, title, rows) => `<div><h4>${title}</h4><input type="search" placeholder="ค้นหา…" data-f="${key}">
      <div class="picklist" data-k="${key}">${rows.map((r) => `<label class="pick" data-s="${esc((r.label + ' ' + (r.sub || '')).toLowerCase())}"><input type="checkbox" value="${esc(r.id)}" ${cal[key].includes(r.id) ? 'checked' : ''}> <span>${esc(r.label)} ${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></label>`).join('')}</div></div>`;
    box.innerHTML =
      col('people', '👤 บุคลากร', INIT.people.filter((p) => !p.is_me).map((p) => ({ id: p.user_id, label: p.full_name, sub: p.position }))) +
      col('rooms', '🏫 ห้อง', INIT.rooms.map((r) => ({ id: r.location_id, label: r.name, sub: [r.room_code, r.zone].filter(Boolean).join(' · ') }))) +
      col('courses', '📚 รายวิชา', uniqBy(INIT.courses, 'course_id').map((c) => ({ id: c.course_id, label: c.course_code, sub: c.course_name })));
    box.querySelectorAll('[data-f]').forEach((inp) => (inp.oninput = () => {
      const q = inp.value.trim().toLowerCase();
      box.querySelectorAll(`[data-k="${inp.dataset.f}"] .pick`).forEach((l) => (l.hidden = q && !l.dataset.s.includes(q)));
    }));
    box.querySelectorAll('.picklist').forEach((list) => list.querySelectorAll('input').forEach((c) => (c.onchange = () => {
      const k = list.dataset.k;
      cal[k] = [...list.querySelectorAll('input:checked')].map((x) => x.value);
      saveCalSettings(); renderMyChrome(); loadMy();
    })));
  }
  const uniqBy = (arr, k) => { const s = new Set(); return arr.filter((x) => (s.has(x[k]) ? false : s.add(x[k]))); };

  W.openMy = async (view, date) => {
    show('viewMy');
    buildMySkeleton();
    try { await W.init(); } catch (e) { $('myErr').textContent = e.message; return; }
    if (!cal.loaded) {
      const s = INIT.calendar_settings || {};
      cal.show = s.show || 'mine'; cal.people = s.people || []; cal.rooms = s.rooms || []; cal.courses = s.courses || [];
      cal.layers = Array.isArray(s.layers) && s.layers.length ? s.layers : cal.layers;
      cal.view = s.view || (narrow() ? 'agenda' : 'week');
      cal.loaded = true;
    }
    if (['day', 'week', 'month', 'agenda'].includes(view)) cal.view = view;
    cal.anchor = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : (cal.anchor || bkkToday());
    renderMyChrome();
    loadMy();
  };

  async function loadMy() {
    const r = calRange(), seq = ++cal.seq;
    $('myErr').textContent = '';
    $('myBody').classList.add('loading');
    try {
      const d = await wApi('cal_feed', { from: r.from, to: r.to, show: cal.show, people: cal.people, rooms: cal.rooms, courses: cal.courses, layers: cal.layers });
      if (seq !== cal.seq) return;
      cal.items = d.items;
      $('myCount').textContent = `${d.counts.total} รายการ${cal.show !== 'mine' ? ` · ของฉัน ${d.counts.mine}` : ''}`;
      renderMyBody();
    } catch (e) { if (seq === cal.seq) $('myErr').textContent = e.message; }
    finally { if (seq === cal.seq) $('myBody').classList.remove('loading'); }
  }
  W.reloadMy = () => { if (!$('viewMy').hidden) loadMy(); };

  const coversDay = (it, d) => it.date === d || (it.end_date && it.date <= d && it.end_date >= d);

  // รวมคาบของวิชาเดียวกันที่เวลาเดียวกัน (ผู้ประสาน/เจ้าหน้าที่ดูแลหลายกลุ่ม) เป็นก้อนเดียว — คลิกแล้วเลือกกลุ่ม
  function groupSessions(items) {
    const out = [], map = new Map();
    cal.groups = new Map();
    for (const it of items) {
      if (it.type !== 'session') { out.push(it); continue; }
      const k = [it.date, it.start, it.end, it.course_code, it.status, it.mine ? 1 : 0].join('|');
      let g = map.get(k);
      if (!g) { g = { key: k, list: [] }; map.set(k, g); out.push(g); }
      g.list.push(it);
    }
    return out.map((g) => {
      if (!g.list) return g;
      if (g.list.length === 1) return g.list[0];
      const f = g.list[0], id = `g:${g.key}`;
      const v = {
        ...f, id, title: `${f.course_code} · ${g.list.length} กลุ่ม`,
        sub: [...new Set(g.list.map((x) => x.sub).filter(Boolean))].join(' / '),
        room: [...new Set(g.list.map((x) => x.room).filter(Boolean))].join(', '),
        flags: [...new Set(g.list.flatMap((x) => x.flags || []))],
        who: [...new Set(g.list.map((x) => x.who).filter(Boolean))].join(', ') || null, group: g.list,
      };
      cal.groups.set(id, v);
      return v;
    });
  }

  function renderMyBody() {
    cal.view_items = groupSessions(cal.items);
    const r = calRange();
    if (cal.view === 'month') renderMonth(r);
    else if (cal.view === 'agenda') renderAgenda(r);
    else renderTimeGrid(r);
  }

  function layoutDay(evs) {
    evs.sort((a, b) => a.s - b.s || b.e - a.e);
    let cluster = [], cols = [], end = -1;
    const flush = () => { cluster.forEach((x) => (x.n = cols.length)); cluster = []; cols = []; };
    for (const ev of evs) {
      if (cluster.length && ev.s >= end) flush();
      let c = cols.findIndex((e) => e <= ev.s);
      if (c < 0) { c = cols.length; cols.push(ev.e); } else cols[c] = ev.e;
      ev.c = c; cluster.push(ev); end = Math.max(end, ev.e);
    }
    flush();
    return evs;
  }

  function renderTimeGrid(r) {
    const days = r.days, n = days.length, today = bkkToday();
    const items = cal.view_items;
    const isAllDay = (i) => !i.start || i.type === 'holiday' || i.type === 'away';
    const timed = items.filter((i) => !isAllDay(i) && days.includes(i.date));
    let h0 = 7, h1 = 19;
    for (const i of timed) { h0 = Math.min(h0, Math.floor(toMin(i.start) / 60)); h1 = Math.max(h1, Math.ceil(toMin(i.end || i.start) / 60) + (i.end ? 0 : 1)); }
    h1 = Math.min(24, Math.max(h1, h0 + 2));
    const HH = narrow() ? 42 : 48, px = HH / 60;
    const hol = new Map(items.filter((i) => i.type === 'holiday').map((i) => [i.date, i.title]));
    const head = `<div></div>` + days.map((d) => `<div data-day="${d}" class="${d === today ? 'today' : ''} ${hol.has(d) ? 'hol' : ''}" title="${esc(hol.get(d) || '')}"><span>${WD[dow(d)]}</span><b>${Number(d.slice(8))}</b></div>`).join('');
    const allRow = `<div>ทั้งวัน</div>` + days.map((d) => `<div>${items.filter((i) => isAllDay(i) && coversDay(i, d)).map((i) =>
      `<button class="ad t-${i.type} ${i.mine ? '' : 'other'}" data-id="${esc(i.id)}" title="${esc(i.title)}" style="${i.type === 'task' ? `border-color:${itemColor(i)}` : ''}">${i.type === 'task' ? (i.status === 'done' ? '✓ ' : '☐ ') : ''}${esc(i.title)}</button>`).join('')}</div>`).join('');
    const hours = [...Array(h1 - h0)].map((_, k) => `<div>${String(h0 + k).padStart(2, '0')}:00</div>`).join('');
    const cols = days.map((d) => {
      const evs = layoutDay(timed.filter((i) => i.date === d).map((i) => ({ it: i, s: toMin(i.start), e: Math.max(toMin(i.end || i.start), toMin(i.start) + 30) })));
      const body = evs.map(({ it, s, e, c, n: k }) => {
        const col = itemColor(it), h = Math.max(20, (e - s) * px - 2);
        const cls = [it.mine ? '' : 'other', it.status === 'cancelled' ? 'cancel' : '', it.status === 'done' ? 'done' : ''].join(' ');
        const line2 = [`${it.start}${it.end ? '–' + it.end : ''}`, it.room].filter(Boolean).join(' · ');
        const line3 = it.who ? `👤 ${it.who}` : it.sub;
        return `<button class="ev ${cls}" data-id="${esc(it.id)}" style="top:${(s - h0 * 60) * px}px;height:${h}px;left:calc(${(c * 100) / k}% + 2px);width:calc(${100 / k}% - 4px);border-color:${col};background-color:${it.mine ? tint(col, 16) : '#fff'}">
          <b>${it.type === 'task' ? (it.status === 'done' ? '✓ ' : '☐ ') : ''}${esc(it.title)}${flagHtml(it)}</b>${h > 30 ? `<span>${esc(line2)}</span>` : ''}${h > 46 && line3 ? `<span>${esc(line3)}</span>` : ''}</button>`;
      }).join('');
      const nowLine = d === today && nowMin() >= h0 * 60 && nowMin() <= h1 * 60 ? `<div class="tg-now" style="top:${(nowMin() - h0 * 60) * px}px"></div>` : '';
      return `<div class="tg-col ${d === today ? 'today' : ''} ${hol.has(d) ? 'hol' : ''}" data-col="${d}" style="height:${(h1 - h0) * HH}px">${body}${nowLine}</div>`;
    }).join('');
    $('myBody').innerHTML = `<div class="tg" style="--n:${n};--hh:${HH}px">
      <div class="tg-head">${head}</div><div class="tg-all">${allRow}</div>
      <div class="tg-scroll"><div class="tg-body"><div class="tg-hours">${hours}</div>${cols}</div></div></div>
      ${items.length ? '' : `<div class="empty" style="margin-top:10px">ไม่มีรายการในช่วงนี้${cal.show === 'mine' ? ' — ลองเลือก "ทั้งหมด" หรือ "ของฉัน + ที่เลือก" เพื่อดูของคนอื่น' : ''}</div>`}`;
    const sc = $('myBody').querySelector('.tg-scroll');
    const focus = days.includes(today) ? Math.max(h0 * 60, nowMin() - 90) : 8 * 60;
    sc.scrollTop = Math.max(0, (focus - h0 * 60) * px);
    $('myBody').querySelectorAll('[data-id]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openItem(b.dataset.id); }));
    $('myBody').querySelectorAll('.tg-head [data-day]').forEach((b) => (b.onclick = () => go(myHash('day', b.dataset.day))));
    $('myBody').querySelectorAll('[data-col]').forEach((col) => (col.onclick = (e) => {
      if (e.target !== col) return;
      const rect = col.getBoundingClientRect();
      const m = Math.max(h0 * 60, Math.min(h1 * 60 - 60, roundTo(h0 * 60 + (e.clientY - rect.top) / px, 30)));
      createMenu(e.pageX, e.pageY, { date: col.dataset.col, start: fromMin(m), end: fromMin(Math.min(23 * 60 + 30, m + 120)) });
    }));
  }

  function renderMonth(r) {
    const today = bkkToday(), ym = r.ym;
    const head = WD.map((w, i) => `<div class="wd" style="${i >= 5 ? 'color:var(--brick)' : ''}">${w}</div>`).join('');
    const cells = r.days.map((d) => {
      const list = cal.view_items.filter((i) => coversDay(i, d));
      const hol = list.find((i) => i.type === 'holiday');
      const rest = list.filter((i) => i.type !== 'holiday').sort((a, b) => (b.mine - a.mine) || String(a.start ?? '').localeCompare(String(b.start ?? '')));
      const max = 4;
      const chips = rest.slice(0, max).map((i) => `<span class="mchip ${i.mine ? '' : 'other'} ${i.status === 'cancelled' ? 'cancel' : ''}" data-id="${esc(i.id)}" style="border-left-color:${itemColor(i)}">${i.start ? `<span class="mono">${i.start}</span> ` : ''}${esc(i.title)}</span>`).join('');
      return `<button class="mcell ${d.slice(0, 7) !== ym ? 'out' : ''} ${d === today ? 'today' : ''} ${hol ? 'hol' : ''}" data-d="${d}">
        <span class="dn">${Number(d.slice(8))}${hol ? `<small>${esc(hol.title)}</small>` : ''}</span>${chips}${rest.length > max ? `<span class="mmore">+ อีก ${rest.length - max}</span>` : ''}</button>`;
    }).join('');
    $('myBody').innerHTML = `<div class="mg">${head}${cells}</div>`;
    $('myBody').querySelectorAll('.mchip[data-id]').forEach((c) => (c.onclick = (e) => { e.stopPropagation(); openItem(c.dataset.id); }));
    $('myBody').querySelectorAll('[data-d]').forEach((c) => (c.onclick = () => go(myHash('day', c.dataset.d))));
  }

  function renderAgenda(r) {
    const today = bkkToday();
    const html = r.days.map((d) => {
      const list = cal.view_items.filter((i) => coversDay(i, d));
      if (!list.length) return '';
      return `<div class="agd"><h3 class="${d === today ? 'today' : ''}">${fmtD(d)}${d === today ? ' · วันนี้' : ''} <small>${list.length} รายการ</small></h3>${list.map((i) => {
        const col = itemColor(i);
        return `<button class="agi ${i.mine ? '' : 'other'} ${i.status === 'cancelled' ? 'cancel' : ''}" data-id="${esc(i.id)}" style="border-left-color:${col}">
          <span class="tm">${i.start ? `${i.start}${i.end ? '–' + i.end : ''}` : 'ทั้งวัน'}</span>
          <span class="tt">${i.type === 'task' ? (i.status === 'done' ? '✓ ' : '☐ ') : ''}${esc(i.title)} ${flagHtml(i)}<small>${esc([i.sub, i.room, i.who && `👤 ${i.who}`].filter(Boolean).join(' · '))}</small></span>
          <span class="side">${i.type === 'session' && i.status === 'cancelled' ? '<span class="tag red">งด</span>' : ''}${i.type === 'booking' ? statusTag(i.status) : ''}</span></button>`;
      }).join('')}</div>`;
    }).join('');
    $('myBody').innerHTML = html || `<div class="empty">ไม่มีรายการใน 3 สัปดาห์นี้</div>`;
    $('myBody').querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => openItem(b.dataset.id)));
  }

  function createMenu(x, y, pre) {
    menu(x, y, pre.start ? `${fmtD(pre.date)} ${pre.start}` : fmtD(pre.date), [
      { label: '📝 งาน', run: () => taskForm({ task_date: pre.date, start_time: pre.start || '' }) },
      { label: '🏫 จองห้อง', run: () => bookingForm({ date: pre.date, start: pre.start, end: pre.end }) },
      { label: '🙈 วันที่ฉันไม่อยู่', run: () => awayForm({ from: pre.date }) },
    ]);
  }

  // ---------- รายละเอียดรายการในปฏิทิน ----------
  function openItem(id) {
    if (cal.groups?.has(id)) return groupDetail(cal.groups.get(id));
    const it = cal.items.find((i) => i.id === id);
    if (!it) return;
    if (it.type === 'session') return sessionDetail(it);
    if (it.type === 'task') return taskDetail(it);
    if (it.type === 'booking') return bookingDetailById(it.ref.reservation_id);
    if (it.type === 'away') return awayDetail(it);
    modal(it.title, `<dl class="dl"><dt>วันที่</dt><dd>${fmtLong(it.date)}</dd><dt>ประเภท</dt><dd>วันหยุดของเทอม</dd></dl>`);
  }

  function groupDetail(g) {
    const md = modal(`${g.course_code} · ${fmtD(g.date)} ${g.start}–${g.end}`, `
      <div class="muted" style="margin-bottom:8px">${g.group.length} กลุ่มเรียนเวลาเดียวกัน — เลือกกลุ่มเพื่อดู/จัดการ</div>
      ${g.group.map((x, i) => `<button class="agi ${x.mine ? '' : 'other'} ${x.status === 'cancelled' ? 'cancel' : ''}" data-i="${i}" style="border-left-color:${itemColor(x)}">
        <span class="tm">กลุ่ม ${esc(x.ref.section_no)}</span><span class="tt">${esc(x.room || '—')} ${flagHtml(x)}<small>${esc([x.sub, x.ref.instructor].filter(Boolean).join(' · '))}</small></span><span class="side"></span></button>`).join('')}`);
    md.qa('[data-i]').forEach((b) => (b.onclick = () => { md.close(); sessionDetail(g.group[Number(b.dataset.i)]); }));
  }

  function sessionDetail(it) {
    const f = it.ref, past = Date.parse(isoAt(it.date, it.end || it.start)) < Date.now();
    const cancelled = it.status === 'cancelled';
    const reasonTh = { not_needed: 'ไม่ต้องเรียนแล้ว (ไม่คิดต้นทุน)', postponed: 'เลื่อน (คิดที่คาบชดเชย)', other_held: 'งดตามตาราง แต่มีการเรียนรูปแบบอื่น (คิดต้นทุน)' };
    const roomState = it.flags.includes('no_room') ? '<span class="tag red">ยังไม่มีห้อง</span>' : it.flags.includes('room_pending') ? '<span class="tag amber">รอผู้ดูแลห้องอนุมัติ</span>' : cancelled ? '' : '<span class="tag teal">ได้ห้องแล้ว</span>';
    const md = modal(it.title, `
      <dl class="dl">
        <dt>วันเวลา</dt><dd>${fmtLong(it.date)} · <b class="mono">${it.start}–${it.end}</b></dd>
        <dt>วิชา</dt><dd>${esc(f.course_name || '')}</dd>
        <dt>บท</dt><dd>${esc(it.sub || '—')}</dd>
        <dt>ห้อง</dt><dd>${esc(it.room || '—')} ${f.room_code ? `<span class="muted">${esc(f.room_code)}</span>` : ''} ${roomState}</dd>
        <dt>ผู้สอน</dt><dd>${esc(f.instructor || '—')}</dd>
        ${f.roles?.length ? `<dt>หน้าที่ของฉัน</dt><dd class="rolechips">${f.roles.map((r) => `<span class="tag teal">${esc(r)}</span>`).join('')}</dd>` : ''}
        ${it.who ? `<dt>ของ</dt><dd>${esc(it.who)}</dd>` : ''}
        ${f.kind === 'makeup' ? `<dt>ชนิด</dt><dd><span class="tag blue">คาบชดเชย</span> ${esc(f.note || '')}</dd>` : ''}
        ${cancelled ? `<dt>สถานะ</dt><dd><span class="tag red">งด</span> ${esc(reasonTh[f.cancel_reason] || '')}<div class="muted">${esc(f.cancel_note || '')}</div></dd>` : ''}
      </dl>
      ${it.flags.includes('no_room') && f.can_manage ? `<div class="warnbox">ห้องเดิมไม่ว่างช่วงนี้ — เลือก "เปลี่ยนห้อง" เพื่อขอห้องอื่น (หรือห้องเดิมถ้าว่างแล้ว)</div>` : ''}
      <div class="row" style="margin-top:10px; gap:6px">
        <button class="btn btn-primary btn-sm" data-a="open">เปิดหน้าเช็คชื่อ</button>
        ${f.can_manage && !cancelled ? `<button class="btn btn-ghost btn-sm" data-a="room">🏫 เปลี่ยนห้อง</button><button class="btn btn-ghost btn-sm" data-a="post">🔁 เลื่อนคาบ</button><button class="btn btn-ghost btn-sm" data-a="cancel">🚫 งดคาบ</button>` : ''}
        ${f.can_manage && cancelled && f.cancel_reason !== 'postponed' ? `<button class="btn btn-ghost btn-sm" data-a="restore">↩︎ คืนคาบ</button>` : ''}
        ${(f.roles?.length || isAdmin()) && !cancelled ? `<button class="btn btn-ghost btn-sm" data-a="task">📝 งานของคาบนี้</button>` : ''}
      </div>
      ${!f.can_manage && f.roles?.length ? `<div class="muted" style="margin-top:8px">เลื่อน/งดคาบทำได้โดยผู้ประสานรายวิชา (หลัก หรือรองเมื่อหลักไม่อยู่)</div>` : ''}
      ${past && !cancelled && f.can_manage ? `<div class="muted" style="margin-top:6px">คาบที่ผ่านแล้ว: ถ้าไม่ได้เรียนจริง ให้ "งดคาบ" พร้อมเหตุผล เพื่อให้คิดชั่วโมง/ต้นทุนถูก</div>` : ''}`);
    md.qa('[data-a]').forEach((b) => (b.onclick = async () => {
      const a = b.dataset.a;
      if (a === 'open') { md.close(); return go(`#s/${f.schedule_id}`); }
      if (a === 'task') { md.close(); return taskForm({ task_date: it.date, schedule_id: f.schedule_id, title: `เตรียม ${it.title}`, task_type: 'prep', course_label: `${it.title} · ${fmtD(it.date)}` }); }
      if (a === 'post') { md.close(); return postponeForm(it); }
      if (a === 'cancel') { md.close(); return cancelForm(it); }
      if (a === 'room') { md.close(); return sessionRoomForm(it); }
      if (a === 'restore') {
        await busy(b, async () => {
          try { const r = await wApi('session_restore', { schedule_id: f.schedule_id }); md.close(); toast(r.has_room ? 'คืนคาบแล้ว · ขอห้องให้แล้ว' : 'คืนคาบแล้ว · ห้องไม่ว่าง ต้องเลือกห้องใหม่'); afterChange(); }
          catch (e) { md.err(e.message); }
        });
      }
    }));
  }

  function roomOptions(sel, { all = true } = {}) {
    const zones = new Map();
    for (const r of INIT.rooms) { if (!all && r.room_status === 'closed') continue; const z = r.zone || 'ไม่ระบุโซน'; zones.set(z, [...(zones.get(z) || []), r]); }
    return [...zones].map(([z, rs]) => `<optgroup label="${esc(z)}">${rs.map((r) => opt(r.location_id, `${r.name}${r.room_code ? ` (${r.room_code})` : ''}${r.room_status === 'closed' ? ' · ปิด' : ''}`, sel)).join('')}</optgroup>`).join('');
  }

  // ห้องว่างช่วงเวลา → แสดงใต้ช่องเลือกห้อง
  async function showFree(md, date, st, en, targetSel, outSel) {
    const out = md.q(outSel);
    if (!date || !st || !en || en <= st) { out.innerHTML = ''; return; }
    out.innerHTML = '<span class="muted">กำลังตรวจห้องว่าง…</span>';
    try {
      const d = await bApi('free_rooms', { starts_at: isoAt(date, st), ends_at: isoAt(date, en) });
      const cur = md.q(targetSel).value;
      const ok = d.rooms.some((r) => r.location_id === cur);
      out.innerHTML = `${ok ? '<span class="tag teal">ห้องที่เลือกว่าง</span>' : '<span class="tag red">ห้องที่เลือกไม่ว่าง</span>'}
        ${d.rooms.length ? `<div class="muted" style="margin-top:4px">ห้องว่างช่วงนี้: ${d.rooms.map((r) => `<a href="#" data-pick="${esc(r.location_id)}">${esc(r.name)}</a>`).join(' · ')}</div>` : '<div class="muted">ไม่มีห้องว่างเลยช่วงนี้</div>'}`;
      out.querySelectorAll('[data-pick]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); md.q(targetSel).value = a.dataset.pick; showFree(md, date, st, en, targetSel, outSel); }));
    } catch (e) { out.innerHTML = `<span class="muted">${esc(e.message)}</span>`; }
  }

  function postponeForm(it) {
    const f = it.ref;
    const md = modal(`เลื่อนคาบ · ${it.title}`, `
      <div class="okbox" style="font-size:13px">จาก <b>${fmtD(it.date)} ${it.start}–${it.end}</b> · ${esc(it.room || '')}<br>คาบเดิมจะถูกบันทึกเป็น "เลื่อน" และสร้าง <b>คาบชดเชย</b> ในวันเวลาใหม่ (บทเดิมตามไปด้วย) · ชั่วโมง/ต้นทุนคิดที่คาบชดเชย</div>
      <div class="fgrid" style="margin-top:10px">
        <div><label>วันใหม่ *</label><input type="date" data-k="date" value="${addDays(it.date, 7)}" min="${bkkToday()}"></div>
        <div class="row" style="gap:6px"><div style="flex:1"><label>เริ่ม *</label><input type="time" data-k="st" value="${it.start}" step="300"></div><div style="flex:1"><label>เลิก *</label><input type="time" data-k="en" value="${it.end}" step="300"></div></div>
        <div class="full"><label>ห้อง</label><select data-k="loc">${roomOptions(it.location_id)}</select><div class="hint" data-free></div></div>
        <div class="full"><label>เหตุผล/หมายเหตุ (แจ้งผู้สอนและผู้เกี่ยวข้อง)</label><textarea data-k="note" placeholder="เช่น ตรงกับกิจกรรมคณะ"></textarea></div>
      </div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ยกเลิก</button><button class="btn btn-primary" data-ok>เลื่อนคาบ</button></div>`);
    const v = (k) => md.q(`[data-k="${k}"]`).value;
    const check = () => showFree(md, v('date'), v('st'), v('en'), '[data-k="loc"]', '[data-free]');
    md.qa('[data-k="date"],[data-k="st"],[data-k="en"],[data-k="loc"]').forEach((el) => (el.onchange = check));
    check();
    md.q('[data-no]').onclick = md.close;
    md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
      md.err('');
      try {
        const r = await wApi('session_postpone', { schedule_id: f.schedule_id, date: v('date'), start_time: v('st'), end_time: v('en'), location_id: v('loc'), note: v('note') });
        md.close();
        toast(r.has_room ? 'เลื่อนแล้ว · ส่งคำขอห้องให้แล้ว' : 'เลื่อนแล้ว · ห้องไม่ว่าง ต้องเปลี่ยนห้องที่คาบชดเชย');
        cal.anchor = v('date'); afterChange();
      } catch (er) { md.err(er.message); }
    });
  }

  function cancelForm(it) {
    const f = it.ref;
    const md = modal(`งดคาบ · ${it.title}`, `
      <div class="muted" style="margin-bottom:8px">${fmtLong(it.date)} ${it.start}–${it.end} · ${esc(it.room || '')}</div>
      <div class="radio">
        <label><input type="radio" name="rs" value="not_needed" checked><span><b>ไม่ต้องเรียนคาบนี้แล้ว</b><small>ไม่นับชั่วโมงใช้ห้อง/ต้นทุน</small></span></label>
        <label><input type="radio" name="rs" value="other_held"><span><b>งดตามตาราง แต่มีการเรียนในรูปแบบอื่น</b><small>เช่น สอนออนไลน์/รวมกลุ่ม — นับชั่วโมง/ต้นทุนตามปกติ</small></span></label>
      </div>
      <div class="muted" style="margin:8px 0">ถ้าจะ <b>เลื่อน</b> ไปวันอื่น ให้ใช้ปุ่ม "เลื่อนคาบ" แทน (นับที่คาบชดเชย)</div>
      <div class="fgrid"><div class="full"><label>รายละเอียด * (บันทึกไว้ในประวัติและแจ้งผู้เกี่ยวข้อง)</label><textarea data-k="note"></textarea></div></div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ไม่งด</button><button class="btn btn-danger" data-ok>งดคาบ</button></div>`);
    md.q('[data-no]').onclick = md.close;
    md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
      const note = md.q('[data-k="note"]').value.trim();
      if (!note) return md.err('กรุณาใส่รายละเอียด');
      try {
        await wApi('session_cancel', { schedule_id: f.schedule_id, reason: md.q('input[name=rs]:checked').value, note });
        md.close(); toast('งดคาบแล้ว · ยกเลิกการจองห้องให้แล้ว'); afterChange();
      } catch (er) { md.err(er.message); }
    });
  }

  function sessionRoomForm(it) {
    const f = it.ref;
    const md = modal(`เปลี่ยนห้อง · ${it.title}`, `
      <div class="muted" style="margin-bottom:8px">${fmtLong(it.date)} ${it.start}–${it.end} · ตอนนี้: ${esc(it.room || '—')}</div>
      <div class="fgrid"><div class="full"><label>ห้องใหม่</label><select data-k="loc">${roomOptions(it.location_id)}</select><div class="hint" data-free></div></div></div>
      <div class="muted" style="margin-top:8px">ระบบส่งคำขอห้องให้อัตโนมัติ — ผู้ดูแลห้องเป็นผู้อนุมัติ</div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ยกเลิก</button><button class="btn btn-primary" data-ok>บันทึก</button></div>`);
    const check = () => showFree(md, it.date, it.start, it.end, '[data-k="loc"]', '[data-free]');
    md.q('[data-k="loc"]').onchange = check; check();
    md.q('[data-no]').onclick = md.close;
    md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
      try {
        const r = await wApi('session_set_room', { schedule_id: f.schedule_id, location_id: md.q('[data-k="loc"]').value });
        md.close(); toast(r.has_room ? 'เปลี่ยนห้องแล้ว · รอผู้ดูแลห้องอนุมัติ' : 'ห้องนี้ไม่ว่าง'); afterChange();
      } catch (er) { md.err(er.message); }
    });
  }

  function afterChange() { W.reloadMy(); W.refreshBadges(); if (!$('viewRooms').hidden) loadRooms(); if (!$('viewTasks').hidden) loadTasks(); if (!$('viewInbox').hidden) loadInbox(); }
  W.afterChange = afterChange;

  // ---------- งาน ----------
  function taskDetail(it) {
    const f = it.ref;
    const md = modal(it.title, `
      <dl class="dl">
        <dt>วัน</dt><dd>${fmtLong(it.date)}${it.start ? ` · <b class="mono">${it.start}${it.end ? '–' + it.end : ''}</b>` : ''}${f.duration_hours ? ` (${Number(f.duration_hours)} ชม.)` : ''}</dd>
        <dt>ประเภท</dt><dd>${esc(it.sub || '')}</dd>
        ${it.room ? `<dt>ห้อง</dt><dd>${esc(it.room)}</dd>` : ''}
        <dt>ผู้รับงาน</dt><dd>${esc(person(f.assignee_id)?.full_name || '—')}</dd>
        <dt>สร้างโดย</dt><dd>${esc(person(f.created_by)?.full_name || '—')}${f.source === 'rule' ? ' <span class="tag">จากสิ่งที่ต้องเตรียมต่อบท</span>' : ''}</dd>
        <dt>สถานะ</dt><dd>${it.status === 'done' ? '<span class="tag teal">เสร็จแล้ว</span>' : it.flags.includes('overdue') ? '<span class="tag red">เลยกำหนด</span>' : '<span class="tag amber">ต้องทำ</span>'} ${f.is_private ? '<span class="tag">🔒 ส่วนตัว</span>' : ''}</dd>
        ${f.note ? `<dt>หมายเหตุ</dt><dd>${esc(f.note)}</dd>` : ''}
      </dl>
      ${f.can_edit ? `<div class="row" style="gap:6px">
        <button class="btn ${it.status === 'done' ? 'btn-ghost' : 'btn-ok'} btn-sm" data-a="toggle">${it.status === 'done' ? '↩︎ ยังไม่เสร็จ' : '✓ ทำเสร็จแล้ว'}</button>
        <button class="btn btn-ghost btn-sm" data-a="edit">แก้ไข</button>
        <span class="spacer"></span><button class="btn btn-ghost btn-sm" data-a="del">ลบ</button></div>` : '<div class="muted">แก้ได้เฉพาะผู้สร้าง ผู้รับงาน หรือผู้ประสานรายวิชา</div>'}`);
    md.qa('[data-a]').forEach((b) => (b.onclick = () => busy(b, async () => {
      try {
        if (b.dataset.a === 'toggle') { await wApi('task_status', { task_id: f.task_id, status: it.status === 'done' ? 'todo' : 'done' }); md.close(); afterChange(); }
        if (b.dataset.a === 'edit') { md.close(); taskForm({ task_id: f.task_id, title: it.title, task_type: f.task_type, task_date: it.date, start_time: it.start || '', duration_hours: f.duration_hours, assignee_id: f.assignee_id, is_private: f.is_private, note: f.note, course_id: it.course_id, course_label: it.course_code }); }
        if (b.dataset.a === 'del') { if (!confirmInline(b)) return; await wApi('task_remove', { task_id: f.task_id }); md.close(); toast('ลบงานแล้ว'); afterChange(); }
      } catch (e) { md.err(e.message); }
    })));
  }
  // กดสองครั้งเพื่อยืนยัน (ไม่ใช้ confirm() ของเบราว์เซอร์)
  function confirmInline(btn) {
    if (btn.dataset.armed) return true;
    btn.dataset.armed = '1'; const t = btn.textContent; btn.textContent = 'กดอีกครั้งเพื่อยืนยัน'; btn.classList.add('btn-danger');
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = t; btn.classList.remove('btn-danger'); }, 3000);
    return false;
  }

  async function taskForm(p = {}) {
    await W.init();
    const editing = !!p.task_id;
    const myCourses = INIT.courses.filter((c) => isAdmin() || c.my_roles.length);
    const types = Object.entries(INIT.task_types);
    const md = modal(editing ? 'แก้ไขงาน' : 'งานใหม่', `
      <div class="fgrid">
        <div class="full"><label>ชื่องาน *</label><input data-k="title" value="${esc(p.title || '')}" maxlength="200" placeholder="เช่น เตรียมสารละลาย NaOH 0.1 M"></div>
        <div><label>ประเภท</label><select data-k="task_type">${types.map(([k, t]) => opt(k, t, p.task_type || 'other')).join('')}</select></div>
        <div><label>วันที่ *</label><input type="date" data-k="task_date" value="${esc(p.task_date || bkkToday())}"></div>
        <div><label>เวลาเริ่ม</label><input type="time" data-k="start_time" value="${esc(p.start_time || '')}" step="300"></div>
        <div><label>ใช้เวลา (ชม.)</label><input type="number" data-k="duration_hours" value="${esc(p.duration_hours ?? '')}" min="0.25" max="24" step="0.25" inputmode="decimal"></div>
        <div class="full"><label>ผู้รับงาน</label><select data-k="assignee_id">${INIT.people.map((u) => opt(u.user_id, `${u.full_name}${u.is_me ? ' (ฉัน)' : ''} · ${u.position}`, p.assignee_id || INIT.me.user_id)).join('')}</select></div>
        ${p.schedule_id ? `<div class="full"><label>ของคาบ</label><div>${esc(p.course_label || '')}</div></div>`
          : `<div class="full"><label>รายวิชา (ถ้าเป็นงานของวิชา)</label><select data-k="course">${opt('', '— งานทั่วไป / ส่วนตัว —', '')}${myCourses.map((c) => opt(`${c.course_id}|${c.semester_id}`, `${c.course_code} · ${c.course_name}`, p.course_id ? `${p.course_id}|${c.semester_id}` : '')).join('')}</select></div>`}
        <div class="full"><label class="inl"><input type="checkbox" data-k="is_private" ${p.is_private ? 'checked' : ''}> ส่วนตัว (คนอื่นไม่เห็นในปฏิทิน · ใช้ได้กับงานที่ไม่ใช่ของวิชา)</label></div>
        <div class="full"><label>หมายเหตุ</label><textarea data-k="note">${esc(p.note || '')}</textarea></div>
      </div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ยกเลิก</button><button class="btn btn-primary" data-ok>${editing ? 'บันทึก' : 'สร้างงาน'}</button></div>`);
    const v = (k) => md.q(`[data-k="${k}"]`);
    const syncPriv = () => { const c = v('course'); if (c) { v('is_private').disabled = !!c.value; if (c.value) v('is_private').checked = false; } };
    if (v('course')) { v('course').onchange = syncPriv; if (editing && p.course_id) v('course').disabled = true; }
    syncPriv();
    setTimeout(() => v('title').focus(), 30);
    md.q('[data-no]').onclick = md.close;
    md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
      md.err('');
      const [course_id, semester_id] = (v('course')?.value || '').split('|');
      const body = {
        task_id: p.task_id, title: v('title').value.trim(), task_type: v('task_type').value, task_date: v('task_date').value,
        start_time: v('start_time').value, duration_hours: v('duration_hours').value, assignee_id: v('assignee_id').value,
        is_private: v('is_private').checked, note: v('note').value, notify_assignee: editing && v('assignee_id').value !== p.assignee_id,
      };
      if (p.schedule_id) body.schedule_id = p.schedule_id;
      else if (!editing || !p.course_id) { body.course_id = course_id || ''; body.semester_id = semester_id || ''; }
      if (!body.title) return md.err('ใส่ชื่องาน');
      try { await wApi('task_save', body); md.close(); toast(editing ? 'บันทึกงานแล้ว' : 'สร้างงานแล้ว'); afterChange(); }
      catch (er) { md.err(er.message); }
    });
  }

  // ---------- ไม่อยู่ ----------
  function awayForm(p = {}) {
    const md = modal('วันที่ฉันไม่อยู่', `
      <div class="muted" style="margin-bottom:8px">ช่วงนี้ระบบจะส่งเรื่องอนุมัติห้อง/รายวิชาไปที่ผู้สำรองแทน · ถ้าไม่อยู่ทั้งหลักและสำรอง จะแจ้งด่วนทั้งคู่</div>
      <div class="fgrid">
        <div><label>ตั้งแต่ *</label><input type="date" data-k="from" value="${esc(p.from || bkkToday())}"></div>
        <div><label>ถึง *</label><input type="date" data-k="to" value="${esc(p.to || p.from || bkkToday())}"></div>
        <div class="full"><label>หมายเหตุ</label><input data-k="note" maxlength="200" placeholder="เช่น ไปราชการ"></div>
      </div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ยกเลิก</button><button class="btn btn-primary" data-ok>บันทึก</button></div>`);
    md.q('[data-k="from"]').onchange = () => { if (md.q('[data-k="to"]').value < md.q('[data-k="from"]').value) md.q('[data-k="to"]').value = md.q('[data-k="from"]').value; };
    md.q('[data-no]').onclick = md.close;
    md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
      try {
        await bApi('away_save', { from_date: md.q('[data-k="from"]').value, to_date: md.q('[data-k="to"]').value, note: md.q('[data-k="note"]').value });
        md.close(); toast('บันทึกวันไม่อยู่แล้ว'); afterChange();
      } catch (er) { md.err(er.message); }
    });
  }
  function awayDetail(it) {
    const md = modal(it.title, `<dl class="dl"><dt>ช่วงวันที่</dt><dd>${fmtD(it.date)}${it.end_date ? ` – ${fmtD(it.end_date)}` : ''}</dd>${it.sub ? `<dt>หมายเหตุ</dt><dd>${esc(it.sub)}</dd>` : ''}</dl>
      ${it.mine && it.ref.away_id ? '<div class="row"><span class="spacer"></span><button class="btn btn-ghost btn-sm" data-del>ลบ</button></div>' : ''}`);
    const del = md.q('[data-del]');
    if (del) del.onclick = () => busy(del, async () => {
      if (!confirmInline(del)) return;
      try { await bApi('away_delete', { away_id: it.ref.away_id }); md.close(); toast('ลบแล้ว'); afterChange(); } catch (e) { md.err(e.message); }
    });
  }

  // =====================================================================
  // ห้อง
  // =====================================================================
  const rm = { tab: 'board', date: null, zone: '', board: null, seq: 0 };
  const ROOM_TABS = [['board', '🗓️ ตารางห้อง'], ['mine', '📋 การจองของฉัน'], ['moves', '🙏 ขอให้ย้าย', 'mv'], ['term', '📊 ห้องต้นเทอม'], ['away', '🙈 วันไม่อยู่']];

  W.openRooms = async (tab, date) => {
    show('viewRooms');
    if (!$('viewRooms').dataset.built) {
      $('viewRooms').dataset.built = '1';
      $('viewRooms').innerHTML = `<div class="subtabs" id="rmTabs">${ROOM_TABS.map(([k, t, nb]) => `<button data-t="${k}">${t}${nb ? `<span class="nb" data-nb="${nb}"></span>` : ''}</button>`).join('')}</div>
        <div id="rmBody"></div><div class="err" id="rmErr"></div>`;
      $('rmTabs').querySelectorAll('button').forEach((b) => (b.onclick = () => go(b.dataset.t === 'board' ? `#rooms/board/${rm.date || bkkToday()}` : `#rooms/${b.dataset.t}`)));
      W.refreshBadges();
    }
    rm.tab = ROOM_TABS.some((t) => t[0] === tab) ? tab : 'board';
    if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) rm.date = date;
    rm.date ||= bkkToday();
    $('rmTabs').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.t === rm.tab));
    $('rmErr').textContent = '';
    try { await W.init(); } catch (e) { $('rmErr').textContent = e.message; return; }
    loadRooms();
  };

  function loadRooms() {
    const t = rm.tab;
    if (t === 'board') return loadBoard();
    if (t === 'mine') return loadMine();
    if (t === 'moves') return loadMoves();
    if (t === 'term') return loadTerm();
    if (t === 'away') return loadAway();
  }

  async function loadBoard() {
    const seq = ++rm.seq;
    if (!$('rmBody').querySelector('#rbWrap')) {
      $('rmBody').innerHTML = `<div class="wbar">
        <button class="btn btn-ghost btn-sm" id="rbPrev">◀</button><input type="date" id="rbDate"><button class="btn btn-ghost btn-sm" id="rbNext">▶</button>
        <button class="btn btn-ghost btn-sm" id="rbToday">วันนี้</button><h2 id="rbTitle" style="min-width:0"></h2>
        <span class="spacer"></span><select id="rbZone"></select><button class="btn btn-primary btn-sm" id="rbNew">+ ขอจองห้อง</button></div>
        <div class="rlegend"><span><i style="background:var(--teal)"></i>คาบเรียน</span><span><i style="background:var(--blue)"></i>จองอื่น ๆ</span><span><i style="background:#6b6b6b"></i>ปิดซ่อม</span>
        <span><i style="background:var(--blue);outline:2px dashed rgba(0,0,0,.3);outline-offset:-2px"></i>รออนุมัติ</span><span><i style="background:#fff;box-shadow:inset 0 0 0 2px #ffd36b"></i>ของฉัน</span><span><i style="background:rgba(60,110,88,.2)"></i>เวลาเตรียม/เก็บ</span>
        <span>· คลิกช่องว่างเพื่อขอจอง</span></div>
        <div id="rbWrap"><div class="skel"></div></div>`;
      $('rbPrev').onclick = () => go(`#rooms/board/${addDays(rm.date, -1)}`);
      $('rbNext').onclick = () => go(`#rooms/board/${addDays(rm.date, 1)}`);
      $('rbToday').onclick = () => go(`#rooms/board/${bkkToday()}`);
      $('rbDate').onchange = () => $('rbDate').value && go(`#rooms/board/${$('rbDate').value}`);
      $('rbZone').innerHTML = opt('', 'ทุกโซน', '') + INIT.zones.map((z) => opt(z.zone_id, z.name, '')).join('');
      $('rbZone').onchange = () => { rm.zone = $('rbZone').value; loadBoard(); };
      $('rbNew').onclick = () => bookingForm({ date: rm.date });
    }
    $('rbDate').value = rm.date; $('rbZone').value = rm.zone;
    $('rbTitle').textContent = fmtLong(rm.date);
    $('rbWrap').classList.add('loading');
    try {
      const d = await bApi('rooms_board', { date: rm.date, days: 1, zone_id: rm.zone || undefined });
      if (seq !== rm.seq) return;
      rm.board = d; renderBoard(d);
    } catch (e) { $('rmErr').textContent = e.message; }
    finally { $('rbWrap').classList.remove('loading'); }
  }

  function renderBoard(d) {
    let h0 = 7, h1 = 20;
    for (const r of d.reservations) {
      const s = r.date < rm.date ? 0 : toMin(r.start), e = dayIso(r.ends_at) > rm.date ? 24 * 60 : toMin(r.end);
      h0 = Math.min(h0, Math.floor((s - r.setup_minutes) / 60)); h1 = Math.max(h1, Math.ceil((e + r.teardown_minutes) / 60));
    }
    h0 = Math.max(0, h0); h1 = Math.min(24, h1);
    const HW = narrow() ? 52 : 68, pxm = HW / 60, TW = (h1 - h0) * HW;
    const X = (m) => (m - h0 * 60) * pxm;
    const hdr = `<div class="rb-h corner">ห้อง</div><div class="rb-h">${[...Array(h1 - h0 + 1)].map((_, k) => `<span class="hr" style="left:${k * HW}px">${String(h0 + k).padStart(2, '0')}</span>`).join('')}</div>`;
    const byZone = new Map();
    for (const r of d.rooms) byZone.set(r.zone || 'ไม่ระบุโซน', [...(byZone.get(r.zone || 'ไม่ระบุโซน') || []), r]);
    const zOrder = [...byZone.keys()].sort((a, b) => (INIT.zones.findIndex((z) => z.name === a) + 1 || 99) - (INIT.zones.findIndex((z) => z.name === b) + 1 || 99));
    const today = bkkToday();
    const rows = zOrder.map((z) => `<div class="rb-zone">${esc(z)}</div>` + byZone.get(z).map((r) => {
      const res = d.reservations.filter((x) => x.location_id === r.location_id);
      const contacts = (r.contacts || []).map((c) => `${c.kind === 'room_manager' ? 'ผู้ดูแล' : 'สำรอง'}: ${c.full_name}`).join(' · ');
      const blocks = res.map((x) => {
        const s = x.date < rm.date ? 0 : toMin(x.start), e = dayIso(x.ends_at) > rm.date ? 24 * 60 : toMin(x.end);
        const k = CLASS_KINDS.includes(x.kind) ? 'k-class' : x.kind === 'maintenance' ? 'k-maint' : 'k-other';
        const label = x.course_code ? `${x.course_code}${x.section_no ? ' ก.' + x.section_no : ''}` : (x.title || x.project_name || x.kind_th);
        const mine = x.requested_by === INIT.me.user_id;
        return `<div class="rv-pad" style="left:${X(s - x.setup_minutes)}px;width:${(e - s + x.setup_minutes + x.teardown_minutes) * pxm}px"></div>
          <button class="rv ${k} ${x.status === 'pending' || x.pending_change ? 'pending' : ''} ${mine ? 'mine' : ''}" data-r="${esc(x.reservation_id)}" style="left:${X(s)}px;width:${Math.max(18, (e - s) * pxm - 2)}px" title="${esc(`${x.start}–${x.end} ${label} · ${x.requester?.full_name || ''} · ${x.status_th}`)}">
            <b>${esc(label)}</b><span>${x.start}–${x.end}${x.status === 'pending' ? ' · รอ' : ''}</span><span>${esc(x.requester?.full_name || '')}</span></button>`;
      }).join('');
      const now = rm.date === today ? `<div class="rb-now" style="left:${X(nowMin())}px"></div>` : '';
      return `<div class="rb-room"><b>${esc(r.name)}</b><small>${esc([r.room_code, r.room_status === 'closed' ? 'ปิดใช้งาน' : ''].filter(Boolean).join(' · '))}</small>
          <small class="ct">${esc(contacts)}</small>${r.can_approve ? '<small class="mine">✓ ฉันอนุมัติห้องนี้ได้</small>' : ''}</div>
        <div class="rb-row ${r.room_status === 'closed' ? 'closed' : ''}" data-room="${esc(r.location_id)}">${blocks}${now}</div>`;
    }).join('')).join('');
    $('rbWrap').innerHTML = `<div class="rb"><div class="rb-grid" style="--tw:${TW}px;--hw:${HW}px">${hdr}${rows}</div></div>
      ${d.rooms.length ? '' : '<div class="empty">ไม่มีห้องในโซนนี้</div>'}`;
    const rb = $('rbWrap').querySelector('.rb');
    if (rm.date === today) rb.scrollLeft = Math.max(0, X(nowMin()) - 200);
    else rb.scrollLeft = Math.max(0, X(8 * 60) - 10);
    $('rbWrap').querySelectorAll('[data-r]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const x = d.reservations.find((y) => y.reservation_id === b.dataset.r); bookingDetail(x, d.rooms.find((r) => r.location_id === x.location_id)?.can_approve); }));
    $('rbWrap').querySelectorAll('[data-room]').forEach((row) => (row.onclick = (e) => {
      if (e.target !== row) return;
      const rect = row.getBoundingClientRect();
      const m = Math.max(0, Math.min(23 * 60, roundTo(h0 * 60 + (e.clientX - rect.left) / pxm, 30)));
      bookingForm({ location_id: row.dataset.room, date: rm.date, start: fromMin(m), end: fromMin(Math.min(23 * 60 + 30, m + 120)) });
    }));
  }

  // ---------- รายละเอียดการจอง ----------
  async function bookingDetailById(id) {
    try {
      const d = await bApi('rooms_board', { date: cal.items.find((i) => i.ref?.reservation_id === id)?.date || bkkToday(), days: 1 });
      const x = d.reservations.find((r) => r.reservation_id === id);
      if (!x) return toast('ไม่พบการจองนี้ (อาจถูกยกเลิกแล้ว)');
      bookingDetail(x, d.rooms.find((r) => r.location_id === x.location_id)?.can_approve);
    } catch (e) { toast(e.message); }
  }

  function bookingDetail(x, canApprove) {
    const mine = x.requested_by === INIT.me.user_id || isAdmin();
    const cls = CLASS_KINDS.includes(x.kind);
    const active = ['pending', 'approved'].includes(x.status);
    const r = room(x.location_id);
    const rq = x.requester || {};
    const pc = x.pending_change;
    const md = modal(`${x.kind_th}${x.course_code ? ` · ${x.course_code}${x.section_no ? ' กลุ่ม ' + x.section_no : ''}` : x.title ? ` · ${x.title}` : ''}`, `
      <dl class="dl">
        <dt>ห้อง</dt><dd>${esc(x.room || '')} ${x.room_code ? `<span class="muted">${esc(x.room_code)}</span>` : ''}</dd>
        <dt>วันเวลา</dt><dd>${fmtLong(x.date)} · <b class="mono">${x.start}–${x.end}</b>${x.setup_minutes || x.teardown_minutes ? ` <span class="muted">(+เตรียม ${x.setup_minutes} / เก็บ ${x.teardown_minutes} นาที)</span>` : ''}</dd>
        <dt>สถานะ</dt><dd>${statusTag(x.status)} ${x.decider ? `<span class="muted">โดย ${esc(x.decider)} ${fmtDT(x.decided_at)}</span>` : ''}${x.decision_note ? `<div class="muted">${esc(x.decision_note)}</div>` : ''}</dd>
        ${pc ? `<dt>ขอเปลี่ยนเป็น</dt><dd><span class="tag amber">รออนุมัติ</span> ${esc(room(pc.location_id)?.name || '')} ${fmtD(dayIso(pc.starts_at))} ${hmIso(pc.starts_at)}–${hmIso(pc.ends_at)}</dd>` : ''}
        ${x.course_name ? `<dt>วิชา</dt><dd>${esc(x.course_name)}</dd>` : ''}
        ${x.project_name ? `<dt>โครงการ</dt><dd>${esc(x.project_name)}</dd>` : ''}
        ${x.purpose ? `<dt>วัตถุประสงค์</dt><dd>${esc(x.purpose)}</dd>` : ''}
        <dt>ผู้ขอใช้</dt><dd>${esc(rq.full_name || '')}<div class="muted">${[rq.phone && `☎ <a href="tel:${esc(rq.phone)}">${esc(rq.phone)}</a>`, rq.email && `✉ ${esc(rq.email)}`, rq.line_id && `LINE ${esc(rq.line_id)}`].filter(Boolean).join(' · ')}</div></dd>
        ${x.actual_user ? `<dt>ผู้ใช้จริง</dt><dd>${esc(x.actual_user)}</dd>` : ''}
      </dl>
      ${cls ? `<div class="muted" style="margin-bottom:8px">คาบเรียน: เลื่อน/งด/เปลี่ยนห้อง ทำที่ "ปฏิทินของฉัน" โดยผู้ประสานรายวิชา</div>` : ''}
      <div class="row" style="gap:6px">
        ${canApprove && (x.status === 'pending' || pc) ? `<button class="btn btn-ok btn-sm" data-a="approve">✓ อนุมัติ</button><button class="btn btn-ghost btn-sm" data-a="reject">✕ ไม่อนุมัติ</button>` : ''}
        ${mine && active && !cls ? `<button class="btn btn-ghost btn-sm" data-a="change">ย้าย/แก้เวลา</button><button class="btn btn-ghost btn-sm" data-a="cancel">ยกเลิกการจอง</button>` : ''}
        ${canApprove && x.status === 'approved' && x.requested_by !== INIT.me.user_id ? `<button class="btn btn-ghost btn-sm" data-a="move">🙏 ขอให้ย้าย</button>` : ''}
        ${cls ? `<button class="btn btn-ghost btn-sm" data-a="cal">เปิดในปฏิทิน</button>` : ''}
      </div>
      ${canApprove && x.status === 'approved' && x.requested_by !== INIT.me.user_id ? '<div class="muted" style="margin-top:8px">อนุมัติไปแล้ว — ผู้ดูแลห้องยกเลิกเองไม่ได้ ต้อง "ขอให้ย้าย" แล้วให้ผู้ขอใช้ตัดสินใจ</div>' : ''}
      ${r ? '' : ''}`);
    md.qa('[data-a]').forEach((b) => (b.onclick = () => busy(b, async () => {
      md.err('');
      try {
        const a = b.dataset.a;
        if (a === 'approve') { await bApi('decide', { reservation_ids: [x.reservation_id], approve: true }); md.close(); toast('อนุมัติแล้ว'); afterChange(); }
        if (a === 'reject') { const note = await ask('ไม่อนุมัติการจอง', { required: true, okText: 'ไม่อนุมัติ', danger: true }); if (note === null) return; await bApi('decide', { reservation_ids: [x.reservation_id], approve: false, note }); md.close(); toast('แจ้งผู้ขอแล้ว'); afterChange(); }
        if (a === 'change') { md.close(); changeForm(x); }
        if (a === 'cancel') { md.close(); cancelBookingForm(x); }
        if (a === 'move') { md.close(); moveRequestForm(x); }
        if (a === 'cal') { md.close(); go(myHash('day', x.date)); }
      } catch (e) { md.err(e.message); }
    })));
  }

  function changeForm(x) {
    const md = modal('ย้าย/แก้เวลาการจอง', `
      <div class="muted" style="margin-bottom:8px">เดิม: ${esc(x.room)} · ${fmtD(x.date)} ${x.start}–${x.end}</div>
      <div class="fgrid">
        <div><label>วันที่</label><input type="date" data-k="date" value="${x.date}"></div>
        <div class="row" style="gap:6px"><div style="flex:1"><label>เริ่ม</label><input type="time" data-k="st" value="${x.start}" step="300"></div><div style="flex:1"><label>เลิก</label><input type="time" data-k="en" value="${x.end}" step="300"></div></div>
        <div class="full"><label>ห้อง</label><select data-k="loc">${roomOptions(x.location_id)}</select><div class="hint" data-free></div></div>
      </div>
      <div class="muted" style="margin-top:8px">ถ้าคุณไม่ใช่ผู้ดูแลห้องใหม่ การเปลี่ยนจะรออนุมัติ โดยการจองเดิมยังคงอยู่จนกว่าจะอนุมัติ</div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ยกเลิก</button><button class="btn btn-primary" data-ok>บันทึก</button></div>`);
    const v = (k) => md.q(`[data-k="${k}"]`).value;
    const check = () => showFree(md, v('date'), v('st'), v('en'), '[data-k="loc"]', '[data-free]');
    md.qa('[data-k]').forEach((el) => (el.onchange = check));
    md.q('[data-no]').onclick = md.close;
    md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
      try {
        const r = await bApi('change', { reservation_id: x.reservation_id, location_id: v('loc'), starts_at: isoAt(v('date'), v('st')), ends_at: isoAt(v('date'), v('en')) });
        md.close(); toast(['updated_pending', 'change_requested', 'move_requested'].includes(r.result) ? 'ส่งคำขอเปลี่ยนแล้ว รออนุมัติ' : 'ย้ายแล้ว'); afterChange();
      } catch (er) { md.err(er.message); }
    });
  }

  function cancelBookingForm(x) {
    const md = modal('ยกเลิกการจอง', `
      <div class="muted" style="margin-bottom:8px">${esc(x.room)} · ${fmtD(x.date)} ${x.start}–${x.end}</div>
      ${x.series_id ? `<div class="radio" style="margin-bottom:10px">
        <label><input type="radio" name="sc" value="this" checked><span>เฉพาะครั้งนี้</span></label>
        <label><input type="radio" name="sc" value="following"><span>ครั้งนี้และครั้งถัดไปในชุดเดียวกัน</span></label>
        <label><input type="radio" name="sc" value="all"><span>ทุกครั้งที่ยังไม่ถึง</span></label></div>` : ''}
      <div class="fgrid"><div class="full"><label>หมายเหตุ</label><input data-k="note" maxlength="300"></div></div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ไม่ยกเลิก</button><button class="btn btn-danger" data-ok>ยกเลิกการจอง</button></div>`);
    md.q('[data-no]').onclick = md.close;
    md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
      try {
        const r = await bApi('cancel', { reservation_id: x.reservation_id, scope: md.q('input[name=sc]:checked')?.value || 'this', note: md.q('[data-k="note"]').value });
        md.close(); toast(`ยกเลิกแล้ว ${r.cancelled} รายการ`); afterChange();
      } catch (er) { md.err(er.message); }
    });
  }

  function moveRequestForm(x) {
    const md = modal('ขอให้ผู้ขอใช้ย้ายการจอง', `
      <div class="okbox" style="font-size:13px">${esc(x.room)} · ${fmtD(x.date)} ${x.start}–${x.end} · ผู้ขอใช้ ${esc(x.requester?.full_name || '')}<br>
      การจองนี้อนุมัติไปแล้ว — ระบบจะส่งคำขอให้ผู้ขอใช้ตัดสินใจ (ตอบรับแล้วย้าย/ยกเลิกเอง หรือปฏิเสธ) เพื่อไม่ให้กระทบแผนของเขา</div>
      <div class="fgrid" style="margin-top:10px">
        <div class="full"><label>เหตุผล *</label><textarea data-k="reason" placeholder="เช่น ต้องซ่อมระบบระบายอากาศ"></textarea></div>
        <div class="full"><label class="inl"><input type="checkbox" data-k="urgent"> ด่วน / ฉุกเฉิน</label></div>
        <div class="full"><label>เสนอห้อง/เวลาแทน (ถ้ามี)</label><select data-k="loc">${opt('', '— ไม่ระบุ —', '')}${roomOptions('')}</select></div>
        <div><label>วันที่เสนอ</label><input type="date" data-k="date" value="${x.date}"></div>
        <div class="row" style="gap:6px"><div style="flex:1"><label>เริ่ม</label><input type="time" data-k="st" value="${x.start}"></div><div style="flex:1"><label>เลิก</label><input type="time" data-k="en" value="${x.end}"></div></div>
      </div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ยกเลิก</button><button class="btn btn-primary" data-ok>ส่งคำขอ</button></div>`);
    const v = (k) => md.q(`[data-k="${k}"]`);
    md.q('[data-no]').onclick = md.close;
    md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
      const reason = v('reason').value.trim();
      if (!reason) return md.err('กรุณาใส่เหตุผล');
      const sug = v('loc').value ? { location_id: v('loc').value, starts_at: isoAt(v('date').value, v('st').value), ends_at: isoAt(v('date').value, v('en').value) } : null;
      try { await bApi('move_request', { reservation_id: x.reservation_id, reason, urgent: v('urgent').checked, suggestion: sug }); md.close(); toast('ส่งคำขอให้ย้ายแล้ว'); afterChange(); }
      catch (er) { md.err(er.message); }
    });
  }

  // ---------- ฟอร์มขอจอง ----------
  async function bookingForm(p = {}) {
    await W.init();
    const locId = p.location_id || INIT.rooms.find((r) => r.room_status !== 'closed')?.location_id || '';
    const kinds = OPEN_KINDS.map((k) => [k, INIT.booking_kinds[k]]);
    const dw = p.date ? dow(p.date) + 1 : dow(bkkToday()) + 1;
    const myCourses = INIT.courses;
    const md = modal('ขอจองห้อง', `
      <div class="fgrid">
        <div class="full"><label>ห้อง *</label><select data-k="loc">${roomOptions(locId, { all: false })}</select><div class="hint" data-contacts></div></div>
        <div><label>ประเภทการใช้ *</label><select data-k="kind">${kinds.map(([k, t]) => opt(k, t, p.kind || 'prep')).join('')}</select></div>
        <div><label>ชื่อเรื่อง</label><input data-k="title" maxlength="200" placeholder="เช่น เตรียมสารแล็บ 3"></div>
        <div><label>รายวิชา (ใช้คิดต้นทุน)</label><select data-k="course">${opt('', '— ไม่ใช่งานของวิชา —', '')}${myCourses.map((c) => opt(`${c.course_id}|${c.semester_id}`, `${c.course_code} · ${c.course_name}`, '')).join('')}</select></div>
        <div><label>หรือ ชื่อโครงการ/บริการ</label><input data-k="project" maxlength="200" placeholder="เช่น โครงการวิจัย ก."></div>
        <div class="full"><label>วัตถุประสงค์</label><input data-k="purpose" maxlength="1000"></div>
        <div class="full"><label>ผู้ใช้ห้องจริง (ถ้าไม่ใช่ฉัน)</label><input data-k="actual" maxlength="200" placeholder="เช่น นศ.ปริญญาโท 3 คน"></div>
        <div class="full"><label>รูปแบบ</label><div class="segc" data-pat><button data-p="once" class="on">ครั้งเดียว</button><button data-p="weekly">ทุกสัปดาห์</button><button data-p="range">ทุกวันในช่วง</button><button data-p="dates">เลือกหลายวัน</button></div></div>
        <div data-pp="once"><label>วันที่ *</label><input type="date" data-k="date" value="${esc(p.date || bkkToday())}"></div>
        <div data-pp="weekly" hidden class="full"><label>วันในสัปดาห์</label><div class="wdays">${WD.map((w, i) => `<button type="button" data-wd="${i + 1}" class="${i + 1 === dw ? 'on' : ''}">${w}</button>`).join('')}</div></div>
        <div data-pp="weekly range" hidden><label>ตั้งแต่ *</label><input type="date" data-k="from" value="${esc(p.date || bkkToday())}"></div>
        <div data-pp="weekly range" hidden><label>ถึง *</label><input type="date" data-k="until" value="${addDays(p.date || bkkToday(), 28)}"></div>
        <div data-pp="range" hidden class="full"><label class="inl"><input type="checkbox" data-k="skipwe" checked> ข้ามเสาร์-อาทิตย์</label></div>
        <div data-pp="dates" hidden class="full"><label>วันที่ (เพิ่มได้หลายวัน)</label><div class="row" style="gap:6px"><input type="date" data-k="adddate" style="width:auto"><button type="button" class="btn btn-ghost btn-sm" data-adddate>+ เพิ่มวัน</button></div><div data-datelist class="row" style="gap:4px;margin-top:6px"></div></div>
        <div><label>เวลาเริ่ม *</label><input type="time" data-k="st" value="${esc(p.start || '09:00')}" step="300"></div>
        <div><label>เวลาเลิก *</label><input type="time" data-k="en" value="${esc(p.end || '12:00')}" step="300"></div>
        <div><label>เวลาเตรียมก่อน (นาที)</label><input type="number" data-k="setup" min="0" max="600" step="5" inputmode="numeric"></div>
        <div><label>เวลาเก็บหลัง (นาที)</label><input type="number" data-k="tear" min="0" max="600" step="5" inputmode="numeric"></div>
      </div>
      <div class="row" style="margin:12px 0 8px; gap:6px"><button class="btn btn-ghost btn-sm" data-free>หาห้องว่างช่วงนี้</button><span class="spacer"></span><button class="btn btn-primary" data-preview>ตรวจห้องว่าง →</button></div>
      <div data-freeout class="hint"></div>
      <div data-out></div>`, { wide: true });
    const v = (k) => md.q(`[data-k="${k}"]`);
    let pat = 'once', dates = [], preview = null;
    const syncRoom = () => {
      const r = room(v('loc').value);
      v('setup').placeholder = `ค่าห้อง ${r?.setup_minutes ?? 0}`; v('tear').placeholder = `ค่าห้อง ${r?.teardown_minutes ?? 0}`;
      preview = null; md.q('[data-out]').innerHTML = '';
    };
    v('loc').onchange = syncRoom; syncRoom();
    md.qa('[data-pat] button').forEach((b) => (b.onclick = () => {
      pat = b.dataset.p; md.qa('[data-pat] button').forEach((x) => x.classList.toggle('on', x === b));
      md.qa('[data-pp]').forEach((el) => (el.hidden = !el.dataset.pp.split(' ').includes(pat)));
      preview = null; md.q('[data-out]').innerHTML = '';
    }));
    md.qa('[data-wd]').forEach((b) => (b.onclick = () => b.classList.toggle('on')));
    const drawDates = () => { md.q('[data-datelist]').innerHTML = dates.map((d, i) => `<span class="tag teal">${fmtD(d)} <a href="#" data-rm="${i}">✕</a></span>`).join('') || '<span class="muted">ยังไม่ได้เลือกวัน</span>'; md.qa('[data-rm]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); dates.splice(Number(a.dataset.rm), 1); drawDates(); })); };
    md.q('[data-adddate]').onclick = () => { const d = v('adddate').value; if (d && !dates.includes(d)) { dates.push(d); dates.sort(); drawDates(); } };
    drawDates();
    const pattern = () => {
      if (pat === 'once') return { type: 'once', date: v('date').value };
      if (pat === 'range') return { type: 'range', from: v('from').value, to: v('until').value, skip_weekend: v('skipwe').checked };
      if (pat === 'dates') return { type: 'dates', dates };
      return { type: 'weekly', from: v('from').value, until: v('until').value, weekdays: md.qa('[data-wd].on').map((b) => Number(b.dataset.wd)) };
    };
    const base = () => ({
      location_id: v('loc').value, pattern: pattern(), start_time: v('st').value, end_time: v('en').value,
      setup_minutes: v('setup').value === '' ? undefined : v('setup').value, teardown_minutes: v('tear').value === '' ? undefined : v('tear').value,
    });
    md.q('[data-free]').onclick = () => {
      const d = pat === 'once' ? v('date').value : pat === 'dates' ? dates[0] : v('from').value;
      showFree(md, d, v('st').value, v('en').value, '[data-k="loc"]', '[data-freeout]');
    };
    md.q('[data-preview]').onclick = (e) => busy(e.currentTarget, async () => {
      md.err('');
      try { preview = await bApi('request_preview', base()); drawPreview(); }
      catch (er) { md.err(er.message); }
    });
    function drawPreview() {
      const p2 = preview;
      const contact = (p2.room_contacts || []).map((c) => `<div class="contact">${c.kind === 'room_manager' ? 'ผู้ดูแลห้อง' : 'ผู้ดูแลสำรอง'}: <b>${esc(c.full_name || '')}</b> ${c.phone ? `☎ <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''} ${c.email ? `✉ ${esc(c.email)}` : ''} ${c.line_id ? `LINE ${esc(c.line_id)}` : ''}</div>`).join('');
      const now = Date.now();
      md.q('[data-out]').innerHTML = `
        <div class="row" style="gap:8px;margin:6px 0"><b>${p2.counts.total} ครั้ง</b>${p2.counts.conflict ? `<span class="tag red">ชน ${p2.counts.conflict}</span>` : '<span class="tag teal">ว่างทั้งหมด</span>'}${p2.counts.holiday ? `<span class="tag amber">วันหยุด ${p2.counts.holiday}</span>` : ''}
          <span class="muted">ใช้ห้อง ${p2.setup_minutes} นาทีก่อน / ${p2.teardown_minutes} นาทีหลัง</span></div>
        <div class="prev">${p2.items.map((it, i) => {
          const past = Date.parse(it.starts_at) < now;
          const bad = it.has_approved_conflict, warn = it.conflicts.length || it.holiday;
          return `<label class="pr ${bad ? 'bad' : warn ? 'warn' : ''}"><input type="checkbox" data-pi="${i}" ${!past && !it.conflicts.length && !it.holiday ? 'checked' : ''} ${past ? 'disabled' : ''}>
            <span><b>${esc(it.weekday_th)}</b> ${it.starts_at.slice(11, 16)}–${it.ends_at.slice(11, 16)}${past ? ' <span class="tag">ผ่านแล้ว</span>' : ''}${it.holiday ? ` <span class="tag amber">${esc(it.holiday)}</span>` : ''}
            ${it.conflicts.map((c) => `<div class="muted">ชนกับ: ${esc(c.kind_th)} ${esc(c.course_code || c.title || c.project_name || '')} ${c.start}–${c.end} · ${esc(c.requester?.full_name || '')} ${statusTag(c.status)}</div>`).join('')}</span></label>`;
        }).join('')}</div>
        ${p2.counts.conflict ? `<div class="muted" style="margin-top:6px">ติดต่อเจ้าของห้องเพื่อเจรจา:</div>${contact}` : ''}
        ${p2.can_override ? `<div style="margin-top:8px"><label class="inl"><input type="checkbox" data-k="override"> แทรกคำขอที่ยังรออนุมัติ (คุณเป็นผู้ดูแลห้อง — คำขอที่ถูกแทรกจะถูกปฏิเสธและแจ้งผู้ขอ)</label><input data-k="ovnote" placeholder="เหตุผลการแทรก" style="margin-top:6px;font-size:14px"></div>` : ''}
        <div class="row" style="margin-top:12px"><span class="muted">${myRoom(p2.room.location_id) ? 'คุณดูแลห้องนี้ — คำขออนุมัติทันที' : 'คำขอจะส่งไปยังผู้ดูแลห้องเพื่ออนุมัติ'}</span><span class="spacer"></span><button class="btn btn-primary" data-send>ส่งคำขอ</button></div>`;
      md.q('[data-send]').onclick = (e) => busy(e.currentTarget, async () => {
        md.err('');
        const [course_id, semester_id] = (v('course').value || '').split('|');
        const chosen = md.qa('[data-pi]:checked').map((c) => p2.items[Number(c.dataset.pi)].date);
        if (!chosen.length) return md.err('เลือกอย่างน้อย 1 ครั้ง');
        try {
          const r = await bApi('request_create', {
            ...base(), kind: v('kind').value, dates: chosen, course_id: course_id || undefined, semester_id: semester_id || undefined,
            project_name: v('project').value, title: v('title').value, purpose: v('purpose').value, actual_user: v('actual').value,
            override: !!md.q('[data-k="override"]')?.checked, override_note: md.q('[data-k="ovnote"]')?.value || '',
          });
          md.body(`<div class="okbox">ส่งแล้ว <b>${r.counts.sent}</b> ครั้ง · อนุมัติทันที ${r.counts.approved} · ชน ${r.counts.conflict}${r.counts.overridden ? ` · แทรก ${r.counts.overridden}` : ''}</div>
            ${r.counts.conflict ? `<div class="warnbox">มี ${r.counts.conflict} ครั้งที่ห้องถูกจองไปก่อนระหว่างที่คุณกรอก — ลองห้องหรือเวลาอื่น</div>` : ''}
            <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-primary" data-x2>เสร็จ</button></div>`);
          md.q('[data-x2]').onclick = md.close;
          afterChange();
        } catch (er) { md.err(er.message); }
      });
    }
  }

  // ---------- การจองของฉัน ----------
  async function loadMine() {
    $('rmBody').innerHTML = `<div class="wbar"><h2 style="min-width:0">การจองของฉัน</h2><span class="muted">ตั้งแต่ 7 วันก่อน</span><span class="spacer"></span><button class="btn btn-primary btn-sm" id="mnNew">+ ขอจองห้อง</button></div><div id="mnList"><div class="skel" style="height:200px"></div></div>`;
    $('mnNew').onclick = () => bookingForm({});
    try {
      const d = await bApi('mine');
      const list = d.reservations.filter((x) => x.status !== 'cancelled');
      if (!list.length) { $('mnList').innerHTML = '<div class="empty">ยังไม่มีการจอง</div>'; return; }
      const byDate = new Map();
      for (const x of list) byDate.set(x.date, [...(byDate.get(x.date) || []), x]);
      $('mnList').innerHTML = [...byDate].map(([d2, xs]) => `<div class="grp">${fmtD(d2)}</div>` + xs.map((x) => `
        <div class="li ${x.status === 'pending' ? 'pending' : ''}"><span class="mono">${x.start}–${x.end}</span>
          <div><div class="t">${esc(x.kind_th)} · ${esc(x.course_code ? `${x.course_code}${x.section_no ? ' ก.' + x.section_no : ''}` : x.title || x.project_name || '')}</div>
          <div class="m">${esc(x.room)} · ${statusTag(x.status)}${x.pending_change ? ' <span class="tag amber">ขอเปลี่ยน รออนุมัติ</span>' : ''}${x.decision_note ? ` · ${esc(x.decision_note)}` : ''}</div></div>
          <div class="acts"><button class="btn btn-ghost btn-sm" data-open="${esc(x.reservation_id)}">รายละเอียด</button></div></div>`).join('')).join('');
      $('mnList').querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => bookingDetail(list.find((x) => x.reservation_id === b.dataset.open), myRoom(list.find((x) => x.reservation_id === b.dataset.open).location_id))));
    } catch (e) { $('rmErr').textContent = e.message; }
  }

  // ---------- ขอให้ย้าย ----------
  async function loadMoves() {
    $('rmBody').innerHTML = `<div id="mvList"><div class="skel" style="height:200px"></div></div>`;
    try {
      const d = await bApi('move_list');
      const card = (m, received) => {
        const x = m.reservation || {};
        const sug = m.suggestion;
        return `<div class="li ${m.status === 'pending' ? 'pending' : ''}">
          <span>${m.urgent ? '🚨' : '🙏'}</span>
          <div><div class="t">${esc(x.room || '')} · ${x.date ? fmtD(x.date) : ''} ${x.start || ''}–${x.end || ''} · ${esc(x.kind_th || '')} ${esc(x.course_code || x.title || '')}</div>
          <div class="m">เหตุผล: ${esc(m.reason)}${sug?.location_id ? ` · เสนอ ${esc(room(sug.location_id)?.name || '')} ${sug.starts_at ? `${fmtD(dayIso(sug.starts_at))} ${hmIso(sug.starts_at)}–${hmIso(sug.ends_at)}` : ''}` : ''}<br>
          ${received ? `ขอโดย ${esc(person(m.requested_by)?.full_name || '')}` : `ถึง ${esc(x.requester?.full_name || '')}`} · ${fmtDT(m.created_at)}
          · ${m.status === 'pending' ? '<span class="tag amber">รอตอบ</span>' : m.status === 'accepted' ? '<span class="tag teal">ยินดีย้าย</span>' : m.status === 'declined' ? '<span class="tag red">ไม่สะดวกย้าย</span>' : '<span class="tag">ถอน</span>'}${m.response_note ? ` · ${esc(m.response_note)}` : ''}</div></div>
          <div class="acts">${received && m.status === 'pending' ? `<button class="btn btn-ok btn-sm" data-acc="${esc(m.move_request_id)}">ยินดีย้าย</button><button class="btn btn-ghost btn-sm" data-dec="${esc(m.move_request_id)}">ไม่สะดวก</button>` : ''}
          ${received && m.status === 'accepted' && x.status && ['pending', 'approved'].includes(x.status) ? `<button class="btn btn-ghost btn-sm" data-open="${esc(x.reservation_id)}">ย้าย/ยกเลิกการจอง</button>` : ''}</div></div>`;
      };
      const rec = d.received, sent = d.sent;
      $('mvList').innerHTML = `<div class="grp">ที่ได้รับ (การจองของฉัน)</div>${rec.length ? rec.map((m) => card(m, true)).join('') : '<div class="empty">ไม่มีคำขอให้ย้าย</div>'}
        <div class="grp">ที่ฉันส่ง (ในฐานะผู้ดูแลห้อง)</div>${sent.length ? sent.map((m) => card(m, false)).join('') : '<div class="empty">ยังไม่เคยส่ง</div>'}
        <div class="muted" style="margin-top:10px">หลักการ: การจองที่อนุมัติแล้ว ผู้ดูแลห้องบังคับยกเลิกไม่ได้ — ต้องขอให้ย้ายและให้ผู้ขอใช้ตัดสินใจ</div>`;
      const all = [...rec, ...sent];
      $('mvList').querySelectorAll('[data-acc],[data-dec]').forEach((b) => (b.onclick = () => busy(b, async () => {
        const accept = !!b.dataset.acc;
        const note = await ask(accept ? 'ยินดีย้าย' : 'ไม่สะดวกย้าย', { label: 'ข้อความถึงผู้ดูแลห้อง', required: !accept, okText: 'ส่ง' });
        if (note === null) return;
        try {
          await bApi('move_respond', { move_request_id: b.dataset.acc || b.dataset.dec, accept, note });
          toast(accept ? 'ตอบรับแล้ว — ย้าย/ยกเลิกการจองเองได้เลย' : 'แจ้งผู้ดูแลห้องแล้ว');
          W.refreshBadges(); loadMoves();
        } catch (e) { $('rmErr').textContent = e.message; }
      })));
      $('mvList').querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => { const x = all.find((m) => m.reservation?.reservation_id === b.dataset.open).reservation; bookingDetail(x, myRoom(x.location_id)); }));
    } catch (e) { $('rmErr').textContent = e.message; }
  }

  // ---------- ห้องต้นเทอม ----------
  async function loadTerm(semId) {
    const terms = INIT.terms;
    const cur = semId || rm.term || (terms.find((t) => t.current) || terms[0])?.semester_id;
    rm.term = cur;
    $('rmBody').innerHTML = `<div class="wbar"><h2 style="min-width:0">สถานะการจองห้องของรายวิชา</h2><select id="tmSel">${terms.map((t) => opt(t.semester_id, `เทอม ${t.label}`, cur)).join('')}</select></div>
      <div class="muted" style="margin-bottom:8px">คาบ/บทคงอยู่ทุกเทอม แต่ห้องต้องจองใหม่ทุกเทอม — ตารางนี้บอกว่าวิชาไหนยังไม่ได้ห้องครบ และกำหนดส่ง/อนุมัติ</div>
      <div id="tmList"><div class="skel" style="height:200px"></div></div>`;
    $('tmSel').onchange = () => loadTerm($('tmSel').value);
    try {
      const d = await bApi('dashboard', { semester_id: cur });
      const ST = { complete: ['teal', 'ได้ห้องครบ'], pending: ['amber', 'รออนุมัติ'], incomplete: ['red', 'ยังขอไม่ครบ'], not_sent: ['red', 'ยังไม่ส่งคำขอ'], no_sessions: ['', 'ยังไม่มีคาบ'] };
      $('tmList').innerHTML = d.courses.length ? `<div class="tablewrap" style="max-height:none"><table class="rt"><tr><th>วิชา</th><th>คาบ</th><th>อนุมัติ</th><th>รอ</th><th>ยังไม่มีห้อง</th><th>สถานะ</th><th>ส่งคำขอภายใน</th><th>อนุมัติภายใน</th><th></th></tr>
        ${d.courses.map((c) => {
          const can = INIT.courses.find((x) => x.course_id === c.course_id && x.semester_id === d.semester_id)?.can_manage;
          const [cl, tx] = ST[c.status] || ['', c.status];
          return `<tr><td><b>${esc(c.course_code)}</b><div class="muted">${esc(c.course_name)}</div></td><td>${c.sessions}</td><td>${c.approved}</td><td>${c.pending}</td><td>${c.none ? `<b style="color:var(--brick)">${c.none}</b>` : 0}</td>
            <td><span class="tag ${cl}">${tx}</span>${Object.keys(c.pending_zones || {}).length ? `<div class="muted">รอที่ ${esc(Object.entries(c.pending_zones).map(([z, n]) => `${z} (${n})`).join(', '))}</div>` : ''}</td>
            <td>${c.request_due ? fmtD(c.request_due) : '—'}${c.request_overdue ? ' <span class="tag red">เลย</span>' : ''}</td>
            <td>${c.approve_due ? fmtD(c.approve_due) : '—'}${c.approve_overdue ? ' <span class="tag red">เลย</span>' : ''}</td>
            <td>${can ? `<button class="btn btn-ghost btn-sm" data-set="${esc(c.course_id)}">ตั้งกำหนด</button>` : ''}</td></tr>`;
        }).join('')}</table></div>` : '<div class="empty">ยังไม่มีรายวิชาในเทอมนี้</div>';
      $('tmList').querySelectorAll('[data-set]').forEach((b) => (b.onclick = () => {
        const c = d.courses.find((x) => x.course_id === b.dataset.set);
        const md = modal(`กำหนดการจองห้อง · ${c.course_code}`, `<div class="fgrid">
          <div><label>ส่งคำขอห้องก่อนคาบแรก (วัน)</label><input type="number" data-k="rq" value="${c.request_lead_days ?? ''}" min="0" max="365"></div>
          <div><label>ต้องได้อนุมัติก่อนคาบแรก (วัน)</label><input type="number" data-k="ap" value="${c.approve_lead_days ?? ''}" min="0" max="365"></div>
          <div class="full"><label>วันเรียนคาบแรก (ว่าง = ใช้คาบแรกในระบบ)</label><input type="date" data-k="fc" value="${c.first_class_custom ? c.first_class_date : ''}"></div></div>
          <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-primary" data-ok>บันทึก</button></div>`);
        md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
          try { await bApi('settings_save', { course_id: c.course_id, semester_id: d.semester_id, request_lead_days: md.q('[data-k="rq"]').value, approve_lead_days: md.q('[data-k="ap"]').value, first_class_date: md.q('[data-k="fc"]').value }); md.close(); toast('บันทึกแล้ว'); loadTerm(cur); }
          catch (er) { md.err(er.message); }
        });
      }));
    } catch (e) { $('rmErr').textContent = e.message; }
  }

  // ---------- วันไม่อยู่ ----------
  async function loadAway() {
    $('rmBody').innerHTML = `<div class="wbar"><h2 style="min-width:0">วันที่ไม่อยู่</h2><span class="spacer"></span><button class="btn btn-primary btn-sm" id="awNew">+ เพิ่ม</button></div>
      <div class="muted" style="margin-bottom:8px">ช่วงที่ไม่อยู่ เรื่องอนุมัติห้อง/รายวิชาจะส่งไปที่ผู้สำรอง · ไม่อยู่ทั้งหลักและสำรอง = แจ้งด่วนทั้งคู่${isAdmin() ? ' · แอดมินเห็นของทุกคน' : ''}</div><div id="awList"><div class="skel" style="height:120px"></div></div>`;
    $('awNew').onclick = () => awayForm({});
    try {
      const d = await bApi('away_list');
      $('awList').innerHTML = d.away.length ? d.away.map((a) => `<div class="li"><span>🙈</span><div><div class="t">${fmtD(a.from_date)}${a.to_date !== a.from_date ? ` – ${fmtD(a.to_date)}` : ''}</div>
        <div class="m">${esc(a.users?.full_name || '')}${a.note ? ` · ${esc(a.note)}` : ''}</div></div><div class="acts"><button class="btn btn-ghost btn-sm" data-del="${esc(a.away_id)}">ลบ</button></div></div>`).join('') : '<div class="empty">ไม่มีวันไม่อยู่ที่กำลังจะถึง</div>';
      $('awList').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => busy(b, async () => {
        if (!confirmInline(b)) return;
        try { await bApi('away_delete', { away_id: b.dataset.del }); toast('ลบแล้ว'); loadAway(); W.reloadMy(); } catch (e) { $('rmErr').textContent = e.message; }
      })));
    } catch (e) { $('rmErr').textContent = e.message; }
  }

  // =====================================================================
  // ตารางงาน
  // =====================================================================
  const tk = { scope: 'mine', done: false };
  W.openTasks = async () => {
    show('viewTasks');
    try { await W.init(); } catch (e) { $('viewTasks').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    if (!$('viewTasks').dataset.built) {
      $('viewTasks').dataset.built = '1';
      const hasCourse = isAdmin() || INIT.courses.some((c) => c.my_roles.length);
      const canGen = INIT.courses.some((c) => c.can_manage);
      $('viewTasks').innerHTML = `<div class="wbar">
        <div class="segc" id="tkScope"><button data-s="mine">ของฉัน</button><button data-s="created">ที่ฉันมอบหมาย</button>${hasCourse ? '<button data-s="course">งานในวิชาของฉัน</button>' : ''}${isAdmin() ? '<button data-s="all">ทั้งหมด</button>' : ''}</div>
        <label class="inl" style="margin-left:6px"><input type="checkbox" id="tkDone"> แสดงที่เสร็จแล้ว</label>
        <span class="spacer"></span>
        ${canGen ? '<button class="btn btn-ghost btn-sm" id="tkGen">⚙️ สร้างงานจากสิ่งที่ต้องเตรียม</button>' : ''}
        <button class="btn btn-primary btn-sm" id="tkNew">+ งาน</button></div>
        <div id="tkList"><div class="skel" style="height:240px"></div></div><div class="err" id="tkErr"></div>`;
      $('tkScope').querySelectorAll('button').forEach((b) => (b.onclick = () => { tk.scope = b.dataset.s; loadTasks(); }));
      $('tkDone').onchange = () => { tk.done = $('tkDone').checked; loadTasks(); };
      $('tkNew').onclick = () => taskForm({});
      if ($('tkGen')) $('tkGen').onclick = genForm;
    }
    loadTasks();
  };

  async function loadTasks() {
    $('tkScope').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.s === tk.scope));
    $('tkErr').textContent = '';
    $('tkList').classList.add('loading');
    try {
      const d = await wApi('task_list', { scope: tk.scope, include_done: tk.done });
      const today = bkkToday(), tmr = addDays(today, 1);
      const groups = new Map();
      d.tasks.sort((a, b) => (b.overdue - a.overdue) || a.task_date.localeCompare(b.task_date) || String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')));
      for (const t of d.tasks) {
        const g = t.overdue ? '⚠️ เลยกำหนด' : t.task_date === today ? 'วันนี้' : t.task_date === tmr ? 'พรุ่งนี้' : t.task_date < today ? `${fmtD(t.task_date)} (ผ่านแล้ว)` : fmtD(t.task_date);
        groups.set(g, [...(groups.get(g) || []), t]);
      }
      $('tkList').innerHTML = d.tasks.length ? [...groups].map(([g, ts]) => `<div class="grp ${g.startsWith('⚠️') ? 'red' : ''}">${g} <span class="tag">${ts.length}</span></div>` + ts.map((t) => `
        <div class="li ${t.status === 'done' ? 'done' : ''} ${t.overdue ? 'od' : ''}">
          <button class="chk ${t.status === 'done' ? 'on' : ''}" data-tg="${esc(t.task_id)}" ${t.can_edit ? '' : 'disabled'} aria-label="ทำเสร็จ">${t.status === 'done' ? '✓' : ''}</button>
          <div><div class="t">${esc(t.title)} ${t.is_private ? '🔒' : ''}</div>
            <div class="m"><span class="tag ${t.task_type === 'prep' ? 'amber' : t.task_type === 'supervise' ? 'teal' : ''}">${esc(t.task_type_th)}</span>
            ${[t.overdue && fmtD(t.task_date), t.start_time && `<span class="mono">${t.start_time}</span>`, t.duration_hours && `${Number(t.duration_hours)} ชม.`,
              t.course_code && esc(t.course_code + (t.session ? ` ก.${t.session.section_no} คาบ ${fmtD(t.session.class_date)} ${t.session.start_time} · ${t.session.room || ''}` : '')),
              tk.scope !== 'mine' ? `👤 ${esc(t.assignee_name || '')}` : (t.created_by !== INIT.me.user_id && t.created_by_name ? `มอบหมายโดย ${esc(t.created_by_name)}` : ''),
              t.handed_over_from_name && `รับต่อจาก ${esc(t.handed_over_from_name)}`, t.done_by_name && `เสร็จโดย ${esc(t.done_by_name)}`].filter(Boolean).join(' · ')}
            ${t.note ? `<br>${esc(t.note)}` : ''}</div></div>
          <div class="acts">${t.can_edit ? `<button class="btn btn-ghost btn-sm" data-ed="${esc(t.task_id)}">แก้ไข</button><button class="btn btn-ghost btn-sm" data-rm="${esc(t.task_id)}">ลบ</button>` : ''}</div></div>`).join('')).join('')
        : `<div class="empty">${tk.scope === 'mine' ? 'ไม่มีงานค้าง 🎉' : 'ไม่มีงาน'}</div>`;
      const find = (id) => d.tasks.find((t) => t.task_id === id);
      $('tkList').querySelectorAll('[data-tg]').forEach((b) => (b.onclick = () => busy(b, async () => {
        const t = find(b.dataset.tg);
        try { await wApi('task_status', { task_id: t.task_id, status: t.status === 'done' ? 'todo' : 'done' }); toast(t.status === 'done' ? 'กลับเป็นต้องทำ' : 'เสร็จแล้ว ✓'); afterChange(); }
        catch (e) { $('tkErr').textContent = e.message; }
      })));
      $('tkList').querySelectorAll('[data-ed]').forEach((b) => (b.onclick = () => {
        const t = find(b.dataset.ed);
        taskForm({ task_id: t.task_id, title: t.title, task_type: t.task_type, task_date: t.task_date, start_time: t.start_time || '', duration_hours: t.duration_hours, assignee_id: t.assignee_id, is_private: t.is_private, note: t.note, course_id: t.course_id });
      }));
      $('tkList').querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => busy(b, async () => {
        if (!confirmInline(b)) return;
        try { await wApi('task_remove', { task_id: b.dataset.rm }); toast('ลบงานแล้ว'); afterChange(); } catch (e) { $('tkErr').textContent = e.message; }
      })));
    } catch (e) { $('tkErr').textContent = e.message; }
    finally { $('tkList').classList.remove('loading'); }
  }

  function genForm() {
    const cs = INIT.courses.filter((c) => c.can_manage);
    const md = modal('สร้างงานจาก "สิ่งที่ต้องเตรียมต่อบท"', `
      <div class="muted" style="margin-bottom:8px">ระบบสร้างงานเตรียม/คุม/อ่านผล/เก็บแล็บ ให้ทุกคาบที่ยังไม่ถึง ตามรายการที่ตั้งไว้ในแต่ละบท (ไม่สร้างซ้ำ) แล้วแก้ต่อได้</div>
      <div class="fgrid">
        <div class="full"><label>รายวิชา</label><select data-k="c">${cs.map((c) => opt(`${c.course_id}|${c.semester_id}`, `${c.course_code} · ${c.course_name}`, '')).join('')}</select></div>
        <div><label>ตั้งแต่</label><input type="date" data-k="from" value="${bkkToday()}"></div>
        <div><label>ถึง</label><input type="date" data-k="to" value="${addDays(bkkToday(), 120)}"></div>
      </div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-primary" data-ok>สร้างงาน</button></div>`);
    md.q('[data-ok]').onclick = (e) => busy(e.currentTarget, async () => {
      const [course_id, semester_id] = md.q('[data-k="c"]').value.split('|');
      try { const r = await wApi('task_generate', { course_id, semester_id, from: md.q('[data-k="from"]').value, to: md.q('[data-k="to"]').value }); md.close(); toast(`สร้างงานใหม่ ${r.created} งาน จาก ${r.sessions} คาบ`); afterChange(); }
      catch (er) { md.err(er.message); }
    });
  }

  // =====================================================================
  // รออนุมัติ
  // =====================================================================
  W.openInbox = async () => {
    show('viewInbox');
    if (!$('viewInbox').dataset.built) {
      $('viewInbox').dataset.built = '1';
      $('viewInbox').innerHTML = `<div class="wbar"><h2 style="min-width:0">รออนุมัติ / รอตอบ</h2><span class="spacer"></span><button class="btn btn-ghost btn-sm" id="ibRefresh">รีเฟรช</button></div><div id="ibBody"><div class="skel" style="height:260px"></div></div><div class="err" id="ibErr"></div>`;
      $('ibRefresh').onclick = () => { loadInbox(); W.refreshBadges(); };
    }
    try { await W.init(); } catch (e) { $('ibErr').textContent = e.message; return; }
    loadInbox();
  };

  async function loadInbox() {
    $('ibErr').textContent = '';
    $('ibBody').classList.add('loading');
    const today = bkkToday();
    const [q, mv, lv, tasks] = await Promise.all([
      bApi('queue').catch((e) => ({ error: e.message })),
      bApi('move_list').catch((e) => ({ error: e.message })),
      wApi('leave_queue', { status: 'pending' }).catch((e) => ({ error: e.message })),
      wApi('task_list', { scope: 'mine', to: today }).catch((e) => ({ error: e.message })),
    ]);
    $('ibBody').classList.remove('loading');
    const sec = (title, n, html, empty) => `<div class="grp">${title} ${n ? `<span class="nb" style="position:static">${n}</span>` : ''}</div>${n ? html : `<div class="empty" style="padding:12px">${empty}</div>`}`;
    // 1) คิวอนุมัติห้อง
    const groups = q.groups || [];
    const qHtml = groups.map((g, gi) => {
      const first = g.items[0];
      const changes = g.items.filter((x) => x.pending_change).length;
      return `<div class="li pending"><span>🏫</span><div>
        <div class="t">${esc(g.room)} · ${esc(g.kind_th)} ${esc(g.course_code || g.project_name || first.title || '')}</div>
        <div class="m">${g.items.length} ครั้ง เริ่ม ${fmtD(g.first)} ${first.start}–${first.end}${changes ? ` · <span class="tag amber">ขอเปลี่ยน ${changes}</span>` : ''} · ขอโดย ${esc(g.requester?.full_name || '')}${g.requester?.phone ? ` ☎ ${esc(g.requester.phone)}` : ''}
        ${first.purpose ? `<br>${esc(first.purpose)}` : ''}
        <details style="margin-top:4px"><summary class="muted" style="cursor:pointer">ดูทุกครั้ง</summary>${g.items.map((x) => `<div>${fmtD(x.date)} ${x.start}–${x.end}${x.pending_change ? ` → ขอเปลี่ยนเป็น ${esc(room(x.pending_change.location_id)?.name || '')} ${fmtD(dayIso(x.pending_change.starts_at))} ${hmIso(x.pending_change.starts_at)}–${hmIso(x.pending_change.ends_at)}` : ''}</div>`).join('')}</details></div></div>
        <div class="acts"><button class="btn btn-ok btn-sm" data-ap="${gi}">✓ อนุมัติ${g.items.length > 1 ? 'ทั้งชุด' : ''}</button><button class="btn btn-ghost btn-sm" data-rj="${gi}">✕ ไม่อนุมัติ</button></div></div>`;
    }).join('');
    // 2) คำขอให้ย้ายที่ได้รับ
    const moves = (mv.received || []).filter((m) => m.status === 'pending');
    const mvHtml = moves.map((m) => { const x = m.reservation || {}; return `<div class="li pending"><span>${m.urgent ? '🚨' : '🙏'}</span><div>
      <div class="t">ผู้ดูแลห้องขอให้ย้าย: ${esc(x.room || '')} · ${x.date ? fmtD(x.date) : ''} ${x.start || ''}–${x.end || ''}</div>
      <div class="m">เหตุผล: ${esc(m.reason)} · โดย ${esc(person(m.requested_by)?.full_name || '')}</div></div>
      <div class="acts"><button class="btn btn-ghost btn-sm" data-goto-moves>ตอบ</button></div></div>`; }).join('');
    // 3) คำขอลา
    const leaves = lv.requests || [];
    const lvHtml = leaves.map((r, i) => `<div class="li pending"><span>📝</span><div>
      <div class="t">${esc(r.student_code)} ${esc(r.student_name || '')}</div>
      <div class="m">${esc(r.course_code)} ก.${esc(r.section_no)} · ${fmtD(r.class_date)} ${r.start_time}–${r.end_time}<br>เหตุผล: ${esc(r.reason)}${r.has_attachment ? ' · 📎 มีเอกสาร' : ''} · ยื่น ${fmtDT(r.created_at)}</div></div>
      <div class="acts"><button class="btn btn-ok btn-sm" data-la="${i}">อนุมัติ</button><button class="btn btn-ghost btn-sm" data-lr="${i}">ไม่อนุมัติ</button></div></div>`).join('');
    // 4) งานค้างของฉัน
    const myTasks = (tasks.tasks || []).filter((t) => t.status === 'todo');
    const tkHtml = myTasks.map((t) => `<div class="li ${t.overdue ? 'od' : ''}"><button class="chk" data-td="${esc(t.task_id)}" aria-label="ทำเสร็จ"></button>
      <div><div class="t">${esc(t.title)}</div><div class="m">${t.overdue ? `<span class="tag red">เลยกำหนด ${fmtD(t.task_date)}</span>` : 'วันนี้'} ${t.start_time ? `<span class="mono">${t.start_time}</span>` : ''} ${esc(t.course_code || '')}</div></div><div></div></div>`).join('');
    $('ibBody').innerHTML =
      (INIT.caps.room_manager ? sec('🏫 คำขอใช้ห้องที่ฉันอนุมัติได้', groups.length, qHtml, 'ไม่มีคำขอรออนุมัติ') : '') +
      sec('🙏 ผู้ดูแลห้องขอให้ย้ายการจองของฉัน', moves.length, mvHtml, 'ไม่มี') +
      (INIT.caps.instructor ? sec('📝 คำขอลาของนักศึกษา (กลุ่มที่ฉันสอน)', leaves.length, lvHtml, 'ไม่มีคำขอลารออนุมัติ') : '') +
      sec('✅ งานของฉันวันนี้/ค้าง', myTasks.length, tkHtml, 'ไม่มีงานค้าง 🎉') +
      [q, mv, lv, tasks].filter((x) => x.error).map((x) => `<div class="err">${esc(x.error)}</div>`).join('');
    const decide = (gi, approve) => async (b) => {
      const g = groups[gi];
      let note = null;
      if (!approve) { note = await ask('ไม่อนุมัติคำขอใช้ห้อง', { required: true, okText: 'ไม่อนุมัติ', danger: true }); if (note === null) return; }
      try {
        const r = await bApi('decide', { reservation_ids: g.items.map((x) => x.reservation_id), approve, note });
        toast(approve ? `อนุมัติ ${r.counts.ok} รายการ${r.counts.failed ? ` · ไม่สำเร็จ ${r.counts.failed} (ห้องชน)` : ''}` : 'แจ้งผู้ขอแล้ว');
        afterChange();
      } catch (e) { $('ibErr').textContent = e.message; }
    };
    $('ibBody').querySelectorAll('[data-ap]').forEach((b) => (b.onclick = () => busy(b, () => decide(Number(b.dataset.ap), true)(b))));
    $('ibBody').querySelectorAll('[data-rj]').forEach((b) => (b.onclick = () => busy(b, () => decide(Number(b.dataset.rj), false)(b))));
    $('ibBody').querySelectorAll('[data-goto-moves]').forEach((b) => (b.onclick = () => go('#rooms/moves')));
    const leaveDecide = (i, approve) => async () => {
      const r = leaves[i];
      let note = '';
      if (!approve) { note = await ask(`ไม่อนุมัติการลา · ${r.student_code}`, { required: true, okText: 'ไม่อนุมัติ', danger: true }); if (note === null) return; }
      try { await wApi('leave_decide', { request_id: r.request_id, approve, note }); toast(approve ? 'อนุมัติแล้ว · บันทึกเป็น "ลา" ในใบเช็คชื่อ' : 'ไม่อนุมัติแล้ว'); afterChange(); }
      catch (e) { $('ibErr').textContent = e.message; }
    };
    $('ibBody').querySelectorAll('[data-la]').forEach((b) => (b.onclick = () => busy(b, leaveDecide(Number(b.dataset.la), true))));
    $('ibBody').querySelectorAll('[data-lr]').forEach((b) => (b.onclick = () => busy(b, leaveDecide(Number(b.dataset.lr), false))));
    $('ibBody').querySelectorAll('[data-td]').forEach((b) => (b.onclick = () => busy(b, async () => {
      try { await wApi('task_status', { task_id: b.dataset.td, status: 'done' }); toast('เสร็จแล้ว ✓'); afterChange(); } catch (e) { $('ibErr').textContent = e.message; }
    })));
  }
})();
