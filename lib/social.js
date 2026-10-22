// "Recommend to…": suggestions one profile sends another (recommendations.json).
// [{ id, from, to, key, kind: 'movie'|'series'|'album', name, at }]
// key: the title key (MediaCore.ratingKey) for films and series, the album key for music.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = new Set(['movie', 'series', 'album']);

class Recommendations {
  constructor(dir) {
    this.file = path.join(dir, 'recommendations.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = []; }
    if (!Array.isArray(this.data)) this.data = [];
  }
  save() { const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.data)); fs.renameSync(tmp, this.file); }
  all() { return this.data; }
  /** Send one title to several profiles. Sending the same thing to the same person again just moves it to the front. */
  add(from, toList, item) {
    const key = String(item && item.key || '').slice(0, 300);
    const kind = String(item && item.kind || '');
    if (!from || !key || !KINDS.has(kind)) return false;
    const name = String(item.name || '').slice(0, 120);
    for (const to of [...new Set(toList || [])]) {
      if (!to || to === from) continue;
      this.data = this.data.filter((r) => !(r.from === from && r.to === to && r.key === key));
      this.data.push({ id: crypto.randomBytes(6).toString('hex'), from, to, key, kind, name, at: Date.now() });
    }
    if (this.data.length > 600) this.data = this.data.slice(-600);
    this.save();
    return true;
  }
  /** The person it was sent to can clear it. */
  dismiss(id, pid) {
    const n = this.data.length;
    this.data = this.data.filter((r) => !(r.id === id && r.to === pid));
    if (this.data.length !== n) this.save();
  }
  forget(pid) { this.data = this.data.filter((r) => r.from !== pid && r.to !== pid); this.save(); }
}

module.exports = { Recommendations };
