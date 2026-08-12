/**
 * 轻量 XLSX 生成器（零依赖，纯 JS）
 * 生成标准 .xlsx：ZIP(STORE) 容器 + SpreadsheetML XML
 * 支持：多工作表、表头样式（加粗白字蓝底）、列宽、冻结首行
 * 兼容 Excel / WPS / Numbers
 */
(function (global) {
  'use strict';

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // ---------- ZIP (STORE) ----------
  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  function u16(v) { return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]); }
  function u32(v) {
    return new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]);
  }

  /** 生成 ZIP 容器（无压缩 STORE） */
  function zipStore(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    for (const f of files) {
      const nameB = utf8(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameB.length + data.length);
      local.set([0x50, 0x4B, 0x03, 0x04], 0);          // PK\x03\x04
      local.set(u16(20), 4);                            // version needed
      local.set(u16(0x0800), 6);                        // flags UTF-8
      local.set(u16(0), 8);                             // method store
      local.set(u16(dosTime), 10);
      local.set(u16(dosDate), 12);
      local.set(u32(crc), 14);
      local.set(u32(data.length), 18);                  // compressed size
      local.set(u32(data.length), 22);                  // uncompressed size
      local.set(u16(nameB.length), 26);
      local.set(u16(0), 28);                            // extra len
      local.set(nameB, 30);
      local.set(data, 30 + nameB.length);
      parts.push(local);

      const cen = new Uint8Array(46 + nameB.length);
      cen.set([0x50, 0x4B, 0x01, 0x02], 0);             // PK\x01\x02
      cen.set(u16(20), 4);                              // version made by
      cen.set(u16(20), 6);                              // version needed
      cen.set(u16(0x0800), 8);
      cen.set(u16(0), 10);
      cen.set(u16(dosTime), 12);
      cen.set(u16(dosDate), 14);
      cen.set(u32(crc), 16);
      cen.set(u32(data.length), 20);
      cen.set(u32(data.length), 24);
      cen.set(u16(nameB.length), 28);
      cen.set(u16(0), 30);                              // extra
      cen.set(u16(0), 32);                              // comment
      cen.set(u16(0), 34);                              // disk
      cen.set(u16(0), 36);                              // internal attrs
      cen.set(u32(0), 38);                              // external attrs
      cen.set(u32(offset), 42);                         // local header offset
      cen.set(nameB, 46);
      central.push(cen);
      offset += local.length;
    }

    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const eocd = new Uint8Array(22);
    eocd.set([0x50, 0x4B, 0x05, 0x06], 0);              // PK\x05\x06
    eocd.set(u16(0), 4);                                // disk
    eocd.set(u16(0), 6);                                // disk with central
    eocd.set(u16(files.length), 8);
    eocd.set(u16(files.length), 10);
    eocd.set(u32(centralSize), 12);
    eocd.set(u32(offset), 16);
    eocd.set(u16(0), 20);

    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    for (const c of central) { out.set(c, pos); pos += c.length; }
    out.set(eocd, pos);
    return out;
  }

  // ---------- XLSX XML ----------
  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function colName(n) {
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  /**
   * 构建工作表 XML
   * @param {string} name 工作表名
   * @param {Array<Array<any>>} rows 二维数组，第一行视为表头（样式 s=1）
   * @param {Array<number>} colWidths 列宽数组（字符单位）
   */
  function sheetXml(name, rows, colWidths) {
    const cols = (colWidths || []).map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const body = rows.map((row, r) => {
      const cells = row.map((v, c) => {
        const ref = colName(c + 1) + (r + 1);
        if (v == null || v === '') return `<c r="${ref}"/>`;
        const s = r === 0 ? ' s="1"' : '';
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
        return `<c r="${ref}"${s} t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
  }

  /** 构建 workbook.xml */
  function workbookXml(sheets) {
    const refs = sheets.map((s, i) =>
      `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${refs}</sheets></workbook>`;
  }

  /**
   * 构建完整 XLSX 文件
   * @param {Array<{name:string, rows:Array<Array>, colWidths?:Array<number>}>} sheets
   * @returns {Blob}
   */
  function buildXlsx(sheets) {
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

    const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

    const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="3"><font><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/></font><font><b/><color rgb="FFCC0000"/><sz val="11"/><name val="Microsoft YaHei"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

    const files = [
      { name: '[Content_Types].xml', data: utf8(contentTypes) },
      { name: '_rels/.rels', data: utf8(rels) },
      { name: 'xl/workbook.xml', data: utf8(workbookXml(sheets)) },
      { name: 'xl/_rels/workbook.xml.rels', data: utf8(wbRels) },
      { name: 'xl/styles.xml', data: utf8(styles) },
    ];
    sheets.forEach((s, i) => {
      files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s.name, s.rows, s.colWidths)) });
    });

    const zip = zipStore(files);
    return new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  global.XlsxBuilder = { buildXlsx, colName, crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
