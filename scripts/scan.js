// CLI helper: node scripts/scan.js <folder> [dataDir]  — prints what the scanner finds.
const path = require('path');
const os = require('os');
const { scan } = require('../lib/library');

(async () => {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node scripts/scan.js <folder> [dataDir]'); process.exit(1); }
  const dataDir = process.argv[3] || path.join(os.tmpdir(), 'screenroom-scan');
  const items = await scan({ dirs: [dir], dataDir, onProgress: (p) => p.error && console.error(p.error) });
  for (const i of items) {
    const v = i.video || {};
    console.log(`${i.title} (${i.year || '?'}) — ${v.codec} ${v.res} ${v.hdr}`.trim());
    console.log(`   genres: ${i.genres.join(', ') || '-'}   art: ${i.art ? 'yes' : 'no'}`);
    for (const a of i.audio) console.log(`   audio ${a.n}: ${a.label} ${a.layout} ${a.lang}`);
  }
})();
