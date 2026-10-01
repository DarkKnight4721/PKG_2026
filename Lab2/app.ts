async function parse(f: File): Promise<any> {
  const r: any = { name: (f as any).webkitRelativePath || f.name, size: f.size, fmt: '?', w: null, h: null, dpi: '—', depth: null, comp: '—', extra: '', status: 'ok', note: '' };
  const bad = (m: string) => { if (r.status !== 'bad') { r.status = 'bad'; r.note = 'Файл поврежден: ' + m; } };
  try {
    if (f.size === 0) { bad('пустой файл'); return r; }
    const head = new Uint8Array(await f.slice(0, 65536).arrayBuffer());       // ленивое чтение: только начало файла
    const tail = new Uint8Array(await f.slice(Math.max(0, f.size - 1024)).arrayBuffer()); // и конец (проверка целостности)
    const g = async (o: number, n: number): Promise<Uint8Array> =>
      o + n <= head.length ? head.subarray(o, o + n) : new Uint8Array(await f.slice(o, o + n).arrayBuffer());
    const u = (b: Uint8Array, o: number, n: number, le = true): number => {
      if (o < 0 || o + n > b.length) throw new RangeError('обрыв данных заголовка');
      let v = 0; for (let i = 0; i < n; i++) v = le ? v + b[o + i] * 2 ** (8 * i) : v * 256 + b[o + i]; return v;
    };
    const s = (b: Uint8Array) => String.fromCharCode(...b);
    const dpi = (x: number, y: number, k: number) => { const a = Math.round(x * k), c = Math.round(y * k); return a ? (a === c ? '' + a : a + '×' + c) : '—'; };
    // ---- IFD (TIFF и Exif внутри JPEG) ----
    const TS: any = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
    const ifd = async (base: number, off: number, le: boolean) => {
      const t: any = {}, n = u(await g(base + off, 2), 0, 2, le);
      if (n > 512) throw new RangeError('некорректный IFD');
      const e = await g(base + off + 2, n * 12);
      for (let i = 0; i < n; i++) {
        const o = i * 12, tag = u(e, o, 2, le), ty = u(e, o + 2, 2, le), c = u(e, o + 4, 4, le), z = TS[ty] || 1;
        const d = z * c <= 4 ? e.subarray(o + 8, o + 8 + z * c) : await g(base + u(e, o + 8, 4, le), Math.min(z * c, 4096));
        const v: number[] = [];
        for (let k = 0; k < c && k < 64 && (k + 1) * z <= d.length; k++)
          v.push(ty === 3 ? u(d, k * 2, 2, le) : ty === 4 ? u(d, k * 4, 4, le) : ty === 5 ? u(d, k * 8, 4, le) / (u(d, k * 8 + 4, 4, le) || 1) : d[k]);
        t[tag] = v;
      }
      return t;
    };
    const tdpi = (t: any) => { const un = t[296] ? t[296][0] : 2; return t[282] && un !== 1 ? dpi(t[282][0], (t[283] || t[282])[0], un === 3 ? 2.54 : 1) : '—'; };

    const sig = s(head.subarray(0, 8));
    if (head[0] === 0x89 && sig.slice(1, 4) === 'PNG') {
      r.fmt = 'PNG';
      if (s(head.subarray(12, 16)) !== 'IHDR') throw new RangeError('нет чанка IHDR');
      r.w = u(head, 16, 4, false); r.h = u(head, 20, 4, false);
      const bd = head[24], ct = head[25], ch = [1, 0, 3, 1, 2, 0, 4][ct];
      r.depth = bd * ch; r.comp = 'Deflate (метод ' + head[26] + ')';
      r.extra = `Бит на канал: ${bd}\nТип цвета: ${ct} (${['градации серого', '', 'RGB', 'палитра', 'серый+альфа', '', 'RGBA'][ct]})\nФильтрация: метод ${head[27]} (адаптивная, 5 типов)\nЧересстрочность: ${head[28] ? 'Adam7' : 'нет'}`;
      let p = 8;
      for (let k = 0; k < 100; k++) {
        const h = await g(p, 8); if (h.length < 8) break;
        const len = u(h, 0, 4, false), ty = s(h.subarray(4, 8));
        if (ty === 'IDAT' || ty === 'IEND') break;
        if (ty === 'pHYs') { const d = await g(p + 8, 9); if (d[8] === 1) r.dpi = dpi(u(d, 0, 4, false), u(d, 4, 4, false), 0.0254); }
        if (ty === 'PLTE') r.extra += `\nЦветов в палитре: ${len / 3}`;
        p += 12 + len;
      }
      if (s(tail.slice(-8, -4)) !== 'IEND') bad('нет завершающего чанка IEND');
    } else if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) {
      r.fmt = 'JPEG';
      const SOF: any = { 0xC0: 'Baseline DCT (Huffman)', 0xC1: 'Extended sequential DCT', 0xC2: 'Progressive DCT (Huffman)', 0xC3: 'Lossless', 0xC9: 'Sequential (арифм.)', 0xCA: 'Progressive (арифм.)' };
      let i = 2, found = false;
      for (let k = 0; k < 300; k++) {
        const h = await g(i, 4);
        if (h.length < 2 || h[0] !== 0xFF) throw new RangeError('нарушена структура маркеров');
        const m = h[1];
        if (m === 0xFF) { i++; continue; }
        if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
        if (m === 0xDA || m === 0xD9) break;   // SOS: дальше идут сжатые данные, заголовок закончился (DQT может стоять после SOF)
        const L = u(h, 2, 2, false);
        if (m === 0xE0) { const d = await g(i + 4, 14); if (s(d.subarray(0, 4)) === 'JFIF') { r.dpi = d[7] ? dpi(u(d, 8, 2, false), u(d, 10, 2, false), d[7] === 2 ? 2.54 : 1) : '—'; r.extra += `JFIF ${d[5]}.${d[6]}, единицы плотности: ${['нет (пропорции)', 'dpi', 'точек/см'][d[7]]}\n`; } }
        else if (m === 0xE1 && r.dpi === '—') {
          const d = await g(i + 4, 6);
          if (s(d.subarray(0, 4)) === 'Exif') { try { const le = (await g(i + 10, 1))[0] === 0x49; r.dpi = tdpi(await ifd(i + 10, u(await g(i + 14, 4), 0, 4, le), le)); } catch (_) { } }
        } else if (m === 0xDB) {
          const d = await g(i + 4, L - 2);
          for (let p = 0; p < d.length;) {
            const pq = d[p] >> 4, tq = d[p] & 15, q: number[] = [];
            for (let z = 0; z < 64; z++) q.push(pq ? u(d, p + 1 + z * 2, 2, false) : u(d, p + 1 + z, 1));
            r.extra += `Таблица квантования ${tq} (${pq ? 16 : 8} бит, zig-zag):\n${q.join(' ')}\n`; p += 1 + 64 * (pq ? 2 : 1);
          }
        } else if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
          const d = await g(i + 4, 6);
          r.h = u(d, 1, 2, false); r.w = u(d, 3, 2, false); r.depth = d[0] * d[5];
          r.comp = SOF[m] || 'SOF' + (m - 0xC0); r.extra += `Точность: ${d[0]} бит, компонентов: ${d[5]}\n`; found = true;
        }
        i += 2 + L;
      }
      if (!found) throw new RangeError('нет маркера SOF');
      let e = tail.length; while (e > 0 && tail[e - 1] === 0) e--;
      if (!(e >= 2 && tail[e - 2] === 0xFF && tail[e - 1] === 0xD9)) bad('отсутствует маркер EOI (FF D9)');
    } else if (sig.slice(0, 3) === 'GIF') {
      r.fmt = 'GIF'; r.w = u(head, 6, 2); r.h = u(head, 8, 2);
      const pk = head[10]; r.depth = ((pk >> 4) & 7) + 1; r.comp = 'LZW';
      r.extra = `Версия: ${sig.slice(0, 6)}\nЦветов в глобальной палитре: ${pk & 0x80 ? 2 ** ((pk & 7) + 1) : 'нет (только локальные)'}`;
      if (tail[tail.length - 1] !== 0x3B) bad('нет завершающего байта 3B');
    } else if (sig.slice(0, 2) === 'BM' && [12, 40, 52, 56, 64, 108, 124].includes(u(head, 14, 4))) {
      r.fmt = 'BMP'; const hs = u(head, 14, 4), bfSize = u(head, 2, 4), off = u(head, 10, 4);
      let bpp: number;
      if (hs === 12) { r.w = u(head, 18, 2); r.h = u(head, 20, 2); bpp = u(head, 24, 2); r.comp = 'BI_RGB'; }
      else {
        r.w = u(head, 18, 4); const hh = u(head, 22, 4); r.h = hh > 2 ** 31 ? 2 ** 32 - hh : hh; bpp = u(head, 28, 2);
        r.comp = ['BI_RGB', 'BI_RLE8', 'BI_RLE4', 'BI_BITFIELDS', 'BI_JPEG', 'BI_PNG'][u(head, 30, 4)] || 'неизвестно';
        r.dpi = dpi(u(head, 38, 4), u(head, 42, 4), 0.0254);
        const cu = u(head, 46, 4); r.extra = `Порядок строк: ${hh > 2 ** 31 ? 'сверху вниз' : 'снизу вверх'}\nЦветов в палитре: ${bpp <= 8 ? cu || 2 ** bpp : 'нет (truecolor)'}`;
      }
      r.depth = bpp; r.extra += `\nСмещение пикселей: ${off}, размер заголовка DIB: ${hs}`;
      if (f.size < bfSize) bad(`размер файла ${f.size} < указанного в заголовке ${bfSize}`);
      if (off >= f.size) bad('смещение пикселей за пределами файла');
    } else if ((sig.slice(0, 2) === 'II' && head[2] === 42 && !head[3]) || (sig.slice(0, 2) === 'MM' && !head[2] && head[3] === 42)) {
      r.fmt = 'TIFF'; const le = head[0] === 0x49, t = await ifd(0, u(head, 4, 4, le), le);
      if (!t[256] || !t[257]) throw new RangeError('нет тегов размера');
      r.w = t[256][0]; r.h = t[257][0]; r.depth = (t[258] || [1]).reduce((a: number, b: number) => a + b, 0) * ((t[258] || []).length ? 1 : (t[277] || [1])[0]);
      const C: any = { 1: 'Без сжатия', 2: 'CCITT RLE', 3: 'CCITT G3', 4: 'CCITT G4', 5: 'LZW', 6: 'JPEG (старый)', 7: 'JPEG', 8: 'Deflate', 32946: 'Deflate', 32773: 'PackBits' };
      const c = t[259] ? t[259][0] : 1; r.comp = C[c] || 'код ' + c; r.dpi = tdpi(t);
      const P: any = { 0: 'WhiteIsZero', 1: 'BlackIsZero', 2: 'RGB', 3: 'Palette', 5: 'CMYK', 6: 'YCbCr', 8: 'CIELab' };
      r.extra = `Порядок байт: ${le ? 'II (little-endian)' : 'MM (big-endian)'}\nФотометрия: ${t[262] ? P[t[262][0]] || t[262][0] : '—'}\nКаналов: ${(t[277] || [1])[0]}, бит на канал: ${(t[258] || [1]).join(',')}`;
      if (t[273] && t[279] && t[273].length < 64 && t[273][t[273].length - 1] + t[279][t[279].length - 1] > f.size) bad('данные изображения обрезаны');
    } else if (head[0] === 10 && [0, 2, 3, 4, 5].includes(head[1]) && head[2] === 1 && [1, 2, 4, 8].includes(head[3]) && f.size > 128) {
      r.fmt = 'PCX'; r.w = u(head, 8, 2) - u(head, 4, 2) + 1; r.h = u(head, 10, 2) - u(head, 6, 2) + 1;
      r.depth = head[3] * head[65]; r.comp = 'RLE'; r.dpi = dpi(u(head, 12, 2), u(head, 14, 2), 1);
      r.extra = `Версия: ${head[1]}, плоскостей: ${head[65]}, байт на строку: ${u(head, 66, 2)}`;
      if (r.depth === 8 && head[65] === 1) { r.extra += '\nПалитра 256 цветов в конце файла'; if ((await g(f.size - 769, 1))[0] !== 0x0C) bad('нет маркера палитры 0C'); }
      if (r.w < 1 || r.h < 1) bad('некорректные размеры');
    } else { r.status = 'fake'; r.note = 'Не изображение: сигнатура не распознана (возможна подмена расширения)'; return r; }
    const ext = (r.name.split('.').pop() || '').toLowerCase();
    const OK: any = { PNG: ['png'], JPEG: ['jpg', 'jpeg', 'jpe', 'jfif'], GIF: ['gif'], BMP: ['bmp', 'dib'], TIFF: ['tif', 'tiff'], PCX: ['pcx'] };
    if (!OK[r.fmt].includes(ext) && r.status === 'ok') { r.status = 'warn'; r.note = `Расширение .${ext} не соответствует содержимому (${r.fmt})`; }
  } catch (e: any) { bad(e instanceof RangeError ? e.message : 'ошибка чтения'); }
  return r;
}

// ---------------- Интерфейс, пул воркеров, виртуальная таблица ----------------
const $ = (id: string) => document.getElementById(id) as any;
const RH = 30, B = 100, EXT = /\.(jpe?g|jpe|jfif|gif|tiff?|bmp|dib|png|pcx)$/i;
let files: File[] = [], rows: any[] = [], done = 0, t0 = 0, cnt: any = {}, mode = '', wurl = '', prev = '';
const esc = (x: any) => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
const ST: any = { ok: 'ok', warn: 'предупреждение', bad: 'файл поврежден', fake: 'не изображение' };
const fmtSize = (n: number) => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ';

function makeWorker(): Worker | null {
  try {
    if (!wurl) wurl = URL.createObjectURL(new Blob([`const parse=${parse.toString()};onmessage=async e=>{const o=[];for(const f of e.data)o.push(await parse(f));postMessage(o)}`], { type: 'text/javascript' }));
    return new Worker(wurl);
  } catch (_) { return null; }
}
const call = (w: Worker, b: File[]) => new Promise<any[]>((ok, no) => { w.onmessage = e => ok(e.data); w.onerror = e => no(e); w.postMessage(b); });

async function start(list: File[]) {
  files = list.filter(f => EXT.test(f.name)); rows = new Array(files.length); done = 0; cnt = { ok: 0, warn: 0, bad: 0, fake: 0 };
  $('detail').hidden = true; t0 = performance.now(); let next = 0, workers = 0;
  const lanes = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
  $('pick').disabled = $('pickf').disabled = true; draw(); stats();
  await Promise.all(Array.from({ length: lanes }, async () => {
    let w = makeWorker(); if (w) workers++;
    for (;;) {
      const s = next; if (s >= files.length) break; next += B;
      const batch = files.slice(s, s + B); let res: any[];
      try { res = w ? await call(w, batch) : await Promise.all(batch.map(parse)); }
      catch (_) { if (w) { w.terminate(); w = null; workers--; } res = await Promise.all(batch.map(parse)); }
      res.forEach((x, k) => { rows[s + k] = x; cnt[x.status]++; }); done += batch.length; sched();
    }
    if (w) w.terminate();
  }));
  mode = workers ? `Web Workers: ${workers}` : 'основной поток (async)';
  $('pick').disabled = $('pickf').disabled = false; stats(true); draw();
}
let pend = false; const sched = () => { if (!pend) { pend = true; requestAnimationFrame(() => { pend = false; stats(); draw(); }); } };
function stats(fin = false) {
  const sec = (performance.now() - t0) / 1000;
  $('pb').max = Math.max(1, files.length); $('pb').value = done;
  $('st').textContent = files.length ? `${done} из ${files.length} · ${sec.toFixed(1)} с · ${Math.round(done / Math.max(sec, 0.001))} файлов/с` + (fin ? ' · ' + mode : '') : 'Выберите папку с изображениями';
  $('cn').textContent = files.length ? `ok: ${cnt.ok} · предупреждений: ${cnt.warn} · повреждено: ${cnt.bad} · не изображений: ${cnt.fake}` : '';
}
function draw() {
  const wrap = $('wrap'), first = Math.max(0, Math.floor(wrap.scrollTop / RH) - 4), last = Math.min(rows.length, first + Math.ceil(wrap.clientHeight / RH) + 8);
  let h = '';
  for (let i = first; i < last; i++) {
    const r = rows[i];
    h += r ? `<div class="row ${r.status}" data-i="${i}"><span title="${esc(r.name)}">${esc(r.name)}</span><span>${r.fmt}</span><span class="n">${r.w == null ? '—' : r.w + ' × ' + r.h}</span><span class="n">${r.dpi}</span><span class="n">${r.depth == null ? '—' : r.depth + ' бит'}</span><span>${esc(r.comp)}</span><span class="s" title="${esc(r.note)}">${r.note && r.status !== 'warn' ? esc(r.note.split(':')[0]) : ST[r.status]}</span></div>`
      : `<div class="row wait"><span>${esc((files[i] as any).webkitRelativePath || files[i].name)}</span><span>…</span></div>`;
  }
  $('sp').style.height = rows.length * RH + 'px'; $('rows').style.transform = `translateY(${first * RH}px)`; $('rows').innerHTML = h;
}
function show(i: number) {
  const r = rows[i]; if (!r) return;
  $('detail').hidden = false; if (prev) URL.revokeObjectURL(prev);
  $('dt').textContent = `${r.name}\nФормат: ${r.fmt} · размер файла: ${fmtSize(r.size)}\n${r.note ? r.note + '\n' : ''}\n${r.extra}`;
  const im = $('pv'); im.hidden = false; prev = URL.createObjectURL(files[i]); im.onerror = () => { im.hidden = true; }; im.src = prev;
}
$('wrap').addEventListener('scroll', draw); addEventListener('resize', draw);
$('rows').addEventListener('click', (e: any) => { const d = e.target.closest('.row'); if (d && d.dataset.i) show(+d.dataset.i); });
$('pick').onchange = $('pickf').onchange = (e: any) => { const l = Array.from(e.target.files as FileList); e.target.value = ''; if (l.length) start(l); };
stats(); draw();
