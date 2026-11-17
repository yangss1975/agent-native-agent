'use strict';
// naver-mail.js — 네이버 메일(IMAP) 읽기 전용. 의존성 없이 node:tls로 받은편지함의 최근 메일 머리와 앞부분만 가져온다.
// 메일함은 EXAMINE(읽기 전용)으로 열고 BODY.PEEK로 읽으므로 '읽음' 표시도 바뀌지 않는다.
//
// fetchRecent({ user, pass, host, port, sinceUid, uidValidity, days, max })
//   → { uidValidity, messages: [{ uid, messageId, from, subject, date, summary }] }

const tls = require('node:tls');

const CS_ALIAS = { 'ks_c_5601-1987': 'euc-kr', euc_kr: 'euc-kr', cp949: 'euc-kr', 'x-windows-949': 'euc-kr', 'unicode-1-1-utf-8': 'utf-8' };
const normCs = (c) => { c = String(c || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, ''); return CS_ALIAS[c] || c; };
function decodeBytes(buf, charset) { try { return new TextDecoder(normCs(charset)).decode(buf); } catch { return buf.toString('utf8'); } }
function qpBytes(s) {
  s = s.replace(/=\r?\n/g, ''); const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else out.push(s.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}
// 머리 값: 8비트 그대로 온 UTF-8을 풀고, =?charset?B|Q?…?= 부호화 단어를 푼다(RFC 2047)
function decodeHeader(v) {
  let s = String(v || '');
  if (/[\x80-\xff]/.test(s)) s = Buffer.from(s, 'latin1').toString('utf8');
  return s.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, txt) =>
      decodeBytes(enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : qpBytes(txt.replace(/_/g, ' ')), cs))
    .replace(/\s+/g, ' ').trim();
}
function parseHeaders(head) {
  const h = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':'); if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(); if (!(k in h)) h[k] = line.slice(i + 1).trim();
  }
  return h;
}
function splitPart(raw) {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? { h: parseHeaders(raw.slice(0, m.index)), body: raw.slice(m.index + m[0].length) } : { h: parseHeaders(raw), body: '' };
}
const param = (ct, n) => { const m = new RegExp(`;\\s*${n}\\s*=\\s*("([^"]*)"|[^;\\s]+)`, 'i').exec(ct || ''); return m ? (m[2] !== undefined ? m[2] : m[1]) : ''; };
function htmlToText(s) {
  return s.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
}
// 본문에서 읽을 글을 찾는다 — text/plain을 먼저, 없으면 text/html을 글로 바꿔서. raw는 바이트를 그대로 담은 latin1 문자열.
function findText(raw, depth = 0) {
  const { h, body } = splitPart(raw);
  const ct = h['content-type'] || 'text/plain', type = ct.split(';')[0].trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 6) {
    const b = param(ct, 'boundary'); if (!b) return null;
    let html = null;
    for (const p of body.split('--' + b).slice(1)) {
      if (p.startsWith('--')) break;
      const r = findText(p.replace(/^\r?\n/, ''), depth + 1);
      if (r && r.kind === 'plain') return r; if (r && !html) html = r;
    }
    return html;
  }
  if (type !== 'text/plain' && type !== 'text/html') return null;
  const enc = String(h['content-transfer-encoding'] || '').toLowerCase();
  const buf = enc.includes('base64') ? Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64') : enc.includes('quoted') ? qpBytes(body) : Buffer.from(body, 'latin1');
  const text = decodeBytes(buf, param(ct, 'charset'));
  return { kind: type === 'text/plain' ? 'plain' : 'html', text: type === 'text/html' ? htmlToText(text) : text };
}
function parseMessage(raw) {
  const { h } = splitPart(raw);
  const t = findText(raw);
  const summary = t ? t.text.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
  const d = new Date(h.date || '');
  return { messageId: (h['message-id'] || '').trim(), from: decodeHeader(h.from), subject: decodeHeader(h.subject), date: isNaN(d) ? '' : d.toISOString(), summary };
}

// ---- 아주 작은 IMAP 클라이언트(태그 명령 · 리터럴 {n} 처리) ----
function openImap({ host, port, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    let buf = '', waiter = null, greeted = false, seq = 0, scan = 0;
    const sock = tls.connect({ host, port, servername: host }, () => {});
    sock.setTimeout(timeoutMs, () => { sock.destroy(new Error('IMAP 응답 시간 초과')); });
    const fail = (e) => { if (waiter) { const w = waiter; waiter = null; w.reject(e); } else if (!greeted) reject(e); };
    sock.on('error', fail);
    sock.on('close', () => fail(new Error('IMAP 연결이 끊겼어요')));
    const pump = () => {
      if (!greeted) { const e = buf.indexOf('\r\n'); if (e < 0) return; const line = buf.slice(0, e); buf = buf.slice(e + 2); greeted = true;
        if (!/^\* (OK|PREAUTH)/i.test(line)) return reject(new Error('IMAP 인사 실패: ' + line)); return resolve(api); }
      if (!waiter) return;
      let pos = scan;
      for (;;) {
        const e = buf.indexOf('\r\n', pos); if (e < 0) { scan = pos; return; }
        const line = buf.slice(pos, e), lit = /\{(\d+)\}$/.exec(line);
        if (lit) { const end = e + 2 + Number(lit[1]); if (buf.length < end) { scan = pos; return; } pos = end; continue; }
        if (line.startsWith(waiter.tag + ' ')) {
          const out = buf.slice(0, e + 2); buf = buf.slice(e + 2); scan = 0;
          const w = waiter; waiter = null;
          if (/^\S+ OK/i.test(line)) w.resolve(out); else w.reject(Object.assign(new Error(line.replace(/^\S+ (NO|BAD)\s*/i, '') || line), { imap: line }));
          return;
        }
        pos = e + 2;
      }
    };
    sock.on('data', (d) => { buf += d.toString('latin1'); pump(); });
    const api = {
      cmd(text) {
        return new Promise((res, rej) => { const tag = 'A' + (++seq); waiter = { tag, resolve: res, reject: rej }; scan = 0; sock.write(`${tag} ${text}\r\n`); pump(); });
      },
      close() { try { sock.end(); } catch {} sock.destroy(); },
    };
  });
}
const q = (s) => '"' + String(s).replace(/[\\"]/g, '\\$&') + '"';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (d) => `${d.getDate()}-${MON[d.getMonth()]}-${d.getFullYear()}`;

// FETCH 응답에서 (UID, BODY[]<0> 리터럴)을 차례로 읽는다
function parseFetch(out) {
  const res = []; const re = /\* \d+ FETCH \(/g; let m;
  while ((m = re.exec(out))) {
    let pos = m.index + m[0].length; const msg = {};
    for (;;) {
      const e = out.indexOf('\r\n', pos); if (e < 0) break;
      const line = out.slice(pos, e);
      const u = /UID (\d+)/.exec(line); if (u) msg.uid = Number(u[1]);
      const lit = /BODY\[\](?:<0>)? \{(\d+)\}$/.exec(line);
      if (lit) { msg.raw = out.substr(e + 2, Number(lit[1])); pos = e + 2 + Number(lit[1]); continue; }
      const other = /\{(\d+)\}$/.exec(line); if (other) { pos = e + 2 + Number(other[1]); continue; }
      pos = e + 2; if (/\)\s*$/.test(line)) break;
    }
    if (msg.uid && msg.raw) res.push(msg);
    re.lastIndex = pos;
  }
  return res;
}

async function fetchRecent({ user, pass, host = 'imap.naver.com', port = 993, sinceUid = 0, uidValidity = 0, days = 7, max = 50 }) {
  if (!user || !pass) throw new Error('아이디와 비밀번호가 필요해요');
  const c = await openImap({ host, port });
  try {
    try { await c.cmd(`LOGIN ${q(user)} ${q(pass)}`); }
    catch (e) { throw new Error('로그인 실패 — 아이디·비밀번호(2단계 인증이면 애플리케이션 비밀번호)와 네이버 메일의 IMAP 사용 설정을 확인해 주세요. (' + e.message + ')'); }
    const ex = await c.cmd('EXAMINE INBOX');
    const uv = Number((/UIDVALIDITY (\d+)/i.exec(ex) || [])[1] || 0);
    const fresh = !sinceUid || (uidValidity && uv !== uidValidity);   // 처음이거나 메일함이 새로 만들어졌으면 최근 며칠 것만
    const since = new Date(Date.now() - days * 86400000);
    const sr = await c.cmd(fresh ? `UID SEARCH SINCE ${imapDate(since)}` : `UID SEARCH UID ${sinceUid + 1}:*`);
    const uids = ((/^\* SEARCH([\d ]*)$/m.exec(sr) || [])[1] || '').trim().split(/\s+/).filter(Boolean).map(Number)
      .filter((u) => fresh || u > sinceUid).sort((a, b) => a - b).slice(-max);
    if (!uids.length) return { uidValidity: uv, messages: [] };
    const out = await c.cmd(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[]<0.40000>)`);
    const messages = parseFetch(out).map((x) => ({ uid: x.uid, ...parseMessage(x.raw) }));
    try { await c.cmd('LOGOUT'); } catch {}
    return { uidValidity: uv, messages };
  } finally { c.close(); }
}

module.exports = { fetchRecent, parseMessage, decodeHeader, parseFetch };
