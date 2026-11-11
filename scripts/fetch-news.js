// Daily news picker for the 「每日閱讀」 tab.
// 1st choice: a Taipei Times bilingual (中英對照) article from the last two days that reads
//             like a news story and suits a learner; scored by length, sentence length,
//             topic and how many of the 1000 TOEIC words it uses.
// Fallback:   the newest News in Levels level-3 story.
// Only the title, a short teaser, the link and the matched word list are stored — never
// the article text, which stays on the publisher's site.
// Usage: node scripts/fetch-news.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'news.json');
const KEEP = 90;
const UA = { headers: { 'user-agent': 'Mozilla/5.0 (personal study page)' } };

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#8217;|&#039;|&rsquo;/g, "'").replace(/&#8216;|&lsquo;/g, "'")
  .replace(/&#8220;|&#8221;|&quot;|&ldquo;|&rdquo;/g, '"')
  .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—')
  .replace(/&#038;|&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const text = html => decode(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (item, name) => { const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? m[1] : '' };
const CJK = /[㐀-鿿]/;
const get = async u => { const r = await fetch(u, UA); if (!r.ok) throw new Error(u + ' ' + r.status); return r.text() };

function variants(w) {
  const v = new Set([w, w + 's', w + 'es', w + 'ed', w + 'd', w + 'ing', w + "'s"]);
  if (w.endsWith('e')) v.add(w.slice(0, -1) + 'ing');
  if (/[^aeiou]y$/.test(w)) { v.add(w.slice(0, -1) + 'ies'); v.add(w.slice(0, -1) + 'ied'); }
  if (/[^aeiou][aeiou][bdgmnprt]$/.test(w)) { const c = w.slice(-1); v.add(w + c + 'ed'); v.add(w + c + 'ing'); }
  return v;
}
let MAP = null;
function wordMap() {
  if (MAP) return MAP;
  const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'words-min.json'), 'utf8'));
  MAP = new Map();
  words.forEach(([w], i) => { for (const f of variants(w.toLowerCase())) if (!MAP.has(f)) MAP.set(f, [i, 0]); });
  words.forEach(([, fam], i) => { for (const x of fam) for (const f of [x, x + 's']) if (!MAP.has(f)) MAP.set(f, [i, 1]); });
  return MAP;
}
function matchWords(body) {
  const seen = new Map();
  for (const tok of body.replace(/[’‘]/g, "'").toLowerCase().match(/[a-z][a-z'-]*/g) || []) {
    const hit = wordMap().get(tok);
    if (hit && !seen.has(hit[0])) seen.set(hit[0], [hit[0], tok, hit[1]]);
  }
  return [...seen.values()];
}
const taipeiDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
function teaser(t) {
  const sents = t.match(/[^.!?]+[.!?]+["”’]?/g) || [t];
  t = sents.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
  return t.length > 280 ? t.slice(0, 277).replace(/\s\S*$/, '') + '…' : t;
}

/* ---------- Taipei Times bilingual ---------- */
const SKIP_TITLE = /輕鬆華語|華語|BOOKMAN|雙語書林|Bilingual Quiz|測驗|Crossword|Word of the|Sentence|句型|發音|片語|俚語|Idiom/i;
const HEAVY = /\b(war|wars|killed|kills|dead|death|deaths|bomb|attack|attacks|missile|military|troops|shooting|murder|terror)\b/gi;

async function taipeiTimes(used) {
  const html = await get('https://www.taipeitimes.com/News/lang');
  const okDates = new Set([taipeiDate(), taipeiDate(new Date(Date.now() - 864e5))]);
  const links = [...new Set([...html.matchAll(/https:\/\/www\.taipeitimes\.com\/News\/lang\/archives\/(\d{4})\/(\d{2})\/(\d{2})\/\d+/g)]
    .filter(m => okDates.has(`${m[1]}-${m[2]}-${m[3]}`)).map(m => m[0]))].filter(u => !used.has(u));
  const cands = [];
  for (const link of links) {
    try {
      const page = await get(link);
      let title = text((page.match(/<title>([\s\S]*?)<\/title>/) || [, ''])[1]).replace(/\s*-\s*Taipei Times\s*$/, '');
      if (SKIP_TITLE.test(title)) { console.log('skip column:', title); continue; }
      // column pages (e.g. ENGLISH DIGEST) put the real headline in an <h3> right after the <h1>
      const sub = page.match(/<h1>[^<]+<\/h1>\s*<h3>([\s\S]*?)<\/h3>/);
      if (sub && text(sub[1]).length > 10) title = text(sub[1]);
      const ps = [...page.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m => text(m[1])).filter(Boolean);
      // the English story: paragraphs before the first long Chinese paragraph, without photo credits
      const firstZh = ps.findIndex(p => CJK.test(p) && !/^Photo/i.test(p) && p.replace(/[^㐀-鿿]/g, '').length > 30);
      const en = ps.slice(0, firstZh < 0 ? ps.length : firstZh).filter(p => !CJK.test(p) && p.split(/\s+/).length >= 6);
      const body = en.join(' ');
      const nWords = (body.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
      if (en.length < 4 || nWords < 200) { console.log('skip short/non-news:', title, nWords); continue; }
      const sents = body.match(/[^.!?]+[.!?]+/g) || [body];
      const avg = nWords / sents.length;
      const words = matchWords(title + ' ' + body);
      const heavy = (body.match(HEAVY) || []).length;
      // higher is better
      let score = words.length * 2;
      if (nWords > 900) score -= (nWords - 900) / 25;
      if (nWords < 300) score -= (300 - nWords) / 10;
      if (avg > 22) score -= (avg - 22) * 4;
      score -= heavy * 3;
      const m = title.match(/^(.*?)\s+([^A-Za-z]*[㐀-鿿].*)$/);
      cands.push({ link, title: (m ? m[1] : title).trim(), titleZh: m ? m[2].trim() : '', body, words, nWords, avg: +avg.toFixed(1), score: +score.toFixed(1),
        published: (page.match(/article:published_time" content="(\d{4}-\d{2}-\d{2})/) || [, ''])[1] });
      console.log('candidate:', title, { nWords, avg: avg.toFixed(1), toeic: words.length, heavy, score: score.toFixed(1) });
    } catch (e) { console.log('error', link, e.message); }
  }
  cands.sort((a, b) => b.score - a.score);
  const c = cands[0];
  if (!c) return null;
  return { slug: c.link, source: 'Taipei Times 中英對照', title: c.title, titleZh: c.titleZh, level: 0, link: c.link,
    published: c.published, teaser: teaser(c.body), words: c.words, stats: { words: c.nWords, avgSentence: c.avg } };
}

/* ---------- News in Levels fallback ---------- */
async function newsInLevels(used) {
  const xml = await get('https://www.newsinlevels.com/feed/');
  const items = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map(it => ({
    title: text(tag(it, 'title')), link: text(tag(it, 'link')), pub: text(tag(it, 'pubDate')),
    desc: tag(it, 'description'), body: text(tag(it, 'content:encoded')) })).filter(x => x.link);
  const slug = x => x.title.replace(/\s*[–-]\s*level \d\s*$/i, '').toLowerCase();
  const pick = [3, 2].map(lv => items.find(x => new RegExp(`level ${lv}\\s*$`, 'i').test(x.title) && !used.has(slug(x)))).find(Boolean);
  if (!pick) return null;
  const t = text(pick.desc.split('<p>The post')[0]).replace(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}\s*/, '').replace(/\.\.\.$|…$/, '');
  return { slug: slug(pick), source: 'News in Levels', title: pick.title.replace(/\s*[–-]\s*level \d\s*$/i, ''), titleZh: '',
    level: +(pick.title.match(/level (\d)/i) || [0, 0])[1], link: pick.link, published: new Date(pick.pub).toISOString().slice(0, 10),
    teaser: teaser(t), words: matchWords(pick.title + ' ' + pick.body) };
}

async function main() {
  let archive = [];
  try { archive = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const today = taipeiDate();
  const force = process.argv.includes('--force');
  if (archive.some(a => a.date === today && a.source !== 'News in Levels') && !force) { console.log('already have', today); return; }
  archive = archive.filter(a => a.date !== today);
  const used = new Set(archive.map(a => a.slug));
  let entry = null;
  try { entry = await taipeiTimes(used); } catch (e) { console.log('Taipei Times failed:', e.message); }
  if (!entry) { try { entry = await newsInLevels(used); } catch (e) { console.log('News in Levels failed:', e.message); } }
  if (!entry) { console.log('no new story'); return; }
  archive.unshift({ date: today, ...entry });
  fs.writeFileSync(OUT, JSON.stringify(archive.slice(0, KEEP), null, 1) + '\n');
  console.log('added', entry.source, entry.title, entry.words.length, 'words');
}

main().catch(e => { console.error(e); process.exit(1); });
