/*
 * xlsx-read — อ่านไฟล์ .xlsx / .csv ในเบราว์เซอร์ โดยไม่ต้องใช้ไลบรารีภายนอก
 *   - .xlsx: แตก zip ด้วย DecompressionStream('deflate-raw') (Chrome 80+, Safari 16.4+, Firefox 113+) แล้วอ่าน XML
 *   - .csv : รองรับ UTF-8 และ Windows-874/TIS-620 (CSV ภาษาไทยที่ Excel บันทึก), ตัวคั่น , ; หรือ tab
 *   - .xls (Excel รุ่นเก่า) ไม่รองรับ → ให้บันทึกเป็น .xlsx ก่อน
 *
 *   const { sheets } = await XlsxRead.read(file)   // sheets = [{ name, rows: string[][] }]
 */
(function (global) {
  'use strict';

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('เบราว์เซอร์นี้อ่านไฟล์ Excel ไม่ได้ — อัปเดตเบราว์เซอร์ หรือบันทึกไฟล์เป็น .csv');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buf) {
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('ไฟล์ไม่ใช่ .xlsx ที่ถูกต้อง');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const td = new TextDecoder();
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, { method, csize, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return async (name) => {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const data = u8.subarray(start, start + e.csize);
      const out = e.method === 0 ? data : e.method === 8 ? await inflateRaw(data) : null;
      if (!out) throw new Error('รูปแบบบีบอัดไฟล์ไม่รองรับ');
      return td.decode(out);
    };
  }

  const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
  const byTag = (node, tag) => Array.from(node.getElementsByTagName(tag));
  const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const textOf = (node) => byTag(node, 't').map((t) => t.textContent).join('');

  async function readXlsx(buf) {
    const get = await unzip(buf);
    const wb = await get('xl/workbook.xml');
    if (!wb) throw new Error('ไม่พบข้อมูลสมุดงานในไฟล์');
    const rels = xml((await get('xl/_rels/workbook.xml.rels')) || '<Relationships/>');
    const target = new Map(byTag(rels, 'Relationship').map((r) => [r.getAttribute('Id'), r.getAttribute('Target')]));
    const ssXml = await get('xl/sharedStrings.xml');
    const shared = ssXml ? byTag(xml(ssXml), 'si').map(textOf) : [];
    const sheets = [];
    for (const s of byTag(xml(wb), 'sheet')) {
      const rid = s.getAttribute('r:id') || s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      let path = target.get(rid) || '';
      path = path.startsWith('/') ? path.slice(1) : 'xl/' + path.replace(/^\.\//, '');
      const sx = await get(path);
      if (!sx) continue;
      const rows = [];
      for (const r of byTag(xml(sx), 'row')) {
        const ri = Number(r.getAttribute('r') || rows.length + 1) - 1;
        const row = [];
        let auto = 0;
        for (const c of byTag(r, 'c')) {
          const ref = c.getAttribute('r'), ci = ref ? colIndex(ref) : auto;
          auto = ci + 1;
          const t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0]?.textContent ?? '';
          let val = '';
          if (t === 's') val = shared[Number(v)] ?? '';
          else if (t === 'inlineStr') val = textOf(c);
          else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
          else if (t === 'str' || t === 'e') val = v;
          else if (v !== '') { const num = Number(v); val = Number.isFinite(num) ? (Number.isInteger(num) ? String(num) : String(Number(num.toPrecision(12)))) : v; }
          row[ci] = val;
        }
        rows[ri] = Array.from(row, (x) => x ?? '');
      }
      sheets.push({ name: s.getAttribute('name') || `Sheet${sheets.length + 1}`, rows: Array.from(rows, (x) => x ?? []) });
    }
    return sheets;
  }

  function decodeText(buf) {
    const u8 = new Uint8Array(buf);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, ''); } catch { /* ลองรหัสไทยของ Windows */ }
    try { return new TextDecoder('windows-874').decode(u8); } catch { return new TextDecoder().decode(u8); }
  }

  function parseCsv(text) {
    const first = text.split(/\r?\n/, 1)[0] || '';
    const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  async function read(file) {
    const name = (file.name || '').toLowerCase();
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 8));
    if (head[0] === 0xD0 && head[1] === 0xCF) throw new Error('ไฟล์ .xls (Excel รุ่นเก่า) ยังไม่รองรับ — เปิดใน Excel แล้ว "บันทึกเป็น" .xlsx ก่อน');
    if (head[0] === 0x50 && head[1] === 0x4B) return { sheets: await readXlsx(buf) };
    if (name.endsWith('.csv') || name.endsWith('.txt') || !name.includes('.')) return { sheets: [{ name: file.name || 'CSV', rows: parseCsv(decodeText(buf)) }] };
    throw new Error('รองรับเฉพาะไฟล์ .xlsx หรือ .csv');
  }

  global.XlsxRead = { read, parseCsv };
})(window);
