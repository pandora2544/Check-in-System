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
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  // ---------- ช่วงเวลาที่แสดง (ใช้ร่วม: ปฏิทินของฉัน + ปฏิทินห้อง) ----------
  // ค่าเริ่มต้น 08–18 · ผู้ใช้ปรับได้และระบบจำไว้ · เปลี่ยนแค่การแสดงผล ข้อมูลจริงไม่เปลี่ยน
  const TW_KEY = 'csl_timewin';
  const tw = (() => {
    try { const v = JSON.parse(localStorage.getItem(TW_KEY) || 'null'); if (v && v.from >= 0 && v.to <= 24 && v.to > v.from) return { from: v.from, to: v.to }; } catch { /* ไม่มี storage */ }
    return { from: 8, to: 18 };
  })();
  let twTemp = null; // ขยายชั่วคราวเพื่อดูรายการนอกช่วง (ไม่บันทึก)
  const twNow = () => twTemp || tw;
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  const twLabel = () => `🕗 ${hh(twNow().from)}–${hh(twNow().to)}${twTemp ? ' (ชั่วคราว)' : ''}`;
  function twSave(from, to) { tw.from = from; tw.to = to; twTemp = null; try { localStorage.setItem(TW_KEY, JSON.stringify(tw)); } catch { /* ข้าม */ } }
  function twDialog(onDone) {
    const w = twNow();
    const hrs = (sel, a, b) => [...Array(b - a + 1)].map((_, i) => opt(a + i, hh(a + i), sel)).join('');
    const md = modal('ปรับช่วงเวลาที่แสดง', `<div class="fgrid"><div><label>ตั้งแต่</label><select data-k="f">${hrs(w.from, 0, 23)}</select></div><div><label>ถึง</label><select data-k="t">${hrs(w.to, 1, 24)}</select></div></div>
      <div class="muted" style="margin:8px 0">เปลี่ยนแค่การแสดงผล ข้อมูลและเวลาจองจริงไม่เปลี่ยน · ระบบจำช่วงนี้ไว้ใช้ครั้งถัดไป</div>
      <div class="row" style="gap:6px"><button class="btn btn-ghost btn-sm" data-p="8-18">ค่าเริ่มต้น 08–18</button><button class="btn btn-ghost btn-sm" data-p="6-20">เช้า–ค่ำ 06–20</button><button class="btn btn-ghost btn-sm" data-p="0-24">ครบ 24 ชม.</button>
        <span class="spacer"></span><button class="btn btn-primary" data-ok>ใช้ช่วงนี้</button></div>`);
    const apply = (f, t) => { if (t <= f) return md.err('เวลาสิ้นสุดต้องหลังเวลาเริ่ม'); twSave(f, t); md.close(); onDone(); };
    md.qa('[data-p]').forEach((b) => (b.onclick = () => { const [f, t] = b.dataset.p.split('-').map(Number); apply(f, t); }));
    md.q('[data-ok]').onclick = () => apply(Number(md.q('[data-k="f"]').value), Number(md.q('[data-k="t"]').value));
  }

  // ---------- ตารางแนวนอน: แถว = วันหรือห้อง · เวลาอยู่ด้านบน · พอดีความกว้างจอ ----------
  // rows: [{ key, label(html), sub(html)?, today?, cls?, extra(html)?, items: [{ id, s, e (นาที), pad0?, pad1?, title, line?, tip?, icon?, cls?, style? }] }]
  function hgrid(el, { rows, nowRow, onItem, onEmpty, onLabel, rerender, empty }) {
    const w = twNow(), h0 = w.from, h1 = w.to, span = (h1 - h0) * 60;
    const P = (m) => ((Math.min(Math.max(m, h0 * 60), h1 * 60) - h0 * 60) / span) * 100;
    const stepH = span > 16 * 60 ? 2 : 1;
    const ticks = []; for (let h = h0; h <= h1; h += stepH) ticks.push(h);
    const LANE = narrow() ? 36 : 40;
    let out = 0, outMin = h0 * 60, outMax = h1 * 60;
    const body = rows.map((r) => {
      for (const x of r.items) if (x.e <= h0 * 60 || x.s >= h1 * 60) { out++; outMin = Math.min(outMin, x.s); outMax = Math.max(outMax, x.e); }
      const vis = r.items.filter((x) => x.e > h0 * 60 && x.s < h1 * 60).sort((a, b) => a.s - b.s || b.e - a.e);
      const lanes = [];
      for (const x of vis) { let k = lanes.findIndex((end) => end <= x.s); if (k < 0) { k = lanes.length; lanes.push(x.e); } else lanes[k] = x.e; x.lane = k; }
      const n = Math.max(1, lanes.length);
      const bars = vis.map((x) => {
        const l = P(x.s), wd = Math.max(P(x.e) - l, 0.8);
        const pad = x.pad0 || x.pad1 ? `<div class="hg-pad" style="left:${P(x.s - (x.pad0 || 0))}%;width:${P(x.e + (x.pad1 || 0)) - P(x.s - (x.pad0 || 0))}%;top:${x.lane * LANE + 5}px;height:${LANE - 10}px"></div>` : '';
        return `${pad}<button class="hg-bar ${x.cls || ''} ${x.s < h0 * 60 ? 'cut-l' : ''} ${x.e > h1 * 60 ? 'cut-r' : ''}" data-id="${esc(x.id)}" title="${esc(x.tip || x.title)}"
          style="left:${l}%;width:calc(${wd}% - 2px);top:${x.lane * LANE + 3}px;height:${LANE - 6}px;${x.style || ''}"><b>${x.icon ? `${x.icon} ` : ''}${esc(x.title)}</b>${x.line ? `<span>${esc(x.line)}</span>` : ''}</button>`;
      }).join('');
      const grid = ticks.map((h) => `<i style="left:${((h - h0) * 60 / span) * 100}%"></i>`).join('');
      const now = r.key === nowRow && nowMin() > h0 * 60 && nowMin() < h1 * 60 ? `<div class="hg-now" style="left:${P(nowMin())}%"></div>` : '';
      return `<div class="hg-label ${r.today ? 'today' : ''} ${r.cls || ''}">${onLabel ? `<button class="hg-lab" data-lab="${esc(r.key)}">${r.label}</button>` : `<b>${r.label}</b>`}${r.sub ? `<small>${r.sub}</small>` : ''}${r.extra || ''}</div>
        <div class="hg-track ${r.today ? 'today' : ''} ${r.cls || ''}" data-row="${esc(r.key)}" style="height:${n * LANE}px">${grid}${bars}${now}</div>`;
    }).join('');
    const head = `<div class="hg-corner"></div><div class="hg-ticks">${ticks.map((h) => `<span style="left:${((h - h0) * 60 / span) * 100}%">${narrow() ? String(h).padStart(2, '0') : hh(h)}</span>`).join('')}</div>`;
    el.innerHTML = (out ? `<button class="hg-out" data-out>⚠ มีรายการนอกช่วงที่แสดง ${out} รายการ — กดเพื่อขยายดู</button>` : '')
      + (twTemp ? `<button class="hg-out back" data-back>กำลังดูช่วง ${hh(twTemp.from)}–${hh(twTemp.to)} ชั่วคราว — กลับช่วงปกติ ${hh(tw.from)}–${hh(tw.to)}</button>` : '')
      + (rows.length ? `<div class="hg">${head}${body}</div>` : '') + (empty || '');
    el.querySelector('[data-out]')?.addEventListener('click', () => { twTemp = { from: Math.max(0, Math.min(h0, Math.floor(outMin / 60))), to: Math.min(24, Math.max(h1, Math.ceil(outMax / 60))) }; rerender(); });
    el.querySelector('[data-back]')?.addEventListener('click', () => { twTemp = null; rerender(); });
    el.querySelectorAll('.hg-bar[data-id]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); onItem(b.dataset.id); }));
    if (onLabel) el.querySelectorAll('[data-lab]').forEach((b) => (b.onclick = () => onLabel(b.dataset.lab)));
    if (onEmpty) el.querySelectorAll('.hg-track').forEach((t) => (t.onclick = (e) => {
      if (e.target.closest('.hg-bar')) return;
      const rect = t.getBoundingClientRect();
      const m = Math.max(0, Math.min(23 * 60, roundTo(h0 * 60 + ((e.clientX - rect.left) / rect.width) * span, 30)));
      onEmpty(t.dataset.row, m, e);
    }));
  }

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
      setNb('rooms', badges.booking_queue + badges.move_requests);
    } catch { /* เงียบ */ }
  };

  // =====================================================================
  // ปฏิทินของฉัน
  // =====================================================================
  const LAYERS = [
    ['sessions', 'คาบเรียน', '#3C6E58'], ['tasks', 'งาน/นัดหมาย', '#C68A2E'], ['bookings', 'การจองห้องของฉัน', '#2F5F8F'],
    ['holidays', 'วันหยุด', '#B23A2E'], ['leaves', 'ไม่อยู่/ลา', '#6E5FA8'],
  ];
  const cal = { view: 'week', anchor: null, show: 'mine', assigned: true, showDone: true, layers: LAYERS.map((l) => l[0]), items: [], seq: 0, loaded: false, todoOpen: true };
  // ปฏิทินของฉัน (ตกลง 14 ต.ค. 2569): เห็นของตัวเองเท่านั้น · รวมเมนู "งานของฉัน" เดิมไว้ที่นี่ (แถบงานที่ต้องทำ)
  const MEETING = '#0E7490';
  const isMeeting = (it) => it.type === 'task' && it.ref?.task_type === 'meeting';
  const itemColor = (it) => it.type === 'session' ? courseColor(it.course_code || '?') : isMeeting(it) ? MEETING : it.type === 'task' ? '#C68A2E' : it.type === 'booking' ? '#2F5F8F' : it.type === 'holiday' ? '#B23A2E' : '#6E5FA8';
  const FLAG = { no_room: ['fl-noroom', 'ไม่มีห้อง'], room_pending: ['fl-pend', 'รอห้อง'], makeup: ['fl-mk', 'ชดเชย'], overdue: ['fl-od', 'เลยกำหนด'], pending: ['fl-pend', 'รออนุมัติ'], private: ['fl-mk', '🔒'], assigned: ['fl-mk', 'ฉันมอบหมาย'] };
  const flagHtml = (it) => (it.flags || []).filter((f) => FLAG[f]).map((f) => `<em class="fl ${FLAG[f][0]}">${FLAG[f][1]}</em>`).join('');

  function saveCalSettings() {
    clearTimeout(saveCalSettings.t);
    saveCalSettings.t = setTimeout(() => {
      wApi('cal_settings_save', { settings: { show: 'mine', layers: cal.layers, view: cal.view, assigned: cal.assigned, show_done: cal.showDone } }).catch(() => {});
    }, 700);
  }

  const AG_DAYS = 14;
  function calRange() {
    const a = cal.anchor;
    if (cal.view === 'day') return { from: a, to: a, days: [a] };
    if (cal.view === 'week') {
      const from = addDays(a, -dow(a));
      const days = [...Array(7)].map((_, i) => addDays(from, i));
      return { from, to: days[6], days };
    }
    if (cal.view === 'month') {
      const first = `${a.slice(0, 7)}-01`, from = addDays(first, -dow(first));
      const days = [...Array(42)].map((_, i) => addDays(from, i));
      return { from, to: days[41], days, ym: a.slice(0, 7) };
    }
    // รายการ: หน้าละ 14 วัน (2 สัปดาห์)
    const days = [...Array(AG_DAYS)].map((_, i) => addDays(a, i));
    return { from: a, to: days[AG_DAYS - 1], days };
  }
  function calStep(dir) {
    if (cal.view === 'day') return addDays(cal.anchor, dir);
    if (cal.view === 'week') return addDays(cal.anchor, dir * 7);
    if (cal.view === 'agenda') return addDays(cal.anchor, dir * AG_DAYS);
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
      <div class="todo" id="myTodo"></div>
      <div class="wbar">
        <div class="layers" id="myLayers"></div>
        <span class="spacer"></span><button class="btn btn-ghost btn-sm" id="myTw" title="ปรับช่วงเวลาที่แสดง"></button><span class="muted" id="myCount"></span>
      </div>
      <div id="myBody"><div class="skel"></div></div>
      <div class="err" id="myErr"></div>
      <button class="fab" id="myFab" aria-label="สร้าง" data-menu-anchor>+</button>`;
    $('myPrev').onclick = () => go(myHash(cal.view, calStep(-1)));
    $('myNext').onclick = () => go(myHash(cal.view, calStep(1)));
    $('myToday').onclick = () => go(myHash(cal.view, bkkToday()));
    $('myView').querySelectorAll('button').forEach((b) => (b.onclick = () => { cal.view = b.dataset.v; saveCalSettings(); go(myHash(b.dataset.v, cal.anchor)); }));
    $('myTw').onclick = () => twDialog(() => { renderMyChrome(); renderMyBody(); });
    const newMenu = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      createMenu(r.left + window.scrollX, r.bottom + window.scrollY + 4, { date: cal.view === 'day' ? cal.anchor : bkkToday() });
    };
    $('myNew').onclick = newMenu; $('myFab').onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); createMenu(r.left + window.scrollX - 150, r.top + window.scrollY - 150, { date: cal.view === 'day' ? cal.anchor : bkkToday() }); };
    let lastNarrow = narrow();
    window.addEventListener('resize', () => { if (narrow() !== lastNarrow && !$('viewMy').hidden && (cal.view === 'week' || cal.view === 'day')) { lastNarrow = narrow(); renderMyBody(); } });
  }

  function renderMyChrome() {
    $('myView').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === cal.view));
    $('myTw').hidden = !(cal.view === 'day' || cal.view === 'week');
    $('myTw').textContent = twLabel();
    $('myLayers').innerHTML = LAYERS.map(([k, t, c]) => `<button class="layer ${cal.layers.includes(k) ? 'on' : ''}" data-l="${k}"><i style="background:${c}"></i>${t}</button>`).join('')
      + `<span class="lsep"></span><button class="layer ${cal.assigned ? 'on' : ''}" data-f="assigned" title="งานที่ฉันสั่งให้คนอื่นทำ (เส้นประ)"><i style="background:#8a8f8c"></i>งานที่ฉันมอบหมาย</button>`
      + `<button class="layer ${cal.showDone ? 'on' : ''}" data-f="done"><i style="background:#3C8C65"></i>แสดงงานที่เสร็จแล้ว</button>`;
    $('myLayers').querySelectorAll('[data-l]').forEach((b) => (b.onclick = () => {
      const k = b.dataset.l; cal.layers = cal.layers.includes(k) ? cal.layers.filter((x) => x !== k) : [...cal.layers, k];
      saveCalSettings(); renderMyChrome(); loadMy();
    }));
    $('myLayers').querySelector('[data-f="assigned"]').onclick = () => { cal.assigned = !cal.assigned; saveCalSettings(); renderMyChrome(); loadMy(); };
    $('myLayers').querySelector('[data-f="done"]').onclick = () => { cal.showDone = !cal.showDone; saveCalSettings(); renderMyChrome(); renderMyBody(); };
    const r = calRange();
    $('myTitle').textContent = cal.view === 'day' ? fmtLong(r.from)
      : cal.view === 'month' ? thMonthOf(r.ym + '-15')
      : `${fmtD(r.from, { weekday: undefined })} – ${fmtD(r.to, { weekday: undefined, year: 'numeric' })}`;
  }

  const uniqBy = (arr, k) => { const s = new Set(); return arr.filter((x) => (s.has(x[k]) ? false : s.add(x[k]))); };

  W.openMy = async (view, date, opts = {}) => {
    show('viewMy');
    buildMySkeleton();
    try { await W.init(); } catch (e) { $('myErr').textContent = e.message; return; }
    if (!cal.loaded) {
      const s = INIT.calendar_settings || {};
      cal.show = 'mine'; cal.assigned = s.assigned !== false; cal.showDone = s.show_done !== false;
      try { cal.todoOpen = localStorage.getItem('csl_todo_open') !== '0'; } catch { /* ไม่มี storage */ }
      cal.layers = Array.isArray(s.layers) && s.layers.length ? s.layers : cal.layers;
      cal.view = s.view || (narrow() ? 'agenda' : 'week');
      cal.loaded = true;
    }
    if (['day', 'week', 'month', 'agenda'].includes(view)) cal.view = view;
    cal.anchor = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : (cal.anchor || bkkToday());
    if (opts.todo) cal.todoOpen = true;
    renderMyChrome();
    loadMy();
    loadTodo();
  };

  async function loadMy() {
    const r = calRange(), seq = ++cal.seq;
    $('myErr').textContent = '';
    $('myBody').classList.add('loading');
    try {
      const d = await wApi('cal_feed', { from: r.from, to: r.to, show: 'mine', assigned: cal.assigned, layers: cal.layers });
      if (seq !== cal.seq) return;
      cal.items = d.items;
      $('myCount').textContent = `${d.counts.total} รายการ`;
      renderMyBody();
    } catch (e) { if (seq === cal.seq) $('myErr').textContent = e.message; }
    finally { if (seq === cal.seq) $('myBody').classList.remove('loading'); }
  }
  W.reloadMy = () => { if (!$('viewMy').hidden) { loadMy(); loadTodo(); } };

  // ---------- แถบ "งานที่ต้องทำ" (เลยกำหนด + วันนี้) — แสดงทุกมุมมอง ติ๊กเสร็จได้ทันที ----------
  async function loadTodo() {
    const box = $('myTodo');
    if (!box) return;
    const today = bkkToday();
    try {
      const d = await wApi('task_list', { scope: 'mine', from: addDays(today, -365), to: today, todo_only: true });
      const list = d.tasks.filter((t) => t.status === 'todo').sort((a, b) => (b.overdue - a.overdue) || a.task_date.localeCompare(b.task_date) || String(a.start_time ?? '').localeCompare(String(b.start_time ?? '')));
      const od = list.filter((t) => t.overdue).length;
      box.className = `todo ${cal.todoOpen ? 'open' : ''} ${od ? 'has-od' : ''}`;
      box.innerHTML = `<button class="todo-h" data-tog><b>☑ งานที่ต้องทำ</b>
          <span class="tag ${list.length ? 'amber' : 'teal'}">${list.length ? `${list.length} งาน` : 'ไม่มีงานค้าง 🎉'}</span>${od ? `<span class="tag red">เลยกำหนด ${od}</span>` : ''}
          <span class="spacer"></span><span class="muted">${cal.todoOpen ? 'ย่อ ▴' : 'ดู ▾'}</span></button>
        ${cal.todoOpen && list.length ? `<div class="todo-list">${list.map((t) => `<div class="todo-i ${t.overdue ? 'od' : ''}">
          <button class="chk" data-done="${esc(t.task_id)}" ${t.can_edit ? '' : 'disabled'} aria-label="ทำเสร็จ"></button>
          <button class="todo-t" data-open="${esc(t.task_id)}"><b>${esc(t.title)}</b>
            <span>${t.overdue ? `<em class="fl fl-od">เลยกำหนด ${fmtD(t.task_date)}</em> ` : 'วันนี้ '}${t.start_time ? `<span class="mono">${t.start_time}</span> ` : ''}${esc([t.task_type_th, t.course_code, t.created_by !== INIT.me.user_id && t.created_by_name ? `มอบหมายโดย ${t.created_by_name}` : ''].filter(Boolean).join(' · '))}</span></button></div>`).join('')}</div>` : ''}`;
      box.querySelector('[data-tog]').onclick = () => { cal.todoOpen = !cal.todoOpen; try { localStorage.setItem('csl_todo_open', cal.todoOpen ? '1' : '0'); } catch { /* ข้าม */ } loadTodo(); };
      box.querySelectorAll('[data-done]').forEach((b) => (b.onclick = () => busy(b, async () => {
        try { await wApi('task_status', { task_id: b.dataset.done, status: 'done' }); toast('เสร็จแล้ว ✓'); afterChange(); } catch (e) { toast(e.message); }
      })));
      box.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => {
        const t = list.find((x) => x.task_id === b.dataset.open);
        taskForm({ task_id: t.task_id, title: t.title, task_type: t.task_type, task_date: t.task_date, start_time: t.start_time || '', duration_hours: t.duration_hours, assignee_id: t.assignee_id, is_private: t.is_private, note: t.note, place: t.place, course_id: t.course_id });
      }));
    } catch (e) { box.className = 'todo'; box.innerHTML = `<div class="muted">โหลดงานที่ต้องทำไม่ได้: ${esc(e.message)}</div>`; }
  }
  // ติ๊กเสร็จ/ยกเลิกเสร็จจากปฏิทิน (มุมมองรายการ)
  async function toggleTask(it, btn) {
    await busy(btn, async () => {
      try { await wApi('task_status', { task_id: it.ref.task_id, status: it.status === 'done' ? 'todo' : 'done' }); toast(it.status === 'done' ? 'กลับเป็นต้องทำ' : 'เสร็จแล้ว ✓'); afterChange(); }
      catch (e) { toast(e.message); }
    });
  }

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
    cal.view_items = groupSessions(cal.showDone ? cal.items : cal.items.filter((i) => !(i.type === 'task' && i.status === 'done')));
    const r = calRange();
    if (cal.view === 'month') renderMonth(r);
    else if (cal.view === 'agenda') renderAgenda(r);
    else renderTimeGrid(r);
  }

  // วัน/สัปดาห์: แบบตารางเรียน — วันอยู่ด้านซ้าย (1 แถว = 1 วัน) เวลาอยู่ด้านบน
  function renderTimeGrid(r) {
    const days = r.days, today = bkkToday(), items = cal.view_items;
    const isAllDay = (i) => !i.start || i.type === 'holiday' || i.type === 'away';
    const tick = (i) => (isMeeting(i) ? '📅 ' : i.type === 'task' ? (i.status === 'done' ? '✓ ' : '☐ ') : '');
    const rows = days.map((d) => {
      const hol = items.find((i) => i.type === 'holiday' && coversDay(i, d));
      const ad = items.filter((i) => isAllDay(i) && i.type !== 'holiday' && coversDay(i, d));
      return {
        key: d, today: d === today, cls: hol ? 'hol' : '',
        label: `${WD[dow(d)]} ${Number(d.slice(8))}${d.slice(5, 7) !== days[0].slice(5, 7) || cal.view === 'day' ? ' ' + fmtD(d, { weekday: undefined, day: undefined }) : ''}`,
        sub: [hol ? esc(hol.title) : '', d === today ? 'วันนี้' : ''].filter(Boolean).join(' · '),
        extra: ad.length ? `<div class="hg-ad">${ad.map((i) => `<button class="ad t-${i.type} ${i.mine ? '' : 'other'}" data-ad="${esc(i.id)}" title="${esc(i.title)}">${tick(i)}${esc(i.title)}</button>`).join('')}</div>` : '',
        items: items.filter((i) => !isAllDay(i) && i.date === d).map((i) => {
          const s = toMin(i.start), e = Math.max(toMin(i.end || i.start), s + 30), col = itemColor(i);
          const flags = (i.flags || []).filter((f) => FLAG[f]).map((f) => FLAG[f][1]).join(' ');
          return {
            id: i.id, s, e, title: `${tick(i)}${i.title}`,
            line: [`${i.start}${i.end ? '–' + i.end : ''}`, i.room, i.who && `👤 ${i.who}`, flags].filter(Boolean).join(' · '),
            tip: [i.title, `${i.start}${i.end ? '–' + i.end : ''}`, i.room, i.who && `👤 ${i.who}`, i.sub].filter(Boolean).join(' · '),
            cls: [i.mine ? '' : 'other', i.status === 'cancelled' ? 'cancel' : '', i.status === 'done' ? 'done' : ''].join(' '),
            style: `border-left-color:${col};background:${i.mine ? tint(col, 16) : '#fff'}`,
          };
        }),
      };
    });
    hgrid($('myBody'), {
      rows, nowRow: today,
      onItem: openItem,
      onLabel: cal.view === 'week' ? (d) => go(myHash('day', d)) : null,
      onEmpty: (d, m, e) => createMenu(e.pageX, e.pageY, { date: d, start: fromMin(m), end: fromMin(Math.min(23 * 60 + 30, m + 120)) }),
      rerender: () => { renderMyChrome(); renderMyBody(); },
      empty: items.length ? '' : '<div class="empty" style="margin-top:10px">ไม่มีรายการในช่วงนี้ — กดช่องว่างหรือ "+ สร้าง" เพื่อเพิ่มงาน/นัดหมาย</div>',
    });
    $('myBody').querySelectorAll('[data-ad]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openItem(b.dataset.ad); }));
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

  // รายการ: 1 แถวต่อ 1 วัน (หน้าละ 14 วัน) — กดที่วันเพื่อกางรายละเอียด
  const AG_TYPE = { session: ['คาบ', '#3C6E58'], task: ['งาน', '#C68A2E'], meeting: ['นัดหมาย', MEETING], booking: ['จองห้อง', '#2F5F8F'], away: ['ไม่อยู่/ลา', '#6E5FA8'], leave: ['ไม่อยู่/ลา', '#6E5FA8'] };
  function renderAgenda(r) {
    const today = bkkToday();
    cal.open ||= new Set([today]);
    const rows = r.days.map((d) => {
      const list = cal.view_items.filter((i) => coversDay(i, d));
      const hol = list.find((i) => i.type === 'holiday');
      const rest = list.filter((i) => i.type !== 'holiday').sort((a, b) => String(a.start ?? '').localeCompare(String(b.start ?? '')));
      if (!rest.length && !hol) return '';
      const counts = new Map();
      for (const i of rest) { const [t, c] = AG_TYPE[isMeeting(i) ? 'meeting' : i.type] || ['อื่น ๆ', '#888']; const k = counts.get(t) || { n: 0, c }; k.n++; counts.set(t, k); }
      const open = cal.open.has(d);
      const detail = open ? `<div class="ag-items">${rest.map((i) => {
        const col = itemColor(i);
        const canTick = i.type === 'task' && !isMeeting(i) && i.ref?.can_edit;
        return `<div class="agi ${i.mine ? '' : 'other'} ${i.status === 'cancelled' ? 'cancel' : ''} ${i.status === 'done' ? 'done' : ''}" role="button" tabindex="0" data-id="${esc(i.id)}" style="border-left-color:${col}">
          <span class="tm">${canTick ? `<button class="chk ${i.status === 'done' ? 'on' : ''}" data-tk="${esc(i.id)}" aria-label="ทำเสร็จ">${i.status === 'done' ? '✓' : ''}</button> ` : isMeeting(i) ? '📅 ' : ''}${i.start ? `${i.start}${i.end ? '–' + i.end : ''}` : 'ทั้งวัน'}</span>
          <span class="tt">${esc(i.title)} ${flagHtml(i)}<small>${esc([i.sub, i.room, i.who && `👤 ${i.who}`].filter(Boolean).join(' · '))}</small></span>
          <span class="side">${i.type === 'session' && i.status === 'cancelled' ? '<span class="tag red">งด</span>' : ''}${i.type === 'booking' ? statusTag(i.status) : ''}</span></div>`;
      }).join('') || '<div class="muted" style="padding:6px 2px">ไม่มีรายการ</div>'}</div>` : '';
      return `<div class="ag-day ${open ? 'open' : ''}"><button class="ag-row ${d === today ? 'today' : ''}" data-day="${d}">
          <span class="ag-date">${fmtD(d)}${d === today ? ' · วันนี้' : ''}</span>
          <span class="ag-sum">${hol ? `<span class="tag red">${esc(hol.title)}</span>` : ''}${[...counts].map(([t, k]) => `<span class="ag-c"><i style="background:${k.c}"></i>${t} ${k.n}</span>`).join('')}</span>
          <span class="ag-arrow">${open ? '▴' : '▾'}</span></button>${detail}</div>`;
    }).join('');
    const pager = `<div class="ag-pager"><button class="btn btn-ghost btn-sm" data-pg="-1">◀ 14 วันก่อนหน้า</button><span class="muted">${fmtD(r.from)} – ${fmtD(r.to)}</span><button class="btn btn-ghost btn-sm" data-pg="1">14 วันถัดไป ▶</button></div>`;
    $('myBody').innerHTML = (rows ? `<div class="ag-tools"><button class="btn btn-ghost btn-sm" data-all="1">กางทั้งหมด</button><button class="btn btn-ghost btn-sm" data-all="0">ย่อทั้งหมด</button></div>${rows}` : `<div class="empty">ไม่มีรายการใน 14 วันนี้</div>`) + pager;
    $('myBody').querySelectorAll('[data-day]').forEach((b) => (b.onclick = () => { const d = b.dataset.day; cal.open.has(d) ? cal.open.delete(d) : cal.open.add(d); renderAgenda(r); }));
    $('myBody').querySelectorAll('[data-all]').forEach((b) => (b.onclick = () => { cal.open = new Set(b.dataset.all === '1' ? r.days : []); renderAgenda(r); }));
    $('myBody').querySelectorAll('[data-pg]').forEach((b) => (b.onclick = () => go(myHash('agenda', calStep(Number(b.dataset.pg))))));
    $('myBody').querySelectorAll('.agi[data-id]').forEach((b) => (b.onclick = () => openItem(b.dataset.id)));
    $('myBody').querySelectorAll('[data-tk]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); toggleTask(cal.items.find((x) => x.id === b.dataset.tk), b); }));
  }

  function createMenu(x, y, pre) {
    menu(x, y, pre.start ? `${fmtD(pre.date)} ${pre.start}` : fmtD(pre.date), [
      { label: '📝 งาน', run: () => taskForm({ task_date: pre.date, start_time: pre.start || '' }) },
      { label: '📅 นัดหมาย/ประชุม', run: () => taskForm({ task_type: 'meeting', task_date: pre.date, start_time: pre.start || '', duration_hours: pre.start ? 1 : '' }) },
      { label: '🙈 วันที่ฉันไม่อยู่', run: () => awayForm({ from: pre.date }) },
      ...(INIT.courses.some((c) => c.can_manage) ? [{ label: '⚙️ สร้างงานจากสิ่งที่ต้องเตรียม', run: genForm }] : []),
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
  async function showFree(md, date, st, en, targetSel, outSel, onPick) {
    const out = md.q(outSel);
    if (!date || !st || !en || en <= st) { out.innerHTML = ''; return; }
    out.innerHTML = '<span class="muted">กำลังตรวจห้องว่าง…</span>';
    try {
      const d = await bApi('free_rooms', { starts_at: isoAt(date, st), ends_at: isoAt(date, en) });
      const cur = md.q(targetSel).value;
      const ok = d.rooms.some((r) => r.location_id === cur);
      out.innerHTML = `${ok ? '<span class="tag teal">ห้องที่เลือกว่าง</span>' : '<span class="tag red">ห้องที่เลือกไม่ว่าง</span>'}
        ${d.rooms.length ? `<div class="muted" style="margin-top:4px">ห้องว่างช่วงนี้: ${d.rooms.map((r) => `<a href="#" data-pick="${esc(r.location_id)}">${esc(r.name)}</a>`).join(' · ')}</div>` : '<div class="muted">ไม่มีห้องว่างเลยช่วงนี้</div>'}`;
      out.querySelectorAll('[data-pick]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); md.q(targetSel).value = a.dataset.pick; if (onPick) onPick(); else showFree(md, date, st, en, targetSel, outSel); }));
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

  function afterChange() { rm.extra = null; W.reloadMy(); W.refreshBadges(); if (!$('viewRooms').hidden) loadRooms(); if (!$('viewInbox').hidden) loadInbox({ only: ib.only }); }
  W.afterChange = afterChange;

  // ---------- งาน ----------
  function taskDetail(it) {
    const f = it.ref, meet = f.task_type === 'meeting';
    const md = modal(`${meet ? '📅 ' : ''}${it.title}`, `
      <dl class="dl">
        <dt>วัน</dt><dd>${fmtLong(it.date)}${it.start ? ` · <b class="mono">${it.start}${it.end ? '–' + it.end : ''}</b>` : ''}${f.duration_hours ? ` (${Number(f.duration_hours)} ชม.)` : ''}</dd>
        <dt>ประเภท</dt><dd>${esc(it.sub || '')}</dd>
        ${it.room ? `<dt>${meet ? 'สถานที่' : 'ห้อง'}</dt><dd>${esc(it.room)}</dd>` : ''}
        <dt>${meet ? 'ของ' : 'ผู้รับงาน'}</dt><dd>${esc(person(f.assignee_id)?.full_name || '—')}</dd>
        <dt>สร้างโดย</dt><dd>${esc(person(f.created_by)?.full_name || '—')}${f.source === 'rule' ? ' <span class="tag">จากสิ่งที่ต้องเตรียมต่อบท</span>' : ''}</dd>
        ${meet ? '' : `<dt>สถานะ</dt><dd>${it.status === 'done' ? '<span class="tag teal">เสร็จแล้ว</span>' : it.flags.includes('overdue') ? '<span class="tag red">เลยกำหนด</span>' : '<span class="tag amber">ต้องทำ</span>'} ${f.is_private ? '<span class="tag">🔒 ส่วนตัว</span>' : ''}</dd>`}
        ${f.note ? `<dt>หมายเหตุ</dt><dd>${esc(f.note)}</dd>` : ''}
      </dl>
      ${f.can_edit ? `<div class="row" style="gap:6px">
        ${meet ? '' : `<button class="btn ${it.status === 'done' ? 'btn-ghost' : 'btn-ok'} btn-sm" data-a="toggle">${it.status === 'done' ? '↩︎ ยังไม่เสร็จ' : '✓ ทำเสร็จแล้ว'}</button>`}
        <button class="btn btn-ghost btn-sm" data-a="edit">แก้ไข</button>
        <span class="spacer"></span><button class="btn btn-ghost btn-sm" data-a="del">ลบ</button></div>` : '<div class="muted">แก้ได้เฉพาะผู้สร้าง ผู้รับงาน หรือผู้ประสานรายวิชา</div>'}`);
    md.qa('[data-a]').forEach((b) => (b.onclick = () => busy(b, async () => {
      try {
        if (b.dataset.a === 'toggle') { await wApi('task_status', { task_id: f.task_id, status: it.status === 'done' ? 'todo' : 'done' }); md.close(); afterChange(); }
        if (b.dataset.a === 'edit') { md.close(); taskForm({ task_id: f.task_id, title: it.title, task_type: f.task_type, task_date: it.date, start_time: it.start || '', duration_hours: f.duration_hours, assignee_id: f.assignee_id, is_private: f.is_private, note: f.note, place: f.place, course_id: it.course_id, course_label: it.course_code }); }
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
    const meet0 = p.task_type === 'meeting';
    const md = modal(editing ? (meet0 ? 'แก้ไขนัดหมาย' : 'แก้ไขงาน') : (meet0 ? 'นัดหมาย/ประชุมใหม่' : 'งานใหม่'), `
      <div class="fgrid">
        <div class="full"><label data-lt>${meet0 ? 'เรื่อง *' : 'ชื่องาน *'}</label><input data-k="title" value="${esc(p.title || '')}" maxlength="200" placeholder="${meet0 ? 'เช่น ประชุมกรรมการห้องปฏิบัติการ' : 'เช่น เตรียมสารละลาย NaOH 0.1 M'}"></div>
        <div><label>ประเภท</label><select data-k="task_type">${types.map(([k, t]) => opt(k, t, p.task_type || 'other')).join('')}</select></div>
        <div><label>วันที่ *</label><input type="date" data-k="task_date" value="${esc(p.task_date || bkkToday())}"></div>
        <div><label>เวลาเริ่ม</label><input type="time" data-k="start_time" value="${esc(p.start_time || '')}" step="300"></div>
        <div><label>ใช้เวลา (ชม.)</label><input type="number" data-k="duration_hours" value="${esc(p.duration_hours ?? '')}" min="0.25" max="24" step="0.25" inputmode="decimal"></div>
        <div class="full" data-place ${meet0 ? '' : 'hidden'}><label>สถานที่</label><input data-k="place" value="${esc(p.place || '')}" maxlength="200" placeholder="เช่น ห้องประชุม 2 อาคาร 1 / ออนไลน์"></div>
        <div class="full"><label data-la>${meet0 ? 'ของ' : 'ผู้รับงาน'}</label><select data-k="assignee_id">${INIT.people.map((u) => opt(u.user_id, `${u.full_name}${u.is_me ? ' (ฉัน)' : ''} · ${u.position}`, p.assignee_id || INIT.me.user_id)).join('')}</select></div>
        ${p.schedule_id ? `<div class="full"><label>ของคาบ</label><div>${esc(p.course_label || '')}</div></div>`
          : `<div class="full"><label>รายวิชา (ถ้าเป็นงานของวิชา)</label><select data-k="course">${opt('', '— งานทั่วไป / ส่วนตัว —', '')}${myCourses.map((c) => opt(`${c.course_id}|${c.semester_id}`, `${c.course_code} · ${c.course_name}`, p.course_id ? `${p.course_id}|${c.semester_id}` : '')).join('')}</select></div>`}
        <div class="full"><label class="inl"><input type="checkbox" data-k="is_private" ${p.is_private ? 'checked' : ''}> ส่วนตัว (คนอื่นไม่เห็นในปฏิทิน · ใช้ได้กับงานที่ไม่ใช่ของวิชา)</label></div>
        <div class="full"><label>หมายเหตุ</label><textarea data-k="note">${esc(p.note || '')}</textarea></div>
      </div>
      <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn btn-ghost" data-no>ยกเลิก</button><button class="btn btn-primary" data-ok>${editing ? 'บันทึก' : 'สร้างงาน'}</button></div>`);
    const v = (k) => md.q(`[data-k="${k}"]`);
    const syncPriv = () => { const c = v('course'); if (c) { v('is_private').disabled = !!c.value; if (c.value) v('is_private').checked = false; } };
    const syncType = () => {
      const meet = v('task_type').value === 'meeting';
      md.q('[data-place]').hidden = !meet;
      md.q('[data-lt]').textContent = meet ? 'เรื่อง *' : 'ชื่องาน *';
      md.q('[data-la]').textContent = meet ? 'ของ' : 'ผู้รับงาน';
    };
    v('task_type').onchange = syncType;
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
        is_private: v('is_private').checked, note: v('note').value, place: v('task_type').value === 'meeting' ? v('place').value : '', notify_assignee: editing && v('assignee_id').value !== p.assignee_id,
      };
      if (p.schedule_id) body.schedule_id = p.schedule_id;
      else if (!editing || !p.course_id) { body.course_id = course_id || ''; body.semester_id = semester_id || ''; }
      if (!body.title) return md.err(body.task_type === 'meeting' ? 'ใส่เรื่องของนัดหมาย' : 'ใส่ชื่องาน');
      try { await wApi('task_save', body); md.close(); toast(body.task_type === 'meeting' ? 'บันทึกนัดหมายแล้ว' : editing ? 'บันทึกงานแล้ว' : 'สร้างงานแล้ว'); afterChange(); }
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
  // ปฏิทินห้อง (เดือน/สัปดาห์/วัน) + คำขอและสถานะ — ข้อตกลง 13 ต.ค. 2569
  const rm = { tab: 'board', view: 'month', date: null, bld: '', floor: '', loc: '', wk: '', filter: 'all', st: 'queue', seq: 0, data: null, extra: null };
  const ST_FILTERS = [['queue', '⏳ รออนุมัติ (ถึงฉัน)', 'q'], ['mine', '📋 คำขอของฉัน'], ['moves', '⇄ รอย้าย', 'mv'], ['term', '⚠ ยังไม่มีห้อง'], ['away', '🙈 วันไม่อยู่'], ['history', '🗂 ประวัติ']];
  const ST_META = { ok: ['✓', 'อนุมัติ'], pend: ['⏳', 'รออนุมัติ'], move: ['⇄', 'รอย้าย'], none: ['⚠', 'ยังไม่มีห้อง'] };
  const roomHash = (view = rm.view, d = rm.date) => `#rooms/board/${view}/${d}`;

  W.openRooms = async (tab, a2, a3) => {
    show('viewRooms');
    if (!$('viewRooms').dataset.built) {
      $('viewRooms').dataset.built = '1';
      $('viewRooms').innerHTML = `<div class="chips stchips" id="rmChips" hidden></div><div id="rmBody"></div><div class="err" id="rmErr"></div>`;
    }
    let t = tab || 'board';
    if (ST_FILTERS.some((f) => f[0] === t)) { rm.st = t; t = 'status'; } // ลิงก์เดิม #rooms/mine · moves · term · away
    if (t === 'status' && ST_FILTERS.some((f) => f[0] === a2)) rm.st = a2;
    if (t === 'board') {
      if (['month', 'week', 'day'].includes(a2)) { rm.view = a2; if (ISO_DATE.test(a3 || '')) rm.date = a3; }
      else if (ISO_DATE.test(a2 || '')) { rm.view = 'day'; rm.date = a2; } // ลิงก์เดิม #rooms/board/<วันที่>
    }
    rm.tab = t === 'status' ? 'status' : 'board';
    rm.date ||= bkkToday();
    $('rmErr').textContent = '';
    try { await W.init(); } catch (e) { $('rmErr').textContent = e.message; return; }
    loadRooms();
  };

  function loadRooms() {
    const chips = $('rmChips');
    chips.hidden = rm.tab !== 'status';
    if (rm.tab === 'board') return loadBoard();
    chips.innerHTML = ST_FILTERS.map(([k, t, nb]) => `<button class="chip ${k === rm.st ? 'on' : ''}" data-st="${k}">${t}${nb ? `<span class="nb" data-nb="${nb}"></span>` : ''}</button>`).join('');
    chips.querySelectorAll('[data-st]').forEach((b) => (b.onclick = () => go(`#rooms/status/${b.dataset.st}`)));
    W.refreshBadges();
    const s = rm.st;
    if (s === 'queue') { $('rmBody').innerHTML = '<div id="qBody"><div class="skel" style="height:200px"></div></div><div class="err" id="qErr"></div>'; return loadInbox({ body: 'qBody', err: 'qErr', only: 'rooms' }); }
    if (s === 'mine') return loadMine();
    if (s === 'moves') return loadMoves();
    if (s === 'term') return loadTerm();
    if (s === 'away') return loadAway();
    if (s === 'history') return loadHistory();
  }

  // ---------- ปฏิทินห้อง ----------
  function boardRange() {
    const a = rm.date;
    if (rm.view === 'day') return { from: a, days: [a] };
    if (rm.view === 'week') { const from = addDays(a, -dow(a)); return { from, days: [...Array(7)].map((_, i) => addDays(from, i)) }; }
    const first = `${a.slice(0, 7)}-01`, from = addDays(first, -dow(first));
    return { from, days: [...Array(42)].map((_, i) => addDays(from, i)), ym: a.slice(0, 7) };
  }
  function boardStep(dir) {
    if (rm.view === 'day') return addDays(rm.date, dir);
    if (rm.view === 'week') return addDays(rm.date, dir * 7);
    const [y, m] = rm.date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10);
  }
  const resvState = (x) => (x.pending_change || rm.extra?.moveIds?.has(x.reservation_id) ? 'move' : x.status === 'pending' ? 'pend' : 'ok');
  // การจองที่คร่อมวัน d (ไม่นับการจองที่จบเที่ยงคืนพอดีของวันก่อน)
  const covers = (x, d) => x.date <= d && dayIso(x.ends_at) >= d && !(x.date !== d && dayIso(x.ends_at) === d && x.end === '00:00');
  const shortRoom = (n) => String(n || '').replace(/\s*\(.*\)\s*$/, '');
  // สีบนปฏิทินห้อง = ประเภทการใช้ (สถานะบอกด้วยไอคอน + เส้นประ) — คลาส k-* อยู่ใน lib/work.css
  const KIND_GROUP = { class: 'class', makeup: 'class', prep: 'prep', reading: 'prep', research: 'research', project: 'research', service: 'research', exam: 'event', event: 'event', training: 'event', maintenance: 'maint' };
  const kindCls = (x) => `k-${KIND_GROUP[x.kind] || 'research'}`;
  const resvLabel = (x) => (x.course_code ? `${x.course_code}${x.section_no ? ' ก.' + x.section_no : ''}` : (x.title || x.project_name || x.kind_th));

  async function loadBoard() {
    const seq = ++rm.seq;
    if (!$('rmBody').querySelector('#rbWrap')) {
      $('rmBody').innerHTML = `<div class="wbar">
          <button class="btn btn-ghost btn-sm" id="rbPrev" aria-label="ก่อนหน้า">◀</button><button class="btn btn-ghost btn-sm" id="rbToday">วันนี้</button><button class="btn btn-ghost btn-sm" id="rbNext" aria-label="ถัดไป">▶</button>
          <h2 id="rbTitle"></h2><span class="spacer"></span>
          <div class="segc" id="rbView"><button data-v="month">เดือน</button><button data-v="week">สัปดาห์</button><button data-v="day">วัน</button></div>
          <button class="btn btn-primary btn-sm" id="rbNew">+ ขอจองห้อง</button></div>
        <div class="wbar">
          <select id="rbBld" aria-label="อาคาร"></select><select id="rbFloor" aria-label="ชั้น"></select><select id="rbLoc" aria-label="ห้อง"></select>
          <div class="segc" id="rbFilter"><button data-f="all">ทั้งหมด</button><button data-f="mine">ของฉัน</button><button data-f="pend">รออนุมัติ</button><button data-f="move">รอย้าย</button></div>
          <span class="spacer"></span><button class="btn btn-ghost btn-sm" id="rbTw" title="ปรับช่วงเวลาที่แสดง"></button></div>
        <div class="rlegend st-legend kd-legend"><b class="muted">สี = ประเภท</b><span class="k-class">คาบเรียน</span><span class="k-prep">เตรียม/อ่าน</span><span class="k-research">วิจัย/โครงการ/บริการ</span><span class="k-event">สอบ/อบรม/กิจกรรม</span><span class="k-maint">ซ่อมบำรุง</span></div>
        <div class="rlegend st-legend"><b class="muted">สถานะ</b><span class="k-plain">✓ อนุมัติ</span><span class="k-plain st-pend">⏳ รออนุมัติ (เส้นประ)</span><span class="k-plain st-move">⇄ รอย้าย</span><span class="st-none">⚠ ยังไม่มีห้อง</span>
          <span class="muted">ปฏิเสธ/ยกเลิก ไม่แสดงบนปฏิทิน — ดูที่ "คำขอและสถานะ › ประวัติ"</span></div>
        <div id="rbWarn"></div><div id="rbWrap"><div class="skel"></div></div>`;
      $('rbPrev').onclick = () => go(roomHash(rm.view, boardStep(-1)));
      $('rbNext').onclick = () => go(roomHash(rm.view, boardStep(1)));
      $('rbToday').onclick = () => go(roomHash(rm.view, bkkToday()));
      $('rbView').querySelectorAll('button').forEach((b) => (b.onclick = () => go(roomHash(b.dataset.v, rm.date))));
      $('rbFilter').querySelectorAll('button').forEach((b) => (b.onclick = () => { rm.filter = b.dataset.f; renderBoard(); }));
      $('rbNew').onclick = () => bookingForm({ date: rm.date, location_id: (rm.view === 'week' ? rm.wk : rm.loc) || undefined });
      $('rbTw').onclick = () => twDialog(renderBoard);
      // รายสัปดาห์ดูทีละห้อง (rm.wk) แยกจากตัวกรองห้องของรายเดือน/รายวัน (rm.loc)
      const onSel = (k) => () => {
        const v = $(k === 'bld' ? 'rbBld' : k === 'floor' ? 'rbFloor' : 'rbLoc').value;
        if (k === 'loc' && rm.view === 'week') rm.wk = v; else rm[k] = v;
        if (k === 'bld') { rm.floor = ''; rm.loc = ''; } if (k === 'floor') rm.loc = '';
        renderBoard();
      };
      $('rbBld').onchange = onSel('bld'); $('rbFloor').onchange = onSel('floor'); $('rbLoc').onchange = onSel('loc');
      rm.data = null;
    }
    const r = boardRange();
    $('rbWrap').classList.add('loading');
    try {
      // API ให้ทีละไม่เกิน 14 วัน → เดือน (42 วัน) ดึง 3 ช่วง
      const chunks = [];
      for (let i = 0; i < r.days.length; i += 14) chunks.push(bApi('rooms_board', { date: r.days[i], days: Math.min(14, r.days.length - i) }));
      if (!rm.extra) {
        rm.extra = { p: Promise.all([
          bApi('move_list').catch(() => ({ sent: [], received: [] })),
          bApi('away_list').catch(() => ({ away: [] })),
          bApi('dashboard', {}).catch(() => ({ courses: [] })),
        ]) };
      }
      const [parts, [mv, aw, dash]] = await Promise.all([Promise.all(chunks), rm.extra.p]);
      if (seq !== rm.seq) return;
      rm.extra.moveIds = new Set([...(mv.sent || []), ...(mv.received || [])].filter((m) => m.status === 'pending').map((m) => m.reservation_id));
      rm.extra.away = aw.away || [];
      rm.extra.term = (dash.courses || []).filter((c) => ['incomplete', 'not_sent'].includes(c.status));
      const seen = new Set();
      rm.data = {
        range: r,
        rooms: parts[0].rooms,
        roomsById: new Map(parts.flatMap((p) => p.rooms).map((x) => [x.location_id, x])),
        reservations: parts.flatMap((p) => p.reservations).filter((x) => (seen.has(x.reservation_id) ? false : seen.add(x.reservation_id))),
      };
      renderBoard();
    } catch (e) { $('rmErr').textContent = e.message; }
    finally { $('rbWrap').classList.remove('loading'); }
  }

  function boardRooms() {
    const all = rm.data.rooms;
    const blds = [...new Set(all.map((x) => x.building).filter(Boolean))].sort();
    const floors = [...new Set(all.filter((x) => !rm.bld || x.building === rm.bld).map((x) => x.floor).filter(Boolean))].sort();
    $('rbBld').innerHTML = opt('', 'ทุกอาคาร', rm.bld) + blds.map((b) => opt(b, `อาคาร ${b}`, rm.bld)).join('');
    $('rbFloor').innerHTML = opt('', 'ทุกชั้น', rm.floor) + floors.map((f) => opt(f, `ชั้น ${f}`, rm.floor)).join('');
    const inScope = all.filter((x) => (!rm.bld || x.building === rm.bld) && (!rm.floor || String(x.floor) === String(rm.floor)));
    if (rm.loc && !inScope.some((x) => x.location_id === rm.loc)) rm.loc = '';
    $('rbBld').hidden = blds.length < 2 && !rm.bld; $('rbFloor').hidden = floors.length < 2 && !rm.floor;
    if (rm.view === 'week') {
      const wk = inScope.find((x) => x.location_id === rm.wk) || inScope.find((x) => x.location_id === rm.loc) || inScope[0];
      $('rbLoc').innerHTML = inScope.map((x) => opt(x.location_id, x.name, wk?.location_id)).join('');
      return wk ? [wk] : [];
    }
    $('rbLoc').innerHTML = opt('', 'ทุกห้อง', rm.loc) + inScope.map((x) => opt(x.location_id, x.name, rm.loc)).join('');
    return rm.loc ? inScope.filter((x) => x.location_id === rm.loc) : inScope;
  }

  function renderBoard() {
    if (!rm.data) return;
    $('rbView').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === rm.view));
    $('rbFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === rm.filter));
    $('rbTw').hidden = rm.view === 'month'; $('rbTw').textContent = twLabel();
    const r = rm.data.range;
    $('rbTitle').textContent = rm.view === 'day' ? fmtLong(rm.date) : rm.view === 'month' ? thMonthOf(`${r.ym}-15`) : `${fmtD(r.days[0], { weekday: undefined })} – ${fmtD(r.days[6], { weekday: undefined, year: 'numeric' })}`;
    const rooms = boardRooms();
    const ids = new Set(rooms.map((x) => x.location_id));
    const me = INIT.me.user_id;
    const list = rm.data.reservations.filter((x) => ids.has(x.location_id) && (rm.filter === 'all' || (rm.filter === 'mine' ? x.requested_by === me : resvState(x) === rm.filter)));
    const term = rm.extra?.term || [];
    $('rbWarn').innerHTML = term.length ? `<button class="hg-out warn" id="rbTerm">⚠ งานต้นเทอม: ${term.length} วิชายังไม่มีห้องครบ (${esc(term.slice(0, 4).map((c) => c.course_code).join(', '))}${term.length > 4 ? '…' : ''}) — กดเพื่อจัดการ</button>` : '';
    if ($('rbTerm')) $('rbTerm').onclick = () => go('#rooms/status/term');
    if (rm.view === 'month') return renderRoomMonth(r, list);
    if (rm.view === 'week') return renderRoomWeek(r, list, rooms[0]);
    return renderRoomDay(list, rooms);
  }

  function openResv(id) {
    const x = rm.data.reservations.find((y) => y.reservation_id === id);
    if (!x) return;
    bookingDetail(x, rm.data.roomsById.get(x.location_id)?.can_approve || myRoom(x.location_id));
  }
  const barOf = (x, d) => {
    const s = x.date < d ? 0 : toMin(x.start), e = dayIso(x.ends_at) > d ? 24 * 60 : toMin(x.end), st = resvState(x);
    const mine = x.requested_by === INIT.me.user_id;
    return {
      id: x.reservation_id, s, e, pad0: x.setup_minutes, pad1: x.teardown_minutes, icon: ST_META[st][0], title: resvLabel(x),
      line: `${x.start}–${x.end} · ${ST_META[st][1]}`,
      tip: `${resvLabel(x)} · ${x.start}–${x.end} · ${x.room || ''} · ${ST_META[st][1]}${x.requester?.full_name ? ' · ' + x.requester.full_name : ''}`,
      cls: `${kindCls(x)} st-${st} ${mine ? 'mine' : ''}`,
    };
  };

  function renderRoomMonth(r, list) {
    const today = bkkToday(), away = rm.extra?.away || [];
    const head = WD.map((w, i) => `<div class="wd" style="${i >= 5 ? 'color:var(--brick)' : ''}">${w}</div>`).join('');
    const byDay = new Map();
    for (const x of list) byDay.set(x.date, [...(byDay.get(x.date) || []), x]);
    const MAX = 3;
    const cells = r.days.map((d) => {
      const xs = (byDay.get(d) || []).sort((a, b) => a.start.localeCompare(b.start));
      // รายการวิชาเดียวกันในวันเดียวกันเกิน 2 รายการ → ย่อเป็นก้อนเดียว เช่น "CHM101L · 24 คาบ"
      const groups = new Map();
      for (const x of xs) { const k = resvLabel(x).split(' ก.')[0]; groups.set(k, [...(groups.get(k) || []), x]); }
      const chips = [];
      for (const [k, g] of groups) {
        if (g.length > 2) {
          const st = g.some((x) => resvState(x) === 'move') ? 'move' : g.some((x) => resvState(x) === 'pend') ? 'pend' : 'ok';
          chips.push(`<button class="rchip ${kindCls(g[0])} st-${st}" data-dl="${d}" title="กดเพื่อดูทั้งหมด"><b>${ST_META[st][0]} ${esc(k)}</b><span>${g.length} รายการ · กดดูทั้งหมด</span></button>`);
        } else for (const x of g) {
          const st = resvState(x);
          chips.push(`<button class="rchip ${kindCls(x)} st-${st} ${x.requested_by === INIT.me.user_id ? 'mine' : ''}" data-r="${esc(x.reservation_id)}" title="${esc(`${resvLabel(x)} · ${x.start}–${x.end} · ${x.room} · ${ST_META[st][1]}`)}"><b>${ST_META[st][0]} ${esc(x.course_code || resvLabel(x))}</b><span>${x.start}–${x.end} · ${esc(shortRoom(x.room))}</span></button>`);
        }
      }
      const aw = away.filter((a) => a.from_date <= d && a.to_date >= d);
      return `<div class="mcell rcell ${d.slice(0, 7) !== r.ym ? 'out' : ''} ${d === today ? 'today' : ''}" data-d="${d}">
        <button class="dn" data-day="${d}" title="ดูรายวัน">${Number(d.slice(8))}</button>
        ${aw.map((a) => `<span class="ad t-away" title="${esc(a.note || '')}">🙈 ${esc(a.users?.full_name || 'ไม่อยู่')}</span>`).join('')}
        ${chips.slice(0, MAX).join('')}${chips.length > MAX ? `<button class="mmore" data-dl="${d}">+ อีก ${chips.length - MAX} รายการ</button>` : ''}</div>`;
    }).join('');
    $('rbWrap').innerHTML = `<div class="mg rmg">${head}${cells}</div>${list.length ? '' : '<div class="empty" style="margin-top:10px">ไม่มีการจองตามตัวกรองนี้ในเดือนนี้</div>'}`;
    $('rbWrap').querySelectorAll('[data-r]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); openResv(b.dataset.r); }));
    $('rbWrap').querySelectorAll('[data-dl]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); dayList(b.dataset.dl, byDay.get(b.dataset.dl) || []); }));
    $('rbWrap').querySelectorAll('[data-day]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); go(roomHash('day', b.dataset.day)); }));
    $('rbWrap').querySelectorAll('.rcell[data-d]').forEach((c) => (c.onclick = (e) => { if (e.target === c) bookingForm({ date: c.dataset.d, location_id: rm.loc || undefined }); }));
  }

  function dayList(d, xs) {
    const md = modal(`การจองห้อง · ${fmtLong(d)}`, `<div class="dlist">${xs.sort((a, b) => a.start.localeCompare(b.start)).map((x) => {
      const st = resvState(x);
      return `<button class="li st-li st-${st}" data-r="${esc(x.reservation_id)}"><span class="mono">${x.start}–${x.end}</span>
        <div><div class="t">${ST_META[st][0]} ${esc(resvLabel(x))}</div><div class="m">${esc(x.room || '')} · ${ST_META[st][1]}${x.requester?.full_name ? ` · ${esc(x.requester.full_name)}` : ''}</div></div><span></span></button>`;
    }).join('')}</div>
      <div class="row" style="margin-top:10px"><button class="btn btn-ghost btn-sm" data-go>เปิดรายวัน</button><span class="spacer"></span><button class="btn btn-primary btn-sm" data-new>+ จองวันนี้</button></div>`, { wide: true });
    md.qa('[data-r]').forEach((b) => (b.onclick = () => { md.close(); openResv(b.dataset.r); }));
    md.q('[data-go]').onclick = () => { md.close(); go(roomHash('day', d)); };
    md.q('[data-new]').onclick = () => { md.close(); bookingForm({ date: d, location_id: rm.loc || undefined }); };
  }

  // สัปดาห์: เลือกห้องแล้วดูทั้งสัปดาห์ (แถว = วัน)
  function renderRoomWeek(r, list, roomRow) {
    const today = bkkToday();
    if (!roomRow) { $('rbWrap').innerHTML = '<div class="empty">เลือกห้องเพื่อดูรายสัปดาห์</div>'; return; }
    const away = rm.extra?.away || [];
    const rows = r.days.map((d) => ({
      key: d, today: d === today, label: `${WD[dow(d)]} ${Number(d.slice(8))}`, sub: d === today ? 'วันนี้' : '',
      extra: away.filter((a) => a.from_date <= d && a.to_date >= d).map((a) => `<span class="ad t-away">🙈 ${esc(a.users?.full_name || 'ไม่อยู่')}</span>`).join(''),
      items: list.filter((x) => covers(x, d)).map((x) => barOf(x, d)),
    }));
    hgrid($('rbWrap'), {
      rows, nowRow: today, onItem: openResv, onLabel: (d) => go(roomHash('day', d)), rerender: renderBoard,
      onEmpty: (d, m) => bookingForm({ location_id: roomRow.location_id, date: d, start: fromMin(m), end: fromMin(Math.min(23 * 60 + 30, m + 120)) }),
      empty: list.length ? '' : `<div class="empty" style="margin-top:10px">${esc(roomRow.name)} ว่างทั้งสัปดาห์ — กดช่องว่างเพื่อจอง</div>`,
    });
    $('rbWrap').insertAdjacentHTML('afterbegin', `<div class="muted" style="margin:0 0 6px">ห้อง <b>${esc(roomRow.name)}</b> · <a href="#" id="rbInfo">ข้อมูลห้อง</a></div>`);
    $('rbInfo').onclick = (e) => { e.preventDefault(); roomInfo(roomRow); };
  }

  // วัน: ห้องอยู่ด้านซ้าย (แสดงแค่ชื่อ กดดูรายละเอียด) เวลาอยู่ด้านบน
  function renderRoomDay(list, rooms) {
    const d = rm.date, today = bkkToday();
    const zi = (z) => (INIT.zones.findIndex((x) => x.name === z) + 1) || 99;
    const sorted = [...rooms].sort((a, b) => zi(a.zone) - zi(b.zone) || a.name.localeCompare(b.name));
    const rows = sorted.map((x) => ({
      key: x.location_id, label: esc(x.name), cls: x.room_status === 'closed' ? 'closed' : '',
      sub: x.room_status === 'closed' ? 'ปิดใช้งาน' : '',
      items: list.filter((y) => y.location_id === x.location_id && covers(y, d)).map((y) => barOf(y, d)),
    }));
    hgrid($('rbWrap'), {
      rows, nowRow: d === today ? '*' : null, onItem: openResv, rerender: renderBoard,
      onLabel: (id) => roomInfo(rm.data.roomsById.get(id)),
      onEmpty: (loc, m) => bookingForm({ location_id: loc, date: d, start: fromMin(m), end: fromMin(Math.min(23 * 60 + 30, m + 120)) }),
      empty: rooms.length ? '' : '<div class="empty">ไม่มีห้องตามตัวกรองนี้</div>',
    });
    if (d === today) $('rbWrap').querySelectorAll('.hg-track').forEach((t) => {
      const w = twNow(); if (nowMin() <= w.from * 60 || nowMin() >= w.to * 60) return;
      t.insertAdjacentHTML('beforeend', `<div class="hg-now" style="left:${((nowMin() - w.from * 60) / ((w.to - w.from) * 60)) * 100}%"></div>`);
    });
  }

  function roomInfo(x) {
    if (!x) return;
    const cs = x.contacts || [];
    const md = modal(x.name, `<dl class="dl">
        ${x.room_code ? `<dt>เลขห้อง</dt><dd>${esc(x.room_code)}</dd>` : ''}
        <dt>อาคาร/ชั้น</dt><dd>${esc([x.building && `อาคาร ${x.building}`, x.floor && `ชั้น ${x.floor}`].filter(Boolean).join(' · ') || '—')}${x.zone ? ` <span class="muted">· ${esc(x.zone)}</span>` : ''}</dd>
        <dt>สถานะ</dt><dd>${x.room_status === 'closed' ? '<span class="tag red">ปิดใช้งาน</span>' : '<span class="tag teal">เปิดใช้งาน</span>'}</dd>
        <dt>เวลาเตรียม/เก็บ</dt><dd>${x.setup_minutes || 0} / ${x.teardown_minutes || 0} นาที</dd>
        ${cs.map((c) => `<dt>${c.kind === 'room_manager' ? 'ผู้ดูแลหลัก' : 'ผู้ดูแลสำรอง'}</dt><dd>${esc(c.full_name || '')}<div class="muted">${[c.phone && `☎ <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>`, c.email && `✉ ${esc(c.email)}`, c.line_id && `LINE ${esc(c.line_id)}`].filter(Boolean).join(' · ')}</div></dd>`).join('') || '<dt>ผู้ดูแล</dt><dd class="muted">ยังไม่กำหนด</dd>'}
        <dt>สิทธิ์ของฉัน</dt><dd>${x.can_approve ? '✓ อนุมัติการจองห้องนี้ได้' : 'ขอจองได้ (ผู้ดูแลห้องเป็นผู้อนุมัติ)'}</dd>
        ${x.note ? `<dt>หมายเหตุ</dt><dd>${esc(x.note)}</dd>` : ''}</dl>
      <div class="row"><button class="btn btn-ghost btn-sm" data-wk>ดูห้องนี้ทั้งสัปดาห์</button><span class="spacer"></span><button class="btn btn-primary btn-sm" data-new>+ จองห้องนี้</button></div>`);
    md.q('[data-wk]').onclick = () => { md.close(); rm.wk = x.location_id; go(roomHash('week', rm.date)); };
    md.q('[data-new]').onclick = () => { md.close(); bookingForm({ location_id: x.location_id, date: rm.date }); };
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

  // ---------- ฟอร์มขอจอง: เลือกห้อง + วัน → เห็นช่วงว่างทันที (ข้อตกลง 13 ต.ค. 2569) ----------
  // แถบการจองเดิม (มีตัวเลขเวลา) + แถบ "คุณเลือก" แกนเวลาเดียวกัน · กดการ์ดช่วงว่างเพื่อเติมเวลา (คงระยะเวลาที่ขอ)
  // จองหลายวัน: แสดงสูงสุด 6 วันแรก วันละแถว · การ์ดช่วงว่าง = ช่วงที่ว่างตรงกันทุกวันที่แสดง
  const OFFICE = [8 * 60 + 30, 16 * 60 + 30]; // เวลาราชการ (ได้สิทธิ์ก่อน)
  const BK_DAYS = 6, BK_LANE = 44;
  const durTh = (m) => { const h = Math.floor(m / 60), r = m % 60; return h ? `${h} ชม.${r ? ` ${r} นาที` : ''}` : `${r} นาที`; };
  const clampMin = (m) => fromMin(Math.max(0, Math.min(1440, m)));
  async function bookingForm(p = {}) {
    await W.init();
    const locId = p.location_id || INIT.rooms.find((r) => r.room_status !== 'closed')?.location_id || '';
    const kinds = OPEN_KINDS.map((k) => [k, INIT.booking_kinds[k]]);
    const dw = p.date ? dow(p.date) + 1 : dow(bkkToday()) + 1;
    const myCourses = INIT.courses;
    const md = modal('ขอจองห้อง', `
      <div class="muted" style="margin:-4px 0 10px">เลือกห้องและวัน แล้วเลือกช่วงที่ว่างได้เลย</div>
      <div class="fgrid">
        <div><label>ห้อง *</label><select data-k="loc">${roomOptions(locId, { all: false })}</select></div>
        <div data-pp="once"><label>วันที่ต้องการจอง *</label><input type="date" data-k="date" value="${esc(p.date || bkkToday())}"></div>
        <div data-pp="weekly range dates" hidden><label>วันที่</label><div class="hint" style="margin-top:10px">กำหนดวันที่ช่อง "รูปแบบ" ด้านล่าง</div></div>
      </div>
      <div class="bk-av" data-av></div>
      <div data-freeout class="hint"></div>
      <h4 class="bk-h">เวลาที่ต้องการใช้</h4>
      <div class="fgrid">
        <div><label>เวลาเริ่ม *</label><input type="time" data-k="st" value="${esc(p.start || '09:00')}" step="300"></div>
        <div><label>เวลาเลิก *</label><input type="time" data-k="en" value="${esc(p.end || '12:00')}" step="300"></div>
        <div><label>เตรียมก่อน (นาที)</label><input type="number" data-k="setup" min="0" max="600" step="5" inputmode="numeric"></div>
        <div><label>เก็บหลัง (นาที)</label><input type="number" data-k="tear" min="0" max="600" step="5" inputmode="numeric"></div>
      </div>
      <div data-sum></div>
      <div class="fgrid" style="margin-top:14px">
        <div class="full"><label>รูปแบบ</label><div class="segc" data-pat><button data-p="once" class="on">ครั้งเดียว</button><button data-p="weekly">ทุกสัปดาห์</button><button data-p="range">ทุกวันในช่วง</button><button data-p="dates">เลือกหลายวัน</button></div></div>
        <div data-pp="weekly" hidden class="full"><label>วันในสัปดาห์</label><div class="wdays">${WD.map((w, i) => `<button type="button" data-wd="${i + 1}" class="${i + 1 === dw ? 'on' : ''}">${w}</button>`).join('')}</div></div>
        <div data-pp="weekly range" hidden><label>ตั้งแต่ *</label><input type="date" data-k="from" value="${esc(p.date || bkkToday())}"></div>
        <div data-pp="weekly range" hidden><label>ถึง *</label><input type="date" data-k="until" value="${addDays(p.date || bkkToday(), 28)}"></div>
        <div data-pp="range" hidden class="full"><label class="inl"><input type="checkbox" data-k="skipwe" checked> ข้ามเสาร์-อาทิตย์</label></div>
        <div data-pp="dates" hidden class="full"><label>วันที่ (เพิ่มได้หลายวัน)</label><div class="row" style="gap:6px"><input type="date" data-k="adddate" style="width:auto"><button type="button" class="btn btn-ghost btn-sm" data-adddate>+ เพิ่มวัน</button></div><div data-datelist class="row" style="gap:4px;margin-top:6px"></div></div>
      </div>
      <details class="bk-more"${p.kind ? ' open' : ''}><summary>รายละเอียดการจอง</summary>
        <div class="fgrid" style="margin-top:10px">
          <div><label>ประเภทการใช้ *</label><select data-k="kind">${kinds.map(([k, t]) => opt(k, t, p.kind || 'prep')).join('')}</select></div>
          <div><label>ชื่อเรื่อง</label><input data-k="title" maxlength="200" placeholder="เช่น เตรียมสารแล็บ 3"></div>
          <div><label>รายวิชา (ใช้คิดต้นทุน)</label><select data-k="course">${opt('', '— ไม่ใช่งานของวิชา —', '')}${myCourses.map((c) => opt(`${c.course_id}|${c.semester_id}`, `${c.course_code} · ${c.course_name}`, '')).join('')}</select></div>
          <div><label>หรือ ชื่อโครงการ/บริการ</label><input data-k="project" maxlength="200" placeholder="เช่น โครงการวิจัย ก."></div>
          <div class="full"><label>วัตถุประสงค์</label><input data-k="purpose" maxlength="1000"></div>
          <div class="full"><label>ผู้ใช้ห้องจริง (ถ้าไม่ใช่ฉัน)</label><input data-k="actual" maxlength="200" placeholder="เช่น นศ.ปริญญาโท 3 คน"></div>
        </div>
      </details>
      <div class="row bk-foot"><span class="muted">ช่วงว่างคิดรวมเวลาเตรียม/เก็บของรายการเดิมแล้ว</span><span class="spacer"></span><button class="btn btn-primary" data-preview>ตรวจและดูสรุปคำขอ</button></div>
      <div data-out></div>`, { wide: true });
    const v = (k) => md.q(`[data-k="${k}"]`);
    let pat = 'once', dates = [], preview = null, seq = 0, win = null;
    const board = { resv: [], have: new Set() }; // ข้อมูลการจองทุกห้อง แยกตามวันที่โหลดแล้ว
    const resetOut = () => { preview = null; md.q('[data-out]').innerHTML = ''; };
    const syncRoom = () => {
      const r = room(v('loc').value);
      v('setup').placeholder = `ค่าห้อง ${r?.setup_minutes ?? 0}`; v('tear').placeholder = `ค่าห้อง ${r?.teardown_minutes ?? 0}`;
      md.q('[data-freeout]').innerHTML = '';
      resetOut();
    };
    const changed = () => { resetOut(); render(); };
    v('loc').onchange = () => { syncRoom(); render(); }; syncRoom();
    md.qa('[data-pat] button').forEach((b) => (b.onclick = () => {
      pat = b.dataset.p; md.qa('[data-pat] button').forEach((x) => x.classList.toggle('on', x === b));
      md.qa('[data-pp]').forEach((el) => (el.hidden = !el.dataset.pp.split(' ').includes(pat)));
      changed();
    }));
    md.qa('[data-wd]').forEach((b) => (b.onclick = () => { b.classList.toggle('on'); changed(); }));
    ['date', 'from', 'until', 'skipwe'].forEach((k) => v(k).addEventListener('change', changed));
    ['st', 'en', 'setup', 'tear'].forEach((k) => { v(k).addEventListener('input', changed); v(k).addEventListener('change', changed); });
    const drawDates = () => {
      md.q('[data-datelist]').innerHTML = dates.map((d, i) => `<span class="tag teal">${fmtD(d)} <a href="#" data-rm="${i}">✕</a></span>`).join('') || '<span class="muted">ยังไม่ได้เลือกวัน</span>';
      md.qa('[data-rm]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); dates.splice(Number(a.dataset.rm), 1); drawDates(); changed(); }));
    };
    md.q('[data-adddate]').onclick = () => { const d = v('adddate').value; if (d && !dates.includes(d)) { dates.push(d); dates.sort(); drawDates(); changed(); } };
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

    // วันที่ของคำขอ (แสดงสูงสุด 6 วันแรก + นับทั้งหมด)
    function patDates() {
      const list = []; let total = 0;
      const push = (d) => { total++; if (list.length < BK_DAYS) list.push(d); };
      if (pat === 'once') { if (ISO_DATE.test(v('date').value)) push(v('date').value); }
      else if (pat === 'dates') dates.forEach(push);
      else {
        const a = v('from').value, b = v('until').value;
        const wds = md.qa('[data-wd].on').map((x) => Number(x.dataset.wd));
        if (ISO_DATE.test(a) && ISO_DATE.test(b) && b >= a) {
          for (let d = a, i = 0; d <= b && i < 400; d = addDays(d, 1), i++) {
            const k = dow(d) + 1;
            if (pat === 'weekly' ? wds.includes(k) : !(v('skipwe').checked && k >= 6)) push(d);
          }
        }
      }
      return { list, total };
    }
    // โหลดตารางห้องเฉพาะวันที่ยังไม่มี (ครั้งละไม่เกิน 14 วัน)
    async function ensure(ds) {
      const need = ds.filter((d) => !board.have.has(d)).sort();
      while (need.length) {
        const a = need[0], last = need.filter((d) => d <= addDays(a, 13)).pop();
        const span = Math.round((Date.parse(last) - Date.parse(a)) / 864e5) + 1;
        const r = await bApi('rooms_board', { date: a, days: span });
        const ids = new Set(board.resv.map((x) => x.reservation_id));
        (r.reservations || []).forEach((x) => { if (!ids.has(x.reservation_id)) board.resv.push(x); });
        for (let i = 0; i < span; i++) board.have.add(addDays(a, i));
        need.splice(0, need.filter((d) => d <= last).length);
      }
    }
    function dayItems(d, loc) {
      const t0 = Date.parse(`${d}T00:00:00+07:00`);
      return board.resv.filter((x) => x.location_id === loc && Date.parse(x.starts_at) < t0 + 864e5 && Date.parse(x.ends_at) > t0)
        .map((x) => ({ x, s: Math.max(0, (Date.parse(x.starts_at) - t0) / 6e4), e: Math.min(1440, (Date.parse(x.ends_at) - t0) / 6e4), p0: x.setup_minutes || 0, p1: x.teardown_minutes || 0, st: x.status === 'pending' ? 'pend' : 'ok' }))
        .sort((a, b) => a.s - b.s);
    }
    function mine() {
      const r = room(v('loc').value);
      const n = (k, def) => { const x = v(k).value; return x === '' ? (Number(def) || 0) : Math.max(0, Number(x) || 0); };
      const S = toMin(v('st').value), E = toMin(v('en').value);
      return { S, E, dur: E - S, su: n('setup', r?.setup_minutes), td: n('tear', r?.teardown_minutes), ok: !!v('st').value && !!v('en').value && E > S };
    }
    // ช่วงว่าง = ช่วงที่แสดง − (การจองเดิม + เวลาเตรียม/เก็บ)
    function gaps(items, w0, w1) {
      const busyL = items.map((i) => [i.s - i.p0, i.e + i.p1]).sort((a, b) => a[0] - b[0]);
      const out = []; let cur = w0;
      for (const [a, z] of busyL) { if (a > cur) out.push([cur, Math.min(a, w1)]); cur = Math.max(cur, z); if (cur >= w1) break; }
      if (cur < w1) out.push([cur, w1]);
      return out.filter(([a, z]) => z - a >= 15);
    }

    async function render() {
      const my = ++seq;
      const box = md.q('[data-av]');
      const { list: ds, total } = patDates();
      const loc = v('loc').value;
      if (!loc || !ds.length) { box.innerHTML = `<div class="muted">${!loc ? 'เลือกห้องก่อน' : 'เลือกวันที่ก่อน'} แล้วช่วงว่างของห้องจะแสดงที่นี่</div>`; drawSum(null); return; }
      if (ds.some((d) => !board.have.has(d))) {
        box.classList.add('loading');
        if (!box.querySelector('.bk-axis')) box.innerHTML = '<div class="skel" style="height:150px"></div>';
        try { await ensure(ds); } catch (e) { if (my === seq) { box.classList.remove('loading'); box.innerHTML = `<div class="err">${esc(e.message)}</div>`; } return; }
        if (my !== seq) return;
        box.classList.remove('loading');
      }
      draw(box, ds, total);
    }

    function draw(box, ds, total) {
      const loc = v('loc').value, m = mine(), multi = pat !== 'once';
      const days = ds.map((d) => ({ d, items: dayItems(d, loc) }));
      const w = win || twNow();
      let w0 = w.from * 60, w1 = w.to * 60;
      const outside = days.reduce((n, D) => n + D.items.filter((i) => i.e + i.p1 <= w0 || i.s - i.p0 >= w1).length, 0);
      if (m.ok) { w0 = Math.max(0, Math.min(w0, Math.floor((m.S - m.su) / 60) * 60)); w1 = Math.min(1440, Math.max(w1, Math.ceil((m.E + m.td) / 60) * 60)); } // ให้เห็นช่วงที่เลือกเสมอ
      const span = w1 - w0, P = (x) => ((Math.min(Math.max(x, w0), w1) - w0) / span) * 100;
      const step = narrow() || span > 14 * 60 ? 2 : 1;
      const ticks = []; for (let h = w0 / 60; h <= w1 / 60; h += step) ticks.push(h);
      if (ticks[ticks.length - 1] !== w1 / 60) ticks.push(w1 / 60);
      const off = (OFFICE[0] > w0 ? `<i class="bk-off" style="left:0;width:${P(OFFICE[0])}%"></i>` : '') + (OFFICE[1] < w1 ? `<i class="bk-off" style="left:${P(OFFICE[1])}%;right:0"></i>` : '');
      const grid = ticks.slice(1, -1).map((h) => `<i class="bk-gl" style="left:${P(h * 60)}%"></i>`).join('');
      const rng = (s, e) => `${clampMin(s)}–${clampMin(e)}`;
      const bar = (s, e, p0, p1, cls, code, tip, lane) => {
        const top = lane * BK_LANE + 15;
        const pad = p0 || p1 ? `<i class="bk-pad ${cls}" style="left:${P(s - p0)}%;width:${P(e + p1) - P(s - p0)}%;top:${top}px"></i>` : '';
        return `${pad}<div class="bk-bar ${cls}" title="${esc(tip)}" style="left:${P(s)}%;width:${Math.max(P(e) - P(s), 0.6)}%;top:${top}px"><span class="lb"><b>${rng(s, e)}</b>${code ? `<em> ${esc(code)}</em>` : ''}</span></div>`;
      };
      const clashes = days.map((D) => (m.ok ? D.items.filter((i) => i.s - i.p0 < m.E + m.td && i.e + i.p1 > m.S - m.su) : []));
      const rows = days.map((D, k) => {
        const vis = D.items.filter((i) => i.e + i.p1 > w0 && i.s - i.p0 < w1);
        const lanes = [];
        vis.forEach((i) => { const a = i.s - i.p0, z = i.e + i.p1; let L = lanes.findIndex((end) => end <= a); if (L < 0) { L = lanes.length; lanes.push(z); } else lanes[L] = z; i.lane = L; });
        const who = (i) => i.x.requester?.full_name ? ` · ${i.x.requester.full_name}` : '';
        const bars = vis.map((i) => bar(i.s, i.e, i.p0, i.p1, `st-${i.st}`, resvLabel(i.x),
          `${ST_META[i.st][1]} · ${resvLabel(i.x)} · ${rng(i.s, i.e)}${i.p0 || i.p1 ? ` (เตรียม ${i.p0} / เก็บ ${i.p1} นาที)` : ''}${who(i)}`, i.lane)).join('');
        const hit = clashes[k].length;
        const mb = m.ok ? bar(m.S, m.E, m.su, m.td, hit ? 'mine bad' : 'mine', '', `คุณเลือก ${rng(m.S, m.E)}${m.su || m.td ? ` · กันห้อง ${rng(m.S - m.su, m.E + m.td)}` : ''}`, 0) : '';
        return `${multi ? `<div class="bk-day">${fmtD(D.d)}${hit ? ' <span class="tag red">ชน</span>' : ''}</div>` : ''}
          <div class="bk-lab">การจองเดิม${vis.length ? '' : ' · ว่างทั้งช่วง'}</div>
          <div class="bk-track" style="height:${Math.max(1, lanes.length) * BK_LANE}px">${off}${grid}${bars}</div>
          <div class="bk-lab">คุณเลือก${m.ok && (m.su || m.td) ? ' · ลายเส้น = เวลาเตรียม/เก็บ' : ''}</div>
          <div class="bk-track" style="height:${BK_LANE}px">${off}${grid}${mb}</div>`;
      }).join('');
      // การ์ดช่วงว่าง (หลายวัน = ว่างตรงกันทุกวันที่แสดง)
      const free = gaps(days.flatMap((D) => D.items), w0, w1);
      const need = m.ok ? m.su + m.dur + m.td : 0;
      const cards = free.length ? free.map(([a, z]) => {
        const fits = !m.ok || z - a >= need;
        const us = a + (m.ok ? m.su : 0), ue = m.ok ? us + m.dur : z;
        const outM = (x, y) => Math.max(0, Math.min(y, OFFICE[0]) - x) + Math.max(0, y - Math.max(x, OFFICE[1]));
        const offh = fits && m.ok ? us < OFFICE[0] || ue > OFFICE[1] : outM(a, z) * 2 > z - a; // ช่วงที่ไม่พอ: ติดป้ายเมื่อเกินครึ่งอยู่นอกเวลาราชการ
        const cur = m.ok && fits && m.S === us;
        const why = !m.ok ? '' : fits ? `ใช้ ${fromMin(us)}–${fromMin(ue)}` : z - a >= m.dur ? 'ไม่พอเมื่อรวมเวลาเตรียม/เก็บ' : 'ช่วงนี้ไม่พอกับเวลาที่ขอ';
        return `<button type="button" class="bk-slot ${fits ? '' : 'no'} ${cur ? 'on' : ''}" ${fits && m.ok ? `data-slot="${a}"` : 'disabled'}>
          <b>ว่าง ${clampMin(a)}–${clampMin(z)}</b><span>${durTh(z - a)}</span>${why ? `<span class="why">${why}</span>` : ''}${offh ? '<span class="tag amber">นอกเวลาราชการ</span>' : ''}</button>`;
      }).join('') : '<div class="muted">ไม่มีช่วงว่างในช่วงเวลาที่แสดง</div>';
      const all = days.flatMap((D) => D.items.map((i) => ({ ...i, d: D.d })));
      const list = all.map((i) => `<div class="bk-li">${multi ? `${fmtD(i.d)} · ` : ''}<b class="mono">${rng(i.s, i.e)}</b> ${statusTag(i.x.status)} ${esc(resvLabel(i.x))} · ${esc(i.x.kind_th || '')}${i.p0 || i.p1 ? ` <span class="muted">· กันห้อง ${rng(i.s - i.p0, i.e + i.p1)}</span>` : ''}${i.x.requester?.full_name ? ` <span class="muted">· ${esc(i.x.requester.full_name)}</span>` : ''}</div>`).join('');
      box.innerHTML = `<div class="bk-head"><div><b>ช่วงว่างของห้อง</b><div class="muted">${multi ? `แสดง ${ds.length} วันแรก${total > ds.length ? ` จากทั้งหมด ${total} วัน` : ''}` : fmtLong(ds[0])}</div></div>
          <span class="spacer"></span><button type="button" class="btn btn-ghost btn-sm" data-tw title="ปรับช่วงเวลาที่แสดง">🕗 ${fromMin(w0)}–${fromMin(w1)}</button></div>
        ${outside ? `<button type="button" class="hg-out" data-wide>⚠ มีการจองนอกช่วงที่แสดง ${outside} รายการ — กดเพื่อดูทั้งวัน</button>` : ''}${win ? '<button type="button" class="hg-out back" data-narrow>กำลังดูทั้งวัน — กลับช่วงปกติ</button>' : ''}
        <div class="bk-axis">${ticks.map((h) => `<span style="left:${P(h * 60)}%">${String(h).padStart(2, '0')}</span>`).join('')}</div>
        ${rows}
        <div class="bk-legend"><span><i class="st-ok"></i>อนุมัติแล้ว</span><span><i class="st-pend"></i>รออนุมัติ</span><span><i class="hat"></i>เตรียม/เก็บ</span><span><i class="mine"></i>คุณเลือก</span><span><i class="bad"></i>ชน</span><span><i class="off"></i>นอกเวลาราชการ (ก่อน 08:30 / หลัง 16:30)</span></div>
        <div class="bk-slots-h">${multi ? 'ช่วงที่ว่างตรงกันทุกวันที่แสดง' : 'ช่วงว่าง'}${m.ok ? ' · กดเพื่อใช้ช่วงนั้น (คงระยะเวลาที่ขอ)' : ''}</div>
        <div class="bk-slots">${cards}</div>
        <div class="bk-links">${all.length ? `<details class="bk-list"><summary>ดูรายการที่กันห้อง (${all.length})</summary>${list}</details>` : ''}<a href="#" data-others>ดูห้องอื่นที่ว่างช่วงเวลานี้</a></div>`;
      // ป้ายตัวเลขบนแถบ: ไม่พอที่ → ตัดรหัสวิชาออก → ยังไม่พอ ย้ายไปเหนือแถบ
      box.querySelectorAll('.bk-bar').forEach((b) => {
        const lb = b.querySelector('.lb'), room0 = b.clientWidth - 14;
        if (lb.scrollWidth > room0) lb.querySelector('em')?.remove();
        if (lb.scrollWidth > room0) { b.classList.add('lbl-out'); if (b.offsetLeft + lb.scrollWidth > b.parentElement.clientWidth) b.classList.add('lbl-r'); }
      });
      // ป้ายเหนือแถบที่ทับกัน → ย้ายป้ายถัดไปไว้ใต้แถบ (ขยายความสูงแถวให้)
      box.querySelectorAll('.bk-track').forEach((t) => {
        const used = { up: [], down: [] };
        const hit = (arr, r) => arr.some((q) => q.top === r.top && r.left < q.right + 6 && r.right > q.left - 6);
        let grow = 0;
        [...t.querySelectorAll('.bk-bar.lbl-out')].sort((x, y) => x.offsetLeft - y.offsetLeft).forEach((b) => {
          const r = b.querySelector('.lb').getBoundingClientRect(), key = { top: b.offsetTop, left: r.left, right: r.right };
          if (!hit(used.up, key)) return used.up.push(key);
          b.classList.add('lbl-dn'); used.down.push(key);
          grow = Math.max(grow, b.offsetTop + b.offsetHeight + 16 - t.clientHeight);
        });
        if (grow > 0) t.style.height = `${t.clientHeight + grow}px`;
      });
      box.querySelectorAll('[data-slot]').forEach((c) => (c.onclick = () => {
        const s = Number(c.dataset.slot) + m.su;
        v('st').value = fromMin(s); v('en').value = fromMin(s + m.dur); changed();
      }));
      box.querySelector('[data-tw]').onclick = () => twDialog(() => { win = null; render(); });
      box.querySelector('[data-wide]')?.addEventListener('click', () => { win = { from: 0, to: 24 }; render(); });
      box.querySelector('[data-narrow]')?.addEventListener('click', () => { win = null; render(); });
      box.querySelector('[data-others]').onclick = (e) => {
        e.preventDefault();
        if (!m.ok) return md.err('ใส่เวลาเริ่ม/เลิกก่อน');
        showFree(md, ds[0], v('st').value, v('en').value, '[data-k="loc"]', '[data-freeout]', () => { syncRoom(); render(); });
      };
      drawSum({ m, days, clashes, multi });
    }

    function drawSum(c) {
      const out = md.q('[data-sum]');
      if (!c) { out.innerHTML = ''; return; }
      const { m, days, clashes, multi } = c;
      if (!m.ok) { out.innerHTML = '<div class="bk-clash">เวลาเลิกต้องหลังเวลาเริ่ม</div>'; return; }
      const offh = m.S < OFFICE[0] || m.E > OFFICE[1];
      const hitDays = clashes.filter((x) => x.length).length;
      const seen = new Set(), hits = clashes.flat().filter((i) => !seen.has(i.x.reservation_id) && seen.add(i.x.reservation_id));
      out.innerHTML = `<div class="bk-sum">เวลาใช้ <b>${fromMin(m.S)}–${fromMin(m.E)}</b> · ${durTh(m.dur)}${offh ? ' <span class="tag amber">นอกเวลาราชการ</span>' : ''}<br>
          กันห้องทั้งหมด <b>${clampMin(m.S - m.su)}–${clampMin(m.E + m.td)}</b> · รวมเตรียม ${m.su} / เก็บ ${m.td} นาที</div>
        ${hits.length ? `<div class="bk-clash">ช่วงที่เลือกชน${multi ? ` ${hitDays} จาก ${days.length} วันที่แสดง` : ''} · ${hits.slice(0, 3).map((i) => `${esc(i.x.kind_th || '')} ${esc(resvLabel(i.x))} (${clampMin(i.s)}–${clampMin(i.e)}${i.x.status === 'pending' ? ' รออนุมัติ' : ''})`).join(' · ')}${hits.length > 3 ? ` และอีก ${hits.length - 3} รายการ` : ''} · เลือกช่วงว่างด้านบนได้</div>`
          : `<div class="bk-okline">✓ ไม่ชนกับการจองเดิม${multi ? ' ในวันที่แสดง' : ''}</div>`}`;
    }
    render();

    md.q('[data-preview]').onclick = (e) => busy(e.currentTarget, async () => {
      md.err('');
      if (!mine().ok) return md.err('เวลาเลิกต้องหลังเวลาเริ่ม');
      try { preview = await bApi('request_preview', base()); drawPreview(); md.q('[data-out]').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
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

  // ---------- ประวัติ (ปฏิเสธ/ยกเลิก — ไม่แสดงบนปฏิทินเพราะไม่ได้กันห้องแล้ว) ----------
  async function loadHistory() {
    $('rmBody').innerHTML = `<div class="wbar"><h2 style="min-width:0">ประวัติคำขอของฉัน</h2><span class="muted">ปฏิเสธ / ยกเลิก · ตั้งแต่ 7 วันก่อน</span></div><div id="hsList"><div class="skel" style="height:160px"></div></div>`;
    try {
      const d = await bApi('mine');
      const list = d.reservations.filter((x) => ['rejected', 'cancelled'].includes(x.status)).sort((a, b) => b.starts_at.localeCompare(a.starts_at));
      $('hsList').innerHTML = list.length ? list.map((x) => `<div class="li st-li st-${x.status === 'rejected' ? 'rej' : 'cxl'}"><span class="mono">${fmtD(x.date)} ${x.start}–${x.end}</span>
        <div><div class="t">${x.status === 'rejected' ? '✕' : '⊘'} ${esc(resvLabel(x))} · ${esc(x.room || '')}</div><div class="m">${statusTag(x.status)}${x.decider ? ` โดย ${esc(x.decider)}` : ''}${x.decision_note ? ` · ${esc(x.decision_note)}` : ''}</div></div>
        <div class="acts"><button class="btn btn-ghost btn-sm" data-open="${esc(x.reservation_id)}">รายละเอียด</button></div></div>`).join('') : '<div class="empty">ไม่มีคำขอที่ถูกปฏิเสธหรือยกเลิก</div>';
      $('hsList').querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => bookingDetail(list.find((x) => x.reservation_id === b.dataset.open), false)));
    } catch (e) { $('rmErr').textContent = e.message; }
  }

  // =====================================================================
  // ตารางงาน
  // =====================================================================
  // เมนู "งานของฉัน" เดิมรวมเข้าปฏิทินแล้ว (14 ต.ค. 2569) — แถบงานที่ต้องทำ + ติ๊กเสร็จในมุมมองรายการ
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
  // only: 'rooms' = คำขอใช้ห้อง (อยู่ใน จองห้องแลป › คำขอและสถานะ) · 'leave' = คำขอลาของนักศึกษา (อยู่ใน ตรวจการเช็กชื่อ)
  const ib = { only: 'leave' };
  W.openInbox = async (only = 'leave') => {
    show('viewInbox');
    ib.only = only;
    if (!$('viewInbox').dataset.built) {
      $('viewInbox').dataset.built = '1';
      $('viewInbox').innerHTML = `<div class="wbar"><h2 style="min-width:0" id="ibTitle"></h2><span class="spacer"></span><button class="btn btn-ghost btn-sm" id="ibRefresh">รีเฟรช</button></div><div id="ibBody"><div class="skel" style="height:260px"></div></div><div class="err" id="ibErr"></div>`;
      $('ibRefresh').onclick = () => { loadInbox({ only: ib.only }); W.refreshBadges(); };
    }
    $('ibTitle').textContent = only === 'leave' ? 'คำขอลาของนักศึกษา' : 'รออนุมัติ / รอตอบ';
    try { await W.init(); } catch (e) { $('ibErr').textContent = e.message; return; }
    loadInbox({ only });
  };

  async function loadInbox(o = {}) {
    const B = $(o.body || 'ibBody'), E = $(o.err || 'ibErr'), only = o.only || null;
    if (!B) return;
    E.textContent = '';
    B.classList.add('loading');
    const today = bkkToday();
    const [q, mv, lv, tasks] = await Promise.all([
      bApi('queue').catch((e) => ({ error: e.message })),
      bApi('move_list').catch((e) => ({ error: e.message })),
      wApi('leave_queue', { status: 'pending' }).catch((e) => ({ error: e.message })),
      wApi('task_list', { scope: 'mine', to: today }).catch((e) => ({ error: e.message })),
    ]);
    B.classList.remove('loading');
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
    B.innerHTML =
      (only !== 'leave' ? (INIT.caps.room_manager ? sec('🏫 คำขอใช้ห้องที่ฉันอนุมัติได้', groups.length, qHtml, 'ไม่มีคำขอรออนุมัติ') : (only === 'rooms' ? '<div class="empty">คุณไม่ได้เป็นผู้ดูแลห้อง จึงไม่มีคำขอที่ต้องอนุมัติ — ดูคำขอของคุณเองที่ "คำขอของฉัน"</div>' : '')) : '') +
      (only !== 'leave' ? sec('🙏 ผู้ดูแลห้องขอให้ย้ายการจองของฉัน', moves.length, mvHtml, 'ไม่มี') : '') +
      (only !== 'rooms' ? (INIT.caps.instructor ? sec('📝 คำขอลาของนักศึกษา (กลุ่มที่ฉันสอน)', leaves.length, lvHtml, 'ไม่มีคำขอลารออนุมัติ') : (only === 'leave' ? '<div class="empty">คำขอลาจะแสดงเฉพาะอาจารย์ผู้สอนของกลุ่มนั้น</div>' : '')) : '') +
      (!only ? sec('✅ งานของฉันวันนี้/ค้าง', myTasks.length, tkHtml, 'ไม่มีงานค้าง 🎉') : '') +
      [q, mv, lv, tasks].filter((x) => x.error).map((x) => `<div class="err">${esc(x.error)}</div>`).join('');
    const decide = (gi, approve) => async (b) => {
      const g = groups[gi];
      let note = null;
      if (!approve) { note = await ask('ไม่อนุมัติคำขอใช้ห้อง', { required: true, okText: 'ไม่อนุมัติ', danger: true }); if (note === null) return; }
      try {
        const r = await bApi('decide', { reservation_ids: g.items.map((x) => x.reservation_id), approve, note });
        toast(approve ? `อนุมัติ ${r.counts.ok} รายการ${r.counts.failed ? ` · ไม่สำเร็จ ${r.counts.failed} (ห้องชน)` : ''}` : 'แจ้งผู้ขอแล้ว');
        afterChange();
      } catch (e) { E.textContent = e.message; }
    };
    B.querySelectorAll('[data-ap]').forEach((b) => (b.onclick = () => busy(b, () => decide(Number(b.dataset.ap), true)(b))));
    B.querySelectorAll('[data-rj]').forEach((b) => (b.onclick = () => busy(b, () => decide(Number(b.dataset.rj), false)(b))));
    B.querySelectorAll('[data-goto-moves]').forEach((b) => (b.onclick = () => go('#rooms/status/moves')));
    const leaveDecide = (i, approve) => async () => {
      const r = leaves[i];
      let note = '';
      if (!approve) { note = await ask(`ไม่อนุมัติการลา · ${r.student_code}`, { required: true, okText: 'ไม่อนุมัติ', danger: true }); if (note === null) return; }
      try { await wApi('leave_decide', { request_id: r.request_id, approve, note }); toast(approve ? 'อนุมัติแล้ว · บันทึกเป็น "ลา" ในใบเช็คชื่อ' : 'ไม่อนุมัติแล้ว'); afterChange(); }
      catch (e) { E.textContent = e.message; }
    };
    B.querySelectorAll('[data-la]').forEach((b) => (b.onclick = () => busy(b, leaveDecide(Number(b.dataset.la), true))));
    B.querySelectorAll('[data-lr]').forEach((b) => (b.onclick = () => busy(b, leaveDecide(Number(b.dataset.lr), false))));
    B.querySelectorAll('[data-td]').forEach((b) => (b.onclick = () => busy(b, async () => {
      try { await wApi('task_status', { task_id: b.dataset.td, status: 'done' }); toast('เสร็จแล้ว ✓'); afterChange(); } catch (e) { E.textContent = e.message; }
    })));
  }
})();
