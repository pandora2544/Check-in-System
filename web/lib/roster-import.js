/*
 * roster-import — เดาคอลัมน์ของไฟล์รายชื่อ (ไทย/อังกฤษ) แล้วแปลงเป็นแถว { code, full_name, group }
 * รองรับหัวตารางที่ไม่ได้อยู่แถวแรก (มีหัวกระดาษ/ชื่อวิชาอยู่ด้านบน), ชื่อแยกช่อง/รวมช่อง, คำนำหน้าแยกช่อง,
 * รหัสเป็นตัวเลขหรือมีขีด, ไฟล์ที่รวมหลายกลุ่มเรียนในชีตเดียว (มีคอลัมน์กลุ่มเรียน)
 */
(function (global) {
  'use strict';

  const ROLES = {
    ignore: 'ไม่ใช้', code: 'รหัสนักศึกษา', prefix: 'คำนำหน้า', first: 'ชื่อ', last: 'นามสกุล',
    full: 'ชื่อ-นามสกุล (รวม)', group: 'กลุ่มทำงาน', section: 'กลุ่มเรียน/Section',
  };
  const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();
  const CODE_RE = /^\d{6,12}$/;
  const cleanCode = (s) => String(s ?? '').replace(/[\s-]/g, '').replace(/\.0+$/, '');

  // เรียงตามความเฉพาะเจาะจง — ตัวแรกที่ตรงชนะ
  const HEADER_RULES = [
    ['ignore', /^(ลำดับ|ลำดับที่|ที่|no\.?|#|seq)$/],
    ['section', /กลุ่มเรียน|^sec(tion)?\.?$|ตอนเรียน|^กลุ่มที่เรียน$/],
    ['ignore', /รหัสวิชา|วิชา|course|สาขา|major|คณะ|faculty|ชั้นปี|year|หมายเหตุ|remark|ลายมือ|ลงชื่อ|sign|email|อีเมล|โทร|phone/],
    ['code', /รหัส|studentid|student_id|studentcode|^id$|^code$|เลขประจำตัว/],
    ['prefix', /คำนำหน้า|คำนำ|^title$|prefix/],
    ['full', /ชื่อ[-–]?(นาม)?สกุล|ชื่อและนามสกุล|ชื่อ[-–]?นามสกุล|fullname|^name$|ชื่อนักศึกษา|ชื่อ-สกุล/],
    ['last', /นามสกุล|^สกุล$|lastname|surname|familyname/],
    ['first', /^ชื่อ$|ชื่อจริง|firstname|givenname|^ชื่อ\(ไทย\)$/],
    ['group', /กลุ่ม|group|team|โต๊ะ|ทีม/],
  ];
  const PREFIXES = ['นางสาว', 'นาย', 'นาง', 'น.ส.', 'ด.ช.', 'ด.ญ.', 'Mr.', 'Ms.', 'Mrs.', 'Miss'];

  function roleOf(header) {
    const h = norm(header);
    if (!h) return null;
    for (const [role, re] of HEADER_RULES) if (re.test(h)) return role;
    return null;
  }

  // หาหัวตาราง: แถวใน 25 แถวแรกที่มีคำหัวคอลัมน์ตรงมากที่สุด (ต้องมีคอลัมน์รหัส)
  function detect(rows) {
    let best = { row: -1, score: 0, roles: [] };
    for (let r = 0; r < Math.min(rows.length, 25); r++) {
      const roles = (rows[r] || []).map(roleOf);
      const score = roles.filter((x) => x && x !== 'ignore').length + (roles.includes('code') ? 2 : 0);
      if (roles.includes('code') && score > best.score) best = { row: r, score, roles };
    }
    const width = Math.max(0, ...rows.slice(0, 200).map((r) => (r || []).length));
    const data = (start) => rows.slice(start).filter((r) => r && r.some((c) => String(c).trim() !== ''));
    let headerRow = best.row, roles = best.roles.slice();
    if (headerRow < 0) {
      // ไม่มีหัวตาราง → เดาจากข้อมูล: คอลัมน์ที่เป็นเลข 6–12 หลักเกินครึ่ง = รหัส, คอลัมน์ข้อความถัดไป = ชื่อ
      roles = Array(width).fill('ignore');
      const sample = data(0).slice(0, 60);
      let codeCol = -1;
      for (let c = 0; c < width; c++) {
        const hits = sample.filter((r) => CODE_RE.test(cleanCode(r[c]))).length;
        if (hits >= Math.max(1, sample.length * 0.5)) { codeCol = c; break; }
      }
      if (codeCol >= 0) {
        roles[codeCol] = 'code';
        for (let c = codeCol + 1; c < width; c++) {
          if (sample.filter((r) => /[ก-๙a-z]/i.test(String(r[c] ?? ''))).length >= sample.length * 0.5) { roles[c] = 'full'; break; }
        }
      }
      headerRow = -1;
    }
    while (roles.length < width) roles.push('ignore');
    roles = roles.map((x) => x || 'ignore');
    // มีทั้ง "ชื่อ-สกุล" และ ชื่อ/นามสกุลแยก → ใช้แบบแยก
    if (roles.includes('full') && roles.includes('first') && roles.includes('last')) roles = roles.map((x) => (x === 'full' ? 'ignore' : x));
    // บทบาทเดียวกันซ้ำ (เช่น 2 คอลัมน์ "กลุ่ม") → ใช้คอลัมน์แรก
    const seen = new Set();
    roles = roles.map((x) => { if (x === 'ignore') return x; if (seen.has(x)) return 'ignore'; seen.add(x); return x; });
    const headers = headerRow >= 0 ? (rows[headerRow] || []).map((h) => String(h ?? '').trim()) : [];
    return { headerRow, roles, headers, width };
  }

  function splitPrefix(name) {
    const s = String(name ?? '').trim();
    for (const p of PREFIXES) if (s.startsWith(p) && s.length > p.length) return [p, s.slice(p.length).trim()];
    return ['', s];
  }

  // แปลงเป็นแถวที่จะส่งไปเซิร์ฟเวอร์
  // opts: { includePrefix: true, sectionValue: string|null }
  function build(rows, det, opts = {}) {
    const idx = (role) => det.roles.indexOf(role);
    const iCode = idx('code'), iPre = idx('prefix'), iFirst = idx('first'), iLast = idx('last'), iFull = idx('full'), iGroup = idx('group'), iSec = idx('section');
    const out = [], skipped = [];
    const start = det.headerRow + 1;
    rows.slice(start).forEach((r, k) => {
      if (!r || !r.some((c) => String(c ?? '').trim() !== '')) return;
      const line = start + k + 1; // เลขแถวใน Excel
      const rawCode = iCode >= 0 ? String(r[iCode] ?? '').trim() : '';
      // ไม่มีรหัส หรือเป็นข้อความล้วน (เช่น แถวสรุป "รวม 28 คน", "ลงชื่อ...") → ข้าม
      if (!rawCode || !/\d{4,}/.test(rawCode.replace(/[\s-]/g, ''))) { skipped.push({ line, reason: 'ไม่มีรหัส', text: r.filter(Boolean).join(' ').slice(0, 60) }); return; }
      if (iSec >= 0 && opts.sectionValue != null && opts.sectionValue !== '' && norm(r[iSec]).replace(/^0+/, '') !== norm(opts.sectionValue).replace(/^0+/, '')) return;
      let prefix = iPre >= 0 ? String(r[iPre] ?? '').trim() : '';
      let name;
      if (iFirst >= 0 || iLast >= 0) name = [String(r[iFirst] ?? '').trim(), String(r[iLast] ?? '').trim()].filter(Boolean).join(' ');
      else name = String(r[iFull] ?? '').trim();
      if (!prefix) { const [p, rest] = splitPrefix(name); if (p) { prefix = p; name = rest; } }
      const full = (opts.includePrefix !== false && prefix ? prefix : '') + name;
      out.push({ line, code: cleanCode(rawCode), full_name: full.replace(/\s+/g, ' ').trim(), group: iGroup >= 0 ? String(r[iGroup] ?? '').trim() || null : null });
    });
    return { rows: out, skipped };
  }

  function sectionValues(rows, det) {
    const i = det.roles.indexOf('section');
    if (i < 0) return [];
    const set = new Set();
    rows.slice(det.headerRow + 1).forEach((r) => { const v = String(r?.[i] ?? '').trim(); if (v) set.add(v); });
    return [...set].sort((a, b) => a.localeCompare(b, 'th', { numeric: true }));
  }

  // ---------- วางจากหน้าเว็บ (เช่น หน้ารายชื่อของ CES) ----------
  // อ่านหัวหน้า: "รายวิชา ENH68-111 ชื่อวิชา" / "กลุ่ม 1" / "ภาคการศึกษาที่ 1/2569"
  function parseMeta(text) {
    const t = String(text || '').replace(/ /g, ' ');
    const course = /รายวิชา\s*[:：]?\s*([A-Z]{2,5}\s?\d{2,3}\s?-\s?\d{3}[A-Z]?|[A-Z]{2,5}\d{3,6}[A-Z]?)\s+([^\n\r\t]*)/i.exec(t);
    const sec = /(?:^|\s|\n)กลุ่ม(?:เรียน)?(?:ที่)?\s*[:：]?\s*(\d{1,3})(?=\s|$)/m.exec(t);
    const term = /ภาค(?:การศึกษา|เรียน)(?:ที่)?\s*[:：]?\s*(1|2|3|ฤดูร้อน|summer)\s*\/\s*(25\d\d)/i.exec(t);
    const meta = {};
    if (course) { meta.course_code = course[1].replace(/\s+/g, '').toUpperCase(); meta.course_name = course[2].trim().replace(/\s+/g, ' ').slice(0, 200) || null; }
    if (sec) meta.section_no = sec[1];
    if (term) { meta.term = /ฤดูร้อน|summer|^3$/i.test(term[1]) ? 'summer' : term[1]; meta.academic_year = term[2]; }
    return meta;
  }

  // แปลงคลิปบอร์ดเป็นตาราง 2 มิติ: ใช้ HTML ก่อน (แยกช่องแม่นที่สุด) → ข้อความคั่นด้วย tab → ข้อความเว้นวรรค (เดา)
  function parsePaste(html, text) {
    let rows = [], mode = 'text', plain = String(text || '');
    if (html && /<t[dh][\s>]/i.test(html)) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      rows = Array.from(doc.querySelectorAll('tr'))
        .filter((tr) => !tr.querySelector('table')) // ข้ามแถวของตารางจัดหน้า (ที่มีตารางซ้อนข้างใน)
        .map((tr) => Array.from(tr.children).filter((c) => /^T[DH]$/.test(c.tagName)).map((c) => c.textContent.replace(/\s+/g, ' ').trim()));
      plain = plain || doc.body.innerText || doc.body.textContent || '';
      if (!plain.trim()) plain = doc.body.textContent;
      mode = 'html';
    }
    if (!rows.some((r) => r.some((c) => /\d{6,12}/.test(c.replace(/[\s-]/g, ''))))) {
      const lines = plain.split(/\r?\n/);
      if (lines.some((l) => l.includes('\t'))) { rows = lines.map((l) => l.split('\t').map((c) => c.trim())); mode = 'tab'; }
      else {
        // ไม่มี tab (เช่น ก๊อปจากมือถือ): "ลำดับ รหัส คำนำหน้าชื่อ นามสกุล ..." → รหัส + 2 คำถัดไปเป็นชื่อ-สกุล
        rows = [['ลำดับ', 'รหัสนักศึกษา', 'ชื่อ-สกุล']];
        for (const l of lines) {
          const m = /^\s*(\d{1,4})?\s*(\d{6,12}|\d{4}-\d{4})\s+(\S+)\s+(\S+)/.exec(l);
          if (m) rows.push([m[1] || '', m[2], `${m[3]} ${m[4]}`]);
        }
        mode = 'words';
      }
    }
    return { rows, meta: parseMeta(plain), mode };
  }

  // ตรวจความครบ: เลขลำดับต่อเนื่อง 1..N ไม่ขาด ไม่ซ้ำ (กันก๊อปมาไม่ครบ/ก๊อปแค่บางส่วน)
  function checkSequence(rows, det) {
    const i = det.headers.findIndex((h) => /^ลำดับ|^no\.?$|^ที่$/i.test(String(h).replace(/\s+/g, '')));
    if (i < 0) return null;
    const nums = rows.slice(det.headerRow + 1).map((r) => String(r?.[i] ?? '').trim()).filter((x) => /^\d+$/.test(x)).map(Number);
    if (!nums.length) return null;
    const max = Math.max(...nums), set = new Set(nums);
    const missing = []; for (let k = 1; k <= max; k++) if (!set.has(k)) missing.push(k);
    return { max, count: nums.length, missing, duplicated: nums.length - set.size, ok: missing.length === 0 && nums.length === set.size && nums[0] === 1 };
  }

  global.RosterImport = { ROLES, detect, build, sectionValues, splitPrefix, parsePaste, parseMeta, checkSequence };
})(window);
