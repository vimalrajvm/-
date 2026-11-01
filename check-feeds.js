// Tests every feed on this PC.   node check-feeds.js            -> report only
//                                node check-feeds.js --apply    -> also add working candidates to sources.json
const fs = require('fs');
const sources = JSON.parse(fs.readFileSync(__dirname + '/sources.json', 'utf8'));
const cands = fs.existsSync(__dirname + '/candidates.json') ? JSON.parse(fs.readFileSync(__dirname + '/candidates.json', 'utf8')) : [];
const apply = process.argv.includes('--apply');
async function test(s) {
  try {
    const r = await fetch(s.url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0 IndiaNewsReader/1.0' } });
    if (!r.ok) return { ok: false, msg: 'HTTP ' + r.status };
    const n = ((await r.text()).match(/<(item|entry)[\s>]/gi) || []).length;
    return n ? { ok: true, msg: n + ' stories' } : { ok: false, msg: 'no stories found' };
  } catch (e) { return { ok: false, msg: 'failed (' + ((e.cause && e.cause.code) || e.message) + ')' }; }
}
(async () => {
  console.log('Current sources:');
  for (const s of sources) { const t = await test(s); console.log((t.ok ? '  OK    ' : '  FAIL  ') + s.name + ' - ' + t.msg); }
  if (!cands.length) return;
  console.log('\nExtra candidates:');
  const have = new Set(sources.map(s => s.url)); let added = 0;
  for (const c of cands) {
    if (have.has(c.url)) continue;
    const t = await test(c); console.log((t.ok ? '  OK    ' : '  FAIL  ') + c.name + ' - ' + t.msg);
    if (t.ok && apply) { sources.push(c); added++; }
  }
  if (apply) { fs.writeFileSync(__dirname + '/sources.json', '[\n' + sources.map(s => '  ' + JSON.stringify(s)).join(',\n') + '\n]\n');
    console.log('\nAdded ' + added + ' working feeds to sources.json. Restart the server to use them.'); }
  else console.log('\nRun "node check-feeds.js --apply" to add the working ones.');
})();
