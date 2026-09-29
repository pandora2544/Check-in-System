/*
 * xlsx-lite — สร้างไฟล์ .xlsx ขนาดเล็กในเบราว์เซอร์ ไม่ต้องพึ่งไลบรารีภายนอก
 * รองรับ: หลายชีต, ความกว้างคอลัมน์, ความสูงแถว, merge, ฟอนต์/ตัวหนา/สี, พื้นหลัง, เส้นขอบ,
 *         จัดแนว/ตัดบรรทัด, ตั้งค่าหน้ากระดาษ (A4, พอดีความกว้าง, หัวตารางซ้ำทุกหน้า, เลขหน้า)
 *
 * ใช้:
 *   const blob = XlsxLite.build([{ name, cols:[w...], rows:[{ h?, cells:[{ v, s? } | null ...] }], merges:['A1:J1'],
 *                                  printTitleRows:'6:7', orientation:'portrait', footer:'หน้า &P / &N' }]);
 *   style s = { font:{ name, sz, b, i, color:'FF0000' }, fill:'F2F2F2', border:'thin'|'none'|{top,bottom,left,right},
 *               h:'left'|'center'|'right', v:'top'|'center'|'bottom', wrap:true, numFmt:'0.00' }
 */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    // อักขระควบคุมที่ XML ไม่รองรับ
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  // ---------- zip (stored, ไม่บีบอัด — ไฟล์ใบเซ็นชื่อเล็กมากอยู่แล้ว) ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function zip(files) {
    const parts = [], central = [];
    let offset = 0;
    const d = new Date();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ---------- styles ----------
  function Styles(defaultFont) {
    const fonts = [], fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
    const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'], numFmts = [], xfs = [];
    const idx = (arr, x) => { let i = arr.indexOf(x); if (i < 0) { arr.push(x); i = arr.length - 1; } return i; };
    const fontXml = (f = {}) => {
      const o = { ...defaultFont, ...f };
      return `<font>${o.b ? '<b/>' : ''}${o.i ? '<i/>' : ''}${o.u ? '<u/>' : ''}<sz val="${o.sz}"/>${o.color ? `<color rgb="FF${o.color}"/>` : ''}<name val="${xmlEsc(o.name)}"/><family val="2"/></font>`;
    };
    idx(fonts, fontXml());
    const side = (k, v) => (v && v !== 'none' ? `<${k} style="${v}"><color rgb="FF000000"/></${k}>` : `<${k}/>`);
    const key = (s = {}) => {
      const font = idx(fonts, fontXml(s.font));
      const fill = s.fill ? idx(fills, `<fill><patternFill patternType="solid"><fgColor rgb="FF${s.fill}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
      let border = 0;
      if (s.border) {
        const b = typeof s.border === 'string' ? { top: s.border, bottom: s.border, left: s.border, right: s.border } : s.border;
        border = idx(borders, `<border>${side('left', b.left)}${side('right', b.right)}${side('top', b.top)}${side('bottom', b.bottom)}<diagonal/></border>`);
      }
      let numFmt = 0;
      if (s.numFmt) numFmt = 164 + idx(numFmts, s.numFmt);
      const align = (s.h || s.v || s.wrap || s.shrink)
        ? `<alignment${s.h ? ` horizontal="${s.h}"` : ''} vertical="${s.v || 'center'}"${s.wrap ? ' wrapText="1"' : ''}${s.shrink ? ' shrinkToFit="1"' : ''}/>`
        : '<alignment vertical="center"/>';
      const xf = `<xf numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"${numFmt ? ' applyNumberFormat="1"' : ''}>${align}</xf>`;
      return idx(xfs, xf);
    };
    key({}); // xf 0 = ค่าเริ่มต้น
    return {
      id: key,
      xml: () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${numFmts.length ? `<numFmts count="${numFmts.length}">${numFmts.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${xmlEsc(f)}"/>`).join('')}</numFmts>` : ''}
<fonts count="${fonts.length}">${fonts.join('')}</fonts>
<fills count="${fills.length}">${fills.join('')}</fills>
<borders count="${borders.length}">${borders.join('')}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`,
    };
  }

  const colName = (n) => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  function sheetXml(sh, styles) {
    const rows = sh.rows.map((r, ri) => {
      if (!r) return '';
      const cells = (r.cells || []).map((c, ci) => {
        if (c == null) return '';
        const ref = colName(ci) + (ri + 1), s = styles.id(c.s);
        if (c.v == null || c.v === '') return `<c r="${ref}" s="${s}"/>`;
        if (typeof c.v === 'number' && isFinite(c.v)) return `<c r="${ref}" s="${s}"><v>${c.v}</v></c>`;
        return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c.v)}</t></is></c>`;
      }).join('');
      return `<row r="${ri + 1}"${r.h ? ` ht="${r.h}" customHeight="1"` : ''}>${cells}</row>`;
    }).join('');
    const cols = (sh.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const m = sh.margins || { left: 0.5, right: 0.4, top: 0.5, bottom: 0.6, header: 0.3, footer: 0.3 };
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="${sh.gridLines ? 1 : 0}" zoomScale="${sh.zoom || 100}"/></sheetViews>
<sheetFormatPr defaultRowHeight="${sh.defaultRowHeight || 21}"/>
${cols ? `<cols>${cols}</cols>` : ''}
<sheetData>${rows}</sheetData>
${sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((x) => `<mergeCell ref="${x}"/>`).join('')}</mergeCells>` : ''}
<printOptions horizontalCentered="1"/>
<pageMargins left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}" header="${m.header}" footer="${m.footer}"/>
<pageSetup paperSize="9" orientation="${sh.orientation || 'portrait'}" fitToWidth="1" fitToHeight="0"/>
${sh.footer ? `<headerFooter><oddFooter>${xmlEsc('&C' + sh.footer)}</oddFooter></headerFooter>` : ''}
</worksheet>`;
  }

  function build(sheets, opts = {}) {
    const styles = Styles(opts.font || { name: 'TH Sarabun New', sz: 16 });
    const safeName = (n, i) => (String(n || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`);
    const names = sheets.map((s, i) => safeName(s.name, i));
    const sheetFiles = sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, styles) }));
    const defined = sheets.map((s, i) => s.printTitleRows
      ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${xmlEsc(names[i].replace(/'/g, "''"))}'!$${s.printTitleRows.split(':')[0]}:$${s.printTitleRows.split(':')[1]}</definedName>` : '').join('');
    const files = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
${defined ? `<definedNames>${defined}</definedNames>` : ''}
</workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
      ...sheetFiles,
    ];
    files.push({ name: 'xl/styles.xml', data: styles.xml() }); // สร้างหลังชีต เพื่อให้เก็บสไตล์ครบ
    return zip(files);
  }

  function download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  global.XlsxLite = { build, download, colName };
})(window);
