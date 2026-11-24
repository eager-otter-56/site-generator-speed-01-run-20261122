// SPDX-License-Identifier: MIT
// A fast drop-in replacement for makefun-site 1.0.0's build: run(input)
// returns the same output tree (path -> text) for every input, byte for byte.
//
// Written from the published specification of the dialect (front matter,
// Markdown subset, template language, slug and report rules). The hot paths
// are organised around three ideas: fuse the Markdown lexer and renderer
// into one pass over the lines, render inline markup by ranges instead of
// substrings, and cache the slug of every repeated title, heading and tag.

'use strict';

// ---------------------------------------------------------------- text rules

const ESC_BY_CODE = [];
ESC_BY_CODE[38] = '&amp;';
ESC_BY_CODE[60] = '&lt;';
ESC_BY_CODE[62] = '&gt;';
ESC_BY_CODE[34] = '&quot;';
ESC_BY_CODE[39] = '&#39;';

/** Push `s` onto `out` with the five HTML escapes applied. */
function escapeInto(s, out) {
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const esc = ESC_BY_CODE[s.charCodeAt(i)];
    if (esc !== undefined) {
      if (i > last) out.push(s.slice(last, i));
      out.push(esc);
      last = i + 1;
    }
  }
  if (last === 0) out.push(s);
  else if (last < s.length) out.push(s.slice(last));
}

const ESC_NEEDED_RE = /[&<>"']/;

/** `s` with the five HTML escapes applied (the string itself when clean). */
function escapeHtml(s) {
  if (!ESC_NEEDED_RE.test(s)) return s;
  const out = [];
  escapeInto(s, out);
  return out.join('');
}

const slugCache = new Map();

/** The slug of `text`, memoised: titles, headings and tag names repeat a lot. */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const slug = slugifyFresh(text);
  slugCache.set(text, slug);
  return slug;
}

function slugifyFresh(text) {
  // Fast path: pure ASCII survives NFKD unchanged and holds no marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep < 0) { gap = out.length > 0; continue; }
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      const cp = ch.codePointAt(0);
      let keep = null;
      if (cp >= 65 && cp <= 90) keep = String.fromCharCode(cp + 32);
      else if ((cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57)) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) { out += '-'; gap = false; }
      out += keep;
    }
  }
  if (out.length > 64) out = out.slice(0, 64);
  while (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against the `taken` set, which it joins. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date written out in words, from the string alone. */
function longDate(date) {
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return d + ' ' + MONTHS[m - 1] + ' ' + date.slice(0, 4);
}

// ------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A title/summary value: { value } or { error }. */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) { // opens on a quote
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's parsed value: { value } or { error } with the refusal reason. */
function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringValue(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      if (m === null) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || !TAG_RE.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * Split a source into { data, body }, or { error } with the first refusal
 * reason. Only the head of the text is scanned line by line; the body is a
 * single slice, never a split-and-rejoin of the whole document.
 */
function parseFrontMatter(text) {
  let pos = text.indexOf('\n');
  const first = pos === -1 ? text : text.slice(0, pos);
  if (first !== '---') return { error: 'no front matter' };
  if (pos === -1) return { error: 'the front matter is not closed' };
  // The closing line is located first: a source with none is refused as
  // unclosed even when a line inside it is also malformed.
  let closeStart = -1;
  let bodyStart = -1;
  {
    let scan = pos + 1;
    for (;;) {
      const nl = text.indexOf('\n', scan);
      const line = nl === -1 ? text.slice(scan) : text.slice(scan, nl);
      if (line === '---') {
        closeStart = scan;
        bodyStart = nl === -1 ? text.length : nl + 1;
        break;
      }
      if (nl === -1) break;
      scan = nl + 1;
    }
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1;
  let cursor = pos + 1;
  while (cursor < closeStart) {
    lineNo++;
    const nl = text.indexOf('\n', cursor);
    const line = text.slice(cursor, nl);
    cursor = nl + 1;
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    // "key: value": a key of a-z and _, a colon, then a space or the line end.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58 || (k + 1 < line.length && line.charCodeAt(k + 1) !== 32)) {
      return { error: 'line ' + lineNo + ' is not "key: value"' };
    }
    const key = line.slice(0, k);
    let raw = k + 1 === line.length ? '' : line.slice(k + 2);
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c === 32 || c === 9) end--;
      else break;
    }
    if (end < raw.length) raw = raw.slice(0, end);
    if (!FM_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = keyValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  return { data, body: text.slice(bodyStart), hasTitle: Object.hasOwn(data, 'title') };
}

// ----------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// The JavaScript \s set as a lookup table over UTF-16 code units.
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
for (let c = 8192; c <= 8202; c++) WS_TABLE[c] = 1;

function isSpaceCode(c) {
  return WS_TABLE[c] === 1;
}

/** The first `what` at or after `from` (and before `hi`) not hidden by a backslash escape. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  for (let j = from; j + wlen <= hi; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first lone `*` at or after `from`: one whose neighbour is not also `*`. */
function findSingleStar(s, from, hi) {
  for (let j = from; j < hi; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < hi && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== 42) continue;
    if (j + 1 < hi && s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** Push s[lo, hi) onto `out` with the five HTML escapes applied. */
function escapeRange(s, lo, hi, out) {
  let last = lo;
  for (let i = lo; i < hi; i++) {
    const esc = ESC_BY_CODE[s.charCodeAt(i)];
    if (esc !== undefined) {
      if (i > last) out.push(s.slice(last, i));
      out.push(esc);
      last = i + 1;
    }
  }
  if (last === lo) out.push(s.slice(lo, hi));
  else if (last < hi) out.push(s.slice(last, hi));
}

const WS_RE = /\s/;

/**
 * Render the inline markup of s[lo, hi) onto `out`. Working on ranges of the
 * original string keeps strong/emphasis/link nesting free of substring
 * copies; plain runs are located with native indexOf scans.
 */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

function renderInline(s, lo, hi, link, out) {
  // Fast path: no special character in the range means plain text.
  SPECIAL_RE.lastIndex = lo;
  const sm0 = SPECIAL_RE.exec(s);
  if (sm0 === null || sm0.index >= hi) { if (hi > lo) out.push(s.slice(lo, hi)); return; }
  let i = lo;
  let plain = lo;
  const flush = (upto) => { if (upto > plain) out.push(s.slice(plain, upto)); };
  while (i < hi) {
    // One native scan finds the next character that could start markup or
    // need escaping. lastIndex is assigned before every exec, so sharing
    // the regex across recursive calls is safe.
    SPECIAL_RE.lastIndex = i;
    const sm = SPECIAL_RE.exec(s);
    const j = sm === null ? hi : sm.index;
    if (j >= hi) break;
    const c = s.charCodeAt(j);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      flush(j);
      out.push(ESC_BY_CODE[c]);
      i = j + 1;
      plain = i;
      continue;
    }
    if (c === 92) { // backslash
      if (j + 1 < hi && ESCAPABLE.has(s[j + 1])) {
        flush(j);
        const e = ESC_BY_CODE[s.charCodeAt(j + 1)];
        out.push(e !== undefined ? e : s[j + 1]);
        i = j + 2;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === 96) { // code span
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < hi && k > j + 1) {
        flush(j);
        out.push('<code>');
        escapeRange(s, j + 1, k, out);
        out.push('</code>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    if (c === 42) { // strong or emphasis
      if (j + 1 < hi && s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, hi);
        if (k > j + 2) {
          flush(j);
          out.push('<strong>');
          renderInline(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1, hi);
      if (k > j + 1) {
        flush(j);
        out.push('<em>');
        renderInline(s, j + 1, k, link, out);
        out.push('</em>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
      continue;
    }
    // c === 91, a possible link
    const k = findUnescaped(s, ']', j + 1, hi);
    const m = k !== -1 && k + 1 < hi && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    if (m !== -1 && m < hi) {
      const target = s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        flush(j);
        out.push('<a href="');
        out.push(escapeHtml(link(target)));
        out.push('">');
        renderInline(s, j + 1, k, link, out);
        out.push('</a>');
        i = m + 1;
        plain = i;
        continue;
      }
    }
    i = j + 1;
  }
  if (hi > plain) out.push(s.slice(plain, hi));
}

/** The inline HTML of a whole string. */
function inlineString(s, link) {
  if (s === '') return '';
  const out = [];
  renderInline(s, 0, s.length, link, out);
  return out.join('');
}

// Line classification, by hand: the reference's per-line regexes are the
// single hottest cost after inline rendering itself.

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence opening line's language, or null. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return null;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null. */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d === line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let start = d;
  while (start < line.length) {
    const cc = line.charCodeAt(start);
    if (cc === 32 || cc === 9) start++;
    else break;
  }
  let end = line.length;
  while (end > start) {
    const cc = line.charCodeAt(end - 1);
    if (cc === 32 || cc === 9) end--;
    else break;
  }
  if (end === start) return null;
  return { depth: d, text: line.slice(start, end) };
}

function isHr(line) {
  const a = line.charCodeAt(0);
  if (a !== 45 && a !== 42) return false;
  if (line.charCodeAt(1) !== a || line.charCodeAt(2) !== a) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item's text after the marker, or null. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered item's { num, text }, or null. */
function orderedText(line) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c >= 48 && c <= 57) d++;
    else break;
  }
  if (d === 0 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { num: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i === line.length) return false;
  return !isSpaceCode(line.charCodeAt(i));
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** How many whitespace-separated words `line` (one line, no newline) holds. */
function wordsIn(line) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    if (WS_TABLE[line.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/**
 * Render a Markdown body in one fused pass: blocks are recognised and
 * rendered in the same walk, so no token objects are ever built. Word
 * counting rides along: every line is consumed once, so summing per-line
 * counts equals counting the whole body. Returns { html, toc, excerpt, words }.
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let words = 0;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const c0 = line.charCodeAt(0);
    const lang = c0 === 96 ? fenceLang(line) : null;
    if (lang !== null) {
      words += wordsIn(line);
      i++;
      const parts = ['<pre><code'];
      if (lang !== '') parts.push(' class="language-' + escapeHtml(lang) + '"');
      parts.push('>');
      while (i < n && !isFenceClose(lines[i])) {
        words += wordsIn(lines[i]);
        escapeInto(lines[i], parts);
        parts.push('\n');
        i++;
      }
      if (i < n) words += wordsIn(lines[i]);
      i++;
      parts.push('</code></pre>\n');
      out.push(parts.join(''));
      continue;
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      words += wordsIn(line);
      const id = uniqueSlug(slugify(heading.text), ids);
      if (heading.depth === 2 || heading.depth === 3) {
        const html = inlineString(heading.text, link);
        out.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>\n');
        toc.push({ level: heading.depth, id, html });
      } else {
        out.push('<h' + heading.depth + ' id="' + id + '">');
        renderInline(heading.text, 0, heading.text.length, link, out);
        out.push('</h' + heading.depth + '>\n');
      }
      i++;
      continue;
    }
    if (c0 === 45 || c0 === 42) {
      if (isHr(line)) { words += wordsIn(line); out.push('<hr>\n'); i++; continue; }
    }
    if (c0 === 62) { // blockquote
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        words += wordsIn(lines[i]);
        let q = lines[i].slice(1);
        if (q.charCodeAt(0) === 32) q = q.slice(1);
        q = trimLine(q);
        if (q !== '') kept.push(q);
        i++;
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.length === 1 ? kept[0] : kept.join('\n');
        out.push('<blockquote>\n<p>');
        renderInline(joined, 0, joined.length, link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bText = (c0 === 45 || c0 === 42) ? bulletText(line) : null;
    const oText = bText === null && c0 >= 48 && c0 <= 57 ? orderedText(line) : null;
    if (bText !== null || oText !== null) {
      const ordered = oText !== null;
      const items = [];
      while (i < n) {
        const cur = lines[i];
        const t = ordered ? orderedText(cur) : bulletText(cur);
        if (t !== null) {
          words += wordsIn(cur);
          items.push([trimLine(ordered ? t.text : t)]);
          i++;
        } else if (isContinued(cur)) {
          words += wordsIn(cur);
          items[items.length - 1].push(trimLine(cur));
          i++;
        } else break;
      }
      const parts = [];
      if (ordered) parts.push(oText.num !== 1 ? '<ol start="' + oText.num + '">\n' : '<ol>\n');
      else parts.push('<ul>\n');
      for (const partsOfItem of items) {
        parts.push('<li>');
        const joined = partsOfItem.length === 1 ? partsOfItem[0] : partsOfItem.join('\n');
        renderInline(joined, 0, joined.length, link, parts);
        parts.push('</li>\n');
      }
      parts.push(ordered ? '</ol>\n' : '</ul>\n');
      out.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    words += wordsIn(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) { words += wordsIn(lines[i]); body.push(trimLine(lines[i])); i++; }
    const joined = body.length === 1 ? body[0] : body.join('\n');
    if (excerpt === null) {
      excerpt = inlineString(joined, link);
      out.push('<p>' + excerpt + '</p>\n');
    } else {
      out.push('<p>');
      renderInline(joined, 0, joined.length, link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt, words };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

// Node kinds: 0 text, 1 var (escaped), 2 raw, 3 if, 4 for, 5 include.

function templateError(name, why) {
  return new Error('template "' + name + '": ' + why);
}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw templateError(name, JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function isOnlyWs(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Tokenise and parse one template source into a node tree. */
function parseTemplate(name, src) {
  // Tokenise, honouring the standalone-tag-line rule.
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const closer = raw ? '}}}' : '}}';
      const close = src.indexOf(closer, open + (raw ? 3 : 2));
      if (close === -1) throw templateError(name, 'a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') { tokens.push({ t: 0, text }); text = ''; }
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + closer.length;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw templateError(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = isOnlyWs(src, lineStart, open) && isOnlyWs(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ t: 0, text }); text = ''; }
    tokens.push({ t: 6, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });

  // Build the tree with a stack, exactly as the dialect's nesting rules say.
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokens) {
    if (tok.t === 0) { body.push({ k: 0, text: tok.text }); continue; }
    if (tok.t === 1 || tok.t === 2) { body.push({ k: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 4, kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 3, kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) throw templateError(name, 'an else outside an if');
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) throw templateError(name, 'an ' + tag + ' with no open ' + tag.slice(3));
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null && parent.else !== undefined ? parent.else : parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ k: 5, name: m[1] });
    } else {
      throw templateError(name, '{% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw templateError(name, 'a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

/** The value at `path`: first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as the dialect writes it. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Render `nodes` onto the `out` array in `scope`. */
function renderNodes(nodes, scope, templates, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const n = nodes[idx];
    switch (n.k) {
      case 0:
        out.push(n.text);
        break;
      case 1:
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 2:
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 3: {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        // One loop record and one child scope for the whole loop: rendering
        // is synchronous, so no iteration's bindings outlive its render.
        const loop = { index: 1, first: true, last: len === 1, length: len };
        const child = { vars: null, parent: scope };
        for (let k = 0; k < len; k++) {
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === len - 1;
          const vars = {};
          vars[n.name] = xs[k];
          vars.loop = loop;
          child.vars = vars;
          renderNodes(n.body, child, templates, depth, out);
        }
        break;
      }
      case 5: {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

/**
 * Include expansion: an include's depth is fixed by its static nesting, so
 * every template can be pre-flattened for a top-level (depth 0) render,
 * with includes past the depth limit dropped just as the renderer drops
 * them. Pathological self-inclusion falls back to the plain tree when the
 * expansion grows past a node budget.
 */
function expandNodes(nodes, depth, templates, memo, state) {
  const out = [];
  for (const n of nodes) {
    if (state.overflow) return nodes;
    if (n.k === 5) {
      if (depth < INCLUDE_DEPTH && templates.has(n.name)) {
        const sub = expandTemplate(n.name, depth + 1, templates, memo, state);
        for (const sn of sub) out.push(sn);
        state.count += sub.length;
      }
      continue;
    }
    state.count++;
    if (state.count > 20000) { state.overflow = true; return nodes; }
    if (n.k === 3) {
      const then = expandNodes(n.then, depth, templates, memo, state);
      const els = n.else === null ? null : expandNodes(n.else, depth, templates, memo, state);
      out.push(then === n.then && els === n.else ? n : { k: 3, kind: 'if', not: n.not, path: n.path, then, else: els });
    } else if (n.k === 4) {
      const body = expandNodes(n.body, depth, templates, memo, state);
      out.push(body === n.body ? n : { k: 4, kind: 'for', name: n.name, path: n.path, body });
    } else out.push(n);
  }
  return out;
}

function expandTemplate(name, depth, templates, memo, state) {
  const key = name + '\n' + depth;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const expanded = expandNodes(templates.get(name), depth, templates, memo, state);
  memo.set(key, expanded);
  return expanded;
}

/** Every template pre-flattened for depth-0 rendering (or the plain map). */
function flattenedTemplates(templates) {
  const memo = new Map();
  const state = { count: 0, overflow: false };
  const out = new Map();
  for (const name of templates.keys()) {
    out.set(name, expandTemplate(name, 0, templates, memo, state));
    if (state.overflow) return templates;
  }
  return out;
}

// -------------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

const resolveCache = new Map();

/** A link path resolved against a source directory, or null if it climbs out. */
function resolvePath(dir, rel) {
  let byDir = resolveCache.get(dir);
  if (byDir === undefined) {
    byDir = new Map();
    resolveCache.set(dir, byDir);
  } else {
    const hit = byDir.get(rel);
    if (hit !== undefined) return hit;
  }
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) { byDir.set(rel, null); return null; }
      parts.pop();
    } else parts.push(seg);
  }
  const out = parts.join('/');
  byDir.set(rel, out);
  return out;
}

/** Whether `target` opens with a URI scheme, checked by hand. */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** One site's output tree: path -> text, exactly as the reference build's. */
export function run(input) {
  // Templates first, in name order; one that does not parse is reported.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      report.push(err.message);
    }
  }
  const renderTemplates = flattenedTemplates(templates);
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in path order; anything not Markdown is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push(f);
  }

  // Front matter and the refusal chain, in the reference's check order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    if (!fm.hasTitle) { report.push('refused ' + s.path + ': no title'); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout !== undefined && s.data.layout !== null ? s.data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }

  // Permalinks: slugs unique per directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug !== undefined && s.data.slug !== null ? s.data.slug : slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved against pages and static files.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const linkCache = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    let byDir = linkCache.get(dir);
    if (byDir === undefined) { byDir = new Map(); linkCache.set(dir, byDir); }
    const link = (target) => {
      const hit = byDir.get(target);
      if (hit !== undefined) {
        if (hit.broken) broken.add('broken-link ' + s.path + ' -> ' + target);
        return hit.href;
      }
      let href;
      let isBroken = false;
      if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) {
        href = target;
      } else {
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        const page = path === null ? undefined : bySource.get(path);
        if (page !== undefined) href = page.url + frag;
        else if (path !== null && staticPaths.has(path)) href = base + '/' + path + frag;
        else { href = target; isBroken = true; }
      }
      byDir.set(target, { href, broken: isBroken });
      if (isBroken) broken.add('broken-link ' + s.path + ' -> ' + target);
      return href;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const list = s.data.tags !== undefined && s.data.tags !== null ? s.data.tags : [];
    for (const name of list) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      const tag = bySlug.get(slug);
      return tag !== undefined ? tag : { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages as templates read them.
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined && s.data.date !== null ? s.data.date : '',
    date_long: s.data.date === undefined || s.data.date === null ? '' : longDate(s.data.date),
  });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined && s.data.date !== null ? s.data.date : '',
    date_long: s.data.date === undefined || s.data.date === null ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined && s.data.summary !== null ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => {
    const card = cards.get(s) !== undefined ? cards.get(s) : cardOf(s);
    return {
      title: card.title, url: card.url, date: card.date, date_long: card.date_long,
      summary: card.summary, excerpt: card.excerpt, reading_minutes: card.reading_minutes, tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer !== undefined ? s.newer : null),
      older: linkOf(s.older !== undefined ? s.older : null),
      is_post: s.post,
    };
  };

  // Layouts: pages, index pages, tag pages, the tags page, then statics.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = renderTemplates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: null }, renderTemplates, 0, out);
    return out.join('');
  };
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { site, tags: allTags, recent, page: pageOf(s) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      site, tags: allTags, recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { site, tags: allTags, recent, tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // The report: every reported line sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageTotal = 0;
  for (const s of kept) if (!s.post) pageTotal++;
  lines.push('built ' + pageTotal + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
