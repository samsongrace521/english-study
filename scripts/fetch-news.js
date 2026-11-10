// Daily news picker for the 「每日閱讀」 tab.
// Picks one new News in Levels (level 3, else 2) story, keeps only the title, a short
// teaser, the link and which of the 1000 TOEIC words appear in it. The article text
// itself is not stored — readers open the original page.
// Usage: node scripts/fetch-news.js [feed-file-for-testing]
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'news.json');
const FEED = 'https://www.newsinlevels.com/feed/';
const KEEP = 90;

const decode = s => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#8217;|&#039;|&rsquo;/g, "'").replace(/&#8216;|&lsquo;/g, "'")
  .replace(/&#8220;|&#8221;|&quot;|&ldquo;|&rdquo;/g, '"')
  .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—')
  .replace(/&#038;|&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const text = html => decode(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (item, name) => { const m = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? m[1] : '' };

function variants(w) {
  const v = new Set([w, w + 's', w + 'es', w + 'ed', w + 'd', w + 'ing', w + "'s"]);
  if (w.endsWith('e')) { v.add(w.slice(0, -1) + 'ing'); }
  if (/[^aeiou]y$/.test(w)) { v.add(w.slice(0, -1) + 'ies'); v.add(w.slice(0, -1) + 'ied'); }
  if (/[^aeiou][aeiou][bdgmnprt]$/.test(w)) { const c = w.slice(-1); v.add(w + c + 'ed'); v.add(w + c + 'ing'); }
  return v;
}

function buildIndex() {
  const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'words-min.json'), 'utf8'));
  const map = new Map(); // surface form -> [idx, isFamilyForm]
  words.forEach(([w, fam], i) => {
    for (const f of variants(w.toLowerCase())) if (!map.has(f)) map.set(f, [i, 0]);
  });
  words.forEach(([, fam], i) => {
    for (const x of fam) for (const f of [x, x + 's']) if (!map.has(f)) map.set(f, [i, 1]);
  });
  return map;
}

function matchWords(body, map) {
  const seen = new Map();
  for (const tok of body.toLowerCase().match(/[a-z][a-z'-]*/g) || []) {
    const hit = map.get(tok);
    if (hit && !seen.has(hit[0])) seen.set(hit[0], [hit[0], tok, hit[1]]);
  }
  return [...seen.values()];
}

function taipeiDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

function teaser(desc, title) {
  let t = text(desc.split('<p>The post')[0]).replace(/^\d{2}-\d{2}-\d{4} \d{2}:\d{2}\s*/, '').replace(/\.\.\.$|…$/, '');
  const sents = t.match(/[^.!?]+[.!?]/g) || [t];
  t = sents.slice(0, 2).join(' ').trim();
  return t.length > 260 ? t.slice(0, 257).replace(/\s\S*$/, '') + '…' : t;
}

async function main() {
  const xml = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8')
    : await (await fetch(FEED, { headers: { 'user-agent': 'toeic-study-page/1.0' } })).text();
  const items = (xml.match(/<item>[\s\S]*?<\/item>/g) || []).map(it => ({
    title: text(tag(it, 'title')),
    link: text(tag(it, 'link')),
    pub: text(tag(it, 'pubDate')),
    desc: tag(it, 'description'),
    body: text(tag(it, 'content:encoded')),
  })).filter(x => x.link);

  let archive = [];
  try { archive = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) {}
  const today = taipeiDate();
  if (archive.some(a => a.date === today)) { console.log('already have', today); return; }
  const used = new Set(archive.map(a => a.slug));
  const slug = x => x.title.replace(/\s*[–-]\s*level \d\s*$/i, '').toLowerCase();

  const pick = [3, 2].map(lv => items.find(x => new RegExp(`level ${lv}\\s*$`, 'i').test(x.title) && !used.has(slug(x))))
    .find(Boolean);
  if (!pick) { console.log('no new story'); return; }

  const map = buildIndex();
  const entry = {
    date: today,
    slug: slug(pick),
    title: pick.title,
    level: +(pick.title.match(/level (\d)/i) || [0, 0])[1],
    link: pick.link,
    source: 'News in Levels',
    published: new Date(pick.pub).toISOString().slice(0, 10),
    teaser: teaser(pick.desc, pick.title),
    words: matchWords(pick.title + ' ' + pick.body, map),
  };
  archive.unshift(entry);
  fs.writeFileSync(OUT, JSON.stringify(archive.slice(0, KEEP), null, 1) + '\n');
  console.log('added', entry.title, entry.words.length, 'words');
}

main().catch(e => { console.error(e); process.exit(1); });
