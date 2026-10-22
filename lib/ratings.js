// Star ratings, shared by everyone in the house (ratings.json): { "<title key>": { "<profile id>": { stars, at } } }.
// A title key is the same for every copy of a film (DVD / Blu-ray / 4K) and for a whole TV series,
// so a rating sticks to the title, not to one file (see MediaCore.ratingKey).
const fs = require('fs');
const path = require('path');

class Ratings {
  constructor(dir) {
    this.file = path.join(dir, 'ratings.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {}; } catch { this.data = {}; }
  }
  save() { const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(this.data)); fs.renameSync(tmp, this.file); }
  all() { return this.data; }
  /** stars 1–5, or 0 to take the rating back. */
  set(key, pid, stars) {
    key = String(key || '').slice(0, 300);
    const n = Math.round(Number(stars) || 0);
    if (!key || !pid || n < 0 || n > 5) return false;
    if (!this.data[key]) this.data[key] = {};
    if (n) this.data[key][pid] = { stars: n, at: Date.now() };
    else delete this.data[key][pid];
    if (!Object.keys(this.data[key]).length) delete this.data[key];
    this.save();
    return true;
  }
  forget(pid) {
    for (const k of Object.keys(this.data)) { delete this.data[k][pid]; if (!Object.keys(this.data[k]).length) delete this.data[k]; }
    this.save();
  }
}

module.exports = { Ratings };
