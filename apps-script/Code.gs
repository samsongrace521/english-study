/**
 * 多益千字六十天：家庭學習紀錄後端（Google 試算表 + Apps Script）
 *
 * 安裝方式：
 *   1. 建立一份新的 Google 試算表
 *   2. 「擴充功能」→「Apps Script」，刪掉原本的內容，貼上這整份程式
 *   3. 把下面的 FAMILY_CODE 改成你自己的家庭代碼（只給家人）
 *   4. 「部署」→「新增部署作業」→ 類型選「網頁應用程式」
 *      執行身分：我；誰可以存取：所有人 → 部署 → 同意授權
 *   5. 把產生的網址（https://script.google.com/macros/s/.../exec）貼回網站設定
 *
 * 試算表會自動產生：
 *   「總覽」：每位家人的進度摘要
 *   「紀錄-名字」：每個人的每日練習與測驗紀錄
 *   「_data」：網站用的進度資料（請勿手動修改）
 */
const FAMILY_CODE = '請改成你的家庭代碼';

const DATA = '_data';
const CHUNK = 45000; // 每格上限 50,000 字，分段存

function doGet(e) { return handle_(e.parameter || {}); }
function doPost(e) {
  let p = {};
  try { p = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad_json' }); }
  return handle_(p);
}

function handle_(p) {
  if (!FAMILY_CODE || FAMILY_CODE.indexOf('請改成') === 0) return out_({ ok: false, error: 'not_configured' });
  if (String(p.code || '') !== FAMILY_CODE) return out_({ ok: false, error: 'bad_code' });
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (p.action === 'profiles') return out_({ ok: true, profiles: listProfiles_() });
    const name = cleanName_(p.name);
    if (!name) return out_({ ok: false, error: 'bad_name' });
    if (p.action === 'get') return out_({ ok: true, state: readState_(name) });
    if (p.action === 'save') {
      const state = typeof p.state === 'string' ? JSON.parse(p.state) : p.state;
      if (!state || state.v !== 1) return out_({ ok: false, error: 'bad_state' });
      const cur = readState_(name);
      if (cur && (cur.updatedAt || 0) > (state.updatedAt || 0)) return out_({ ok: true, newer: true, state: cur });
      writeState_(name, state);
      writeRecord_(name, state);
      writeOverview_();
      return out_({ ok: true });
    }
    return out_({ ok: false, error: 'bad_action' });
  } finally { lock.releaseLock(); }
}

function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function cleanName_(n) { return String(n || '').replace(/[\[\]\*\?\/\\:]/g, '').trim().slice(0, 20); }
function sheet_(name) { const ss = SpreadsheetApp.getActive(); return ss.getSheetByName(name) || ss.insertSheet(name); }

function dataRows_() {
  const sh = sheet_(DATA);
  if (sh.getLastRow() === 0) sh.appendRow(['name', 'updatedAt', 'state…']);
  return sh;
}
function listProfiles_() {
  const sh = dataRows_(), n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, 2).getValues().filter(r => r[0]).map(r => ({ name: String(r[0]), updatedAt: Number(r[1]) || 0 }));
}
function findRow_(sh, name) {
  const n = sh.getLastRow();
  if (n < 2) return 0;
  const names = sh.getRange(2, 1, n - 1, 1).getValues();
  for (let i = 0; i < names.length; i++) if (String(names[i][0]) === name) return i + 2;
  return 0;
}
function readState_(name) {
  const sh = dataRows_(), r = findRow_(sh, name);
  if (!r) return null;
  const cols = sh.getLastColumn();
  const vals = sh.getRange(r, 3, 1, Math.max(1, cols - 2)).getValues()[0];
  const json = vals.map(String).join('');
  try { return json ? JSON.parse(json) : null; } catch (err) { return null; }
}
function writeState_(name, state) {
  const sh = dataRows_();
  let r = findRow_(sh, name);
  if (!r) { r = sh.getLastRow() + 1; }
  const json = JSON.stringify(state), parts = [];
  for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
  const cols = sh.getLastColumn();
  if (cols > 2) sh.getRange(r, 3, 1, cols - 2).clearContent();
  sh.getRange(r, 1, 1, 2 + parts.length).setNumberFormat('@').setValues([[name, String(state.updatedAt || Date.now())].concat(parts)]);
}

function stats_(s) {
  let learned = 0, mastered = 0;
  Object.keys(s.w || {}).forEach(k => { learned++; if (+String(s.w[k]).split(':')[0] >= 4) mastered++; });
  const days = Object.keys(s.log || {}).map(k => s.log[k]);
  const dates = {}; days.forEach(d => { dates[d.date] = (dates[d.date] || 0) + (d.sec || 0); });
  const last = (s.tests || []).slice(-1)[0];
  return { learned, mastered, practiced: Object.keys(dates).length, minutes: Math.round(days.reduce((a, d) => a + (d.sec || 0), 0) / 60),
    lastDate: Object.keys(dates).sort().pop() || '', lastTest: last ? last.label + ' ' + Math.round(last.score / last.total * 100) + ' 分' : '' };
}
function writeRecord_(name, s) {
  const sh = sheet_('紀錄-' + name);
  sh.clear();
  const rows = [['日期', '項目', '分鐘', '分數', '答對/題數']];
  Object.keys(s.log || {}).forEach(k => { const d = s.log[k]; rows.push([d.date, '第 ' + k.slice(1) + ' 天進度', Math.round((d.sec || 0) / 60), '', '']); });
  (s.tests || []).forEach(t => rows.push([t.date, t.label, '', Math.round(t.score / t.total * 100), t.score + '/' + t.total]));
  const body = rows.slice(1).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  sh.getRange(1, 1, body.length + 1, 5).setValues([rows[0]].concat(body));
  sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  sh.setFrozenRows(1);
}
function writeOverview_() {
  const sh = sheet_('總覽');
  sh.clear();
  const rows = [['家人', '目前第幾天', '開始日期', '已學單字', '熟記單字', '練習天數', '累計分鐘', '最近練習', '最近測驗', '最後同步']];
  listProfiles_().forEach(p => {
    const s = readState_(p.name); if (!s) return;
    const st = stats_(s);
    rows.push([p.name, Math.min(s.day - 1, 60), s.start || '', st.learned, st.mastered, st.practiced, st.minutes, st.lastDate, st.lastTest,
      Utilities.formatDate(new Date(p.updatedAt), 'Asia/Taipei', 'yyyy/MM/dd HH:mm')]);
  });
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
  const ss = SpreadsheetApp.getActive(); ss.setActiveSheet(sh); ss.moveActiveSheet(1);
}
