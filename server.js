// India news aggregator: RSS feeds -> translation (Tamil + English) -> National / Tamil Nadu -> web page.
// Run: node server.js   (Node 18+, no dependencies)
const http = require('http'), fs = require('fs'), path = require('path');
// Google News links can't be opened in the reader, so those feeds are skipped.
const sources = require('./sources.json').filter(s => !/^https?:\/\/news\.google\.com\//.test(s.url));
const PORT = process.env.PORT || 3000;
const FETCH_MS = (Number(process.env.FETCH_SECONDS) || 60) * 1000;
const TRANSLATE_TOP = Number(process.env.TRANSLATE_TOP) || 200; // newest stories to translate
let items = [];
const status = {};
const tcache = new Map(); // link -> { en:{title,summary}, ta:{title,summary} }

const clean = s => (s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const tag = (x, n) => { const m = x.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? m[1] : ''; };

function parse(xml, src) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.map(b => {
    const link = clean(tag(b, 'link')) || (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || clean(tag(b, 'guid'));
    const d = Date.parse(clean(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')));
    const sum = clean(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded'));
    return { title: clean(tag(b, 'title')), link, summary: (sum.includes(clean(tag(b, 'title')).slice(0, 40)) ? '' : sum).slice(0, 200), date: isNaN(d) ? Date.now() : Math.min(d, Date.now()),
             source: src.name, lang: src.lang, type: src.type, srcRegion: src.region || '', srcCategory: src.category || '' };
  }).filter(i => i.title && /^https?:/.test(i.link));
}

// ---- Tamil Nadu vs National ----
const TN_EN = /tamil\s?nadu|chennai|madurai|coimbatore|tiruchi|trichy|salem|tirunelveli|vellore|erode|tiruppur|thanjavur|kanniyakumari|kanyakumari|puducherry|\bdmk\b|aiadmk|\btvk\b/i;
const TN_TA = /தமிழ்நாடு|தமிழகம்|சென்னை|மதுரை|கோவை|கோயம்புத்தூர்|திருச்சி|சேலம்|நெல்லை|திருநெல்வேலி|வேலூர்|ஈரோடு|திருப்பூர்|தஞ்சை|தஞ்சாவூர்|கன்னியாகுமரி|புதுச்சேரி|திமுக|அதிமுக|தவெக/;
const regionOf = (i, tr) => (i.srcRegion === 'Tamil Nadu' || TN_EN.test(i.title + ' ' + i.summary + ' ' + (tr.en ? tr.en.title : '')) ||
  TN_TA.test(i.title + ' ' + i.summary)) ? 'Tamil Nadu' : 'National';

// ---- Translation (Google's free web endpoint; unofficial, may be rate-limited) ----
async function gt(text, to) {
  const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + to + '&dt=t&q=' + encodeURIComponent(text),
    { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return (await r.json())[0].map(s => s[0]).join('');
}
let translating = false;
async function translateNew() {
  if (translating) return; translating = true;
  try {
    const todo = [];
    for (const i of items.slice(0, TRANSLATE_TOP)) {
      const c = tcache.get(i.link) || {}; tcache.set(i.link, c);
      if (i.lang === 'en' || i.lang === 'ta') c[i.lang] = { title: i.title, summary: i.summary };
      for (const to of ['en', 'ta']) if (!c[to]) todo.push([i, c, to]);
    }
    let k = 0, errs = 0, done = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (k < todo.length && errs < 6) {
        const [i, c, to] = todo[k++];
        try { const [t, s] = await Promise.all([gt(i.title, to), i.summary ? gt(i.summary, to) : '']);
              c[to] = { title: t, summary: s }; done++; }
        catch (e) { errs++; if (errs === 1) console.warn('Translation problem:', e.message); }
      }
    }));
    if (done) console.log('Translated', done, 'texts');
    if (errs >= 6) console.warn('Translation paused after repeated errors; will retry next cycle.');
  } finally { translating = false; }
}


// ---- Categories (keyword based) ----
const CATS = [
  ['Sports', /cricket|football|\bipl\b|hockey|tennis|olympic|badminton|kabaddi|\bfifa\b|\bbcci\b|world cup|கிரிக்கெட்|கால்பந்து|விளையாட்டு|ஐபிஎல்/i],
  ['Entertainment', /\bfilm\b|movie|\bactor|actress|cinema|box office|trailer|\bott\b|web series|bollywood|kollywood|singer|திரைப்படம்|சினிமா|நடிகர்|நடிகை/i],
  ['Business', /sensex|nifty|\brbi\b|\bstocks?\b|share market|economy|\bgst\b|rupee|inflation|\bipo\b|\bbank|gold price|petrol|diesel|budget|பங்குச்சந்தை|சென்செக்ஸ்|வர்த்தகம்|பொருளாதாரம்|தங்கம்|ரூபாய்|வங்கி/i],
  ['Weather', /\bweather\b|\brain(s|fall|y)?\b|monsoon|cyclone|heat ?wave|\bflood|\bstorm|\bimd\b|forecast|red alert|orange alert|temperature|depression over|வானிலை|மழை|புயல்|வெள்ளம்|வெப்ப|காற்றழுத்த|பருவமழை/i],
  ['Health', /\bhealth|medical|hospital|\bdoctors?\b|\bdisease|vaccin|dengue|covid|cancer|\bicmr\b|\baiims\b|virus|surgery|\bpatients?\b|outbreak|fever|மருத்துவ|சுகாதார|நோய்|டெங்கு|தடுப்பூசி|காய்ச்சல்|புற்றுநோய்/i],
  ['Politics', /election|minister|\bbjp\b|congress|parliament|\bmla\b|lok sabha|assembly|\bdmk\b|aiadmk|\bcm\b|rally|\bpolls?\b|government|govt|அரசியல்|தேர்தல்|அமைச்சர்|முதல்வர்|எம்எல்ஏ|பாஜக|காங்கிரஸ்|திமுக|அதிமுக|அரசு/i]
];
const categoryOf = (i, tr) => { if (i.srcCategory) return i.srcCategory; const t = i.title + ' ' + i.summary + ' ' + (tr.en ? tr.en.title : '');
  for (const [name, re] of CATS) if (re.test(t)) return name; return 'General'; };

// ---- Full article reader: fetch page, extract paragraphs, translate ----
function chunks(text, max = 300) {
  const out = []; let cur = '';
  for (const s of text.split(/(?<=[.!?।])\s+/)) {
    if ((cur + ' ' + s).length > max && cur) { out.push(cur); cur = ''; }
    if (s.length > max) { for (let k = 0; k < s.length; k += max) out.push(s.slice(k, k + max)); }
    else cur = cur ? cur + ' ' + s : s;
  }
  if (cur) out.push(cur); return out;
}
async function translateLong(text, to) { const parts = []; for (const c of chunks(text)) parts.push(await gt(c, to)); return parts.join(' '); }
function extract(html) {
  html = html.replace(/<(script|style|noscript|nav|header|footer|aside|form|figure|svg|iframe)[\s\S]*?<\/\1>/gi, '');
  const pick = scope => { const seen = new Set();
    return [...scope.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)].map(m => clean(m[0])).filter(p => p.length > 60 && !seen.has(p) && seen.add(p)).slice(0, 40); };
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  let ps = art ? pick(art[0]) : [];
  if (ps.length < 2) ps = pick(html);
  return ps;
}
const acache = new Map();
async function articleFor(link, to) {
  const key = link + '|' + to; if (acache.has(key)) return acache.get(key);
  const it = items.find(x => x.link === link); if (!it) throw new Error('Unknown article');
  const r = await fetch(link, { signal: AbortSignal.timeout(12000), redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IndiaNewsReader/1.0', 'Accept-Language': 'en,ta;q=0.8' } });
  if (!r.ok) throw new Error('The news site returned HTTP ' + r.status);
  let ps = extract(await r.text());
  const out = { paragraphs: ps, translated: false, from: it.lang };
  if (ps.length >= 2 && it.lang !== to) {
    let k = 0, failed = 0;
    await Promise.all(Array.from({ length: 4 }, async () => { while (k < ps.length) { const n = k++;
      try { ps[n] = await translateLong(ps[n], to); } catch { failed++; } } }));
    out.translated = failed < ps.length;
  }
  if (ps.length < 2) out.paragraphs = [];
  acache.set(key, out); if (acache.size > 60) acache.delete(acache.keys().next().value);
  return out;
}

async function refresh() {
  const results = await Promise.allSettled(sources.map(async s => {
    const r = await fetch(s.url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 IndiaNewsReader/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return parse(await r.text(), s);
  }));
  const map = new Map(items.map(i => [i.link, i]));
  results.forEach((r, k) => {
    const s = sources[k];
    if (r.status === 'fulfilled') { r.value.forEach(i => map.set(i.link, i)); status[s.name] = { ok: true, count: r.value.length }; }
    else { status[s.name] = { ok: false, error: String(r.reason.message || r.reason) }; console.warn('Feed failed:', s.name, '-', status[s.name].error); }
  });
  const cutoff = Date.now() - 48 * 3600e3;
  items = [...map.values()].filter(i => i.date > cutoff).sort((a, b) => b.date - a.date).slice(0, 600);
  const keep = new Set(items.map(i => i.link));
  for (const k of tcache.keys()) if (!keep.has(k)) tcache.delete(k);
  console.log(new Date().toLocaleTimeString(), items.length, 'items');
  translateNew();
}
refresh(); setInterval(refresh, FETCH_MS);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/news') {
    const out = items.map(i => { const tr = tcache.get(i.link) || {}; return { ...i, region: regionOf(i, tr), category: categoryOf(i, tr), tr }; });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ updated: Date.now(), items: out, status }));
  }
  if (url.pathname === '/api/article') {
    const send = o => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    return articleFor(url.searchParams.get('url') || '', url.searchParams.get('to') === 'en' ? 'en' : 'ta')
      .then(send).catch(e => send({ paragraphs: [], error: String(e.message || e) }));
  }
  const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); res.end(data);
  });
}).listen(PORT, () => console.log('Open http://localhost:' + PORT));
