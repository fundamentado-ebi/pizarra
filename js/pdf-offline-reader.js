// ============================================================================
// Lector de PDF 100% Offline (JavaScript Puro + DecompressionStream nativo)
// Extrae texto seleccionable de archivos PDF sin requerir conexión a internet.
// ============================================================================
(function (global) {
  function decodePdfString(raw) {
    // Manejo de UTF-16BE con BOM (FE FF)
    if (raw.length >= 2 && raw.charCodeAt(0) === 0xFE && raw.charCodeAt(1) === 0xFF) {
      let out = '';
      for (let i = 2; i + 1 < raw.length; i += 2) {
        out += String.fromCharCode((raw.charCodeAt(i) << 8) | raw.charCodeAt(i + 1));
      }
      return out;
    }
    // Decodificación de escapes PDF y WinAnsi básico
    let res = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[++i];
        if (next === 'n') res += '\n';
        else if (next === 'r') res += '\r';
        else if (next === 't') res += '\t';
        else if (next === 'b') res += '\b';
        else if (next === 'f') res += '\f';
        else if (next === '(' || next === ')' || next === '\\') res += next;
        else if (next >= '0' && next <= '7') {
          let oct = next;
          if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
          if (i + 1 < raw.length && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
          res += String.fromCharCode(parseInt(oct, 8));
        } else {
          res += next;
        }
      } else {
        res += ch;
      }
    }
    return res;
  }

  function decodeHexString(hex) {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    let bytes = [];
    for (let i = 0; i < clean.length; i += 2) {
      bytes.push(parseInt(clean.substr(i, 2).padEnd(2, '0'), 16));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return out;
    }
    return bytes.map(b => String.fromCharCode(b)).join('');
  }

  async function inflateBytes(uint8) {
    if (typeof DecompressionStream === 'undefined') return null;
    for (const fmt of ['deflate', 'deflate-raw']) {
      try {
        const ds = new DecompressionStream(fmt);
        const writer = ds.writable.getWriter();
        writer.write(uint8);
        writer.close();
        const buf = await new Response(ds.readable).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) {
        // intentar siguiente formato
      }
    }
    return null;
  }

  function bytesToLatin1(u8) {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return out;
  }

  function extractTextFromContentStream(streamText) {
    const lines = [];
    let currentLine = '';
    // Extraer bloques BT ... ET
    const btRegex = /BT([\s\S]*?)ET/g;
    let m;
    while ((m = btRegex.exec(streamText)) !== null) {
      const block = m[1];
      let i = 0;
      while (i < block.length) {
        const ch = block[i];
        // Cadena entre paréntesis (...)
        if (ch === '(') {
          let depth = 1;
          let j = i + 1;
          let raw = '';
          while (j < block.length && depth > 0) {
            if (block[j] === '\\' && j + 1 < block.length) {
              raw += block[j] + block[j + 1];
              j += 2;
              continue;
            }
            if (block[j] === '(') depth++;
            else if (block[j] === ')') {
              depth--;
              if (depth === 0) break;
            }
            raw += block[j];
            j++;
          }
          currentLine += decodePdfString(raw);
          i = j + 1;
          continue;
        }
        // Cadena hexadecimal <...>
        if (ch === '<' && block[i + 1] !== '<') {
          const end = block.indexOf('>', i + 1);
          if (end !== -1) {
            currentLine += decodeHexString(block.slice(i + 1, end));
            i = end + 1;
            continue;
          }
        }
        // Saltos de línea PDF: T*, Td, TD, '
        if ((ch === 'T' && (block[i + 1] === '*' || block[i + 1] === 'd' || block[i + 1] === 'D')) || ch === "'") {
          if (currentLine.trim()) {
            lines.push(currentLine.trim());
            currentLine = '';
          }
          i += 2;
          continue;
        }
        i++;
      }
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
        currentLine = '';
      }
    }
    return lines.join('\n');
  }

  async function extractPdfTextOffline(arrayBuffer) {
    // Si el usuario agregó pdfjsLib local, usarlo primero
    if (global.pdfjsLib && global.pdfjsLib.getDocument) {
      const pdf = await global.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let full = '';
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        full += tc.items.map(it => it.str).join(' ') + '\n';
      }
      return full.trim();
    }

    // Motor 100% nativo sin dependencias externas
    const u8 = new Uint8Array(arrayBuffer);
    const raw = bytesToLatin1(u8);
    const extractedParts = [];

    const streamRegex = /<<([\s\S]*?)>>\s*stream\r?\n/g;
    let match;
    while ((match = streamRegex.exec(raw)) !== null) {
      const dict = match[1];
      const start = match.index + match[0].length;
      const end = raw.indexOf('endstream', start);
      if (end === -1) break;

      let sliceEnd = end;
      if (u8[sliceEnd - 1] === 0x0A) sliceEnd--;
      if (u8[sliceEnd - 1] === 0x0D) sliceEnd--;

      const streamBytes = u8.subarray(start, sliceEnd);
      let decodedText = '';
      if (/\/FlateDecode/.test(dict)) {
        const inflated = await inflateBytes(streamBytes);
        if (inflated) {
          decodedText = bytesToLatin1(inflated);
        }
      } else {
        decodedText = bytesToLatin1(streamBytes);
      }

      if (decodedText && decodedText.includes('BT') && decodedText.includes('ET')) {
        const txt = extractTextFromContentStream(decodedText);
        if (txt.trim()) extractedParts.push(txt);
      }
      streamRegex.lastIndex = end + 9;
    }

    return extractedParts.join('\n').trim();
  }

  global.extractPdfTextOffline = extractPdfTextOffline;
})(window);
