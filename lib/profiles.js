// User profiles: who's watching, each with their own watch progress and preferences.
// profiles.json holds the list; each profile's progress is its own file. The first profile ("main")
// keeps using progress.json, so watch history from before profiles existed carries over.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PROFILES = 8;
const COLORS = ['#b5523a', '#2f80ed', '#27ae60', '#f2c94c', '#9b51e0', '#f2994a', '#56ccf2', '#eb5757'];

function readJson(f, fallback) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } }
function writeJson(f, v) { const tmp = `${f}.tmp`; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, f); }
const hashPin = (salt, pin) => crypto.createHash('sha256').update(`${salt}:${pin}`).digest('hex');
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24);

class Profiles {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'profiles.json');
    this.data = readJson(this.file, null);
    if (!this.data || !Array.isArray(this.data.profiles) || !this.data.profiles.length) {
      this.data = { profiles: [{ id: 'main', name: 'Main', color: COLORS[0], kids: false }], last: 'main' };
      this.save();
    }
  }

  save() { fs.mkdirSync(this.dir, { recursive: true }); writeJson(this.file, this.data); }

  /** What the UI may see (never the PIN hash). */
  public(p) {
    if (!p) return null;
    return {
      id: p.id, name: p.name, color: p.color === '#e50914' ? '#b5523a' : p.color, kids: !!p.kids, maxLevel: p.maxLevel || 1,
      allowUnrated: !!p.allowUnrated, hasPin: !!p.pinHash, preferredLang: p.preferredLang || '', subLang: p.subLang || '',
      theme: ['2020s', 'heirloom'].includes(p.theme) ? p.theme : '', retroFx: !!p.retroFx,
      // picture: '' = the initial, 'char:<id>' = a character, 'photo' = their own photo (file path in photo)
      avatar: p.avatar === 'photo' && !(p.photo && fs.existsSync(p.photo)) ? '' : (p.avatar || ''),
      photo: p.avatar === 'photo' && p.photo && fs.existsSync(p.photo) ? p.photo : '',
    };
  }
  list() { return this.data.profiles.map((p) => this.public(p)); }
  /** The look of the app for this profile (Settings → Theme): no PIN needed, it's only how things look. */
  setTheme(id, theme, retroFx) {
    const p = this.get(id);
    if (!p) return false;
    if (theme != null) p.theme = ['2020s', 'heirloom'].includes(theme) ? theme : '2020s';
    if (retroFx != null) p.retroFx = !!retroFx;
    this.save();
    return true;
  }
  get(id) { return this.data.profiles.find((p) => p.id === id) || null; }
  last() { return this.get(this.data.last) || this.data.profiles[0]; }
  /** Ask "who's watching?" at start unless there's a single profile with no PIN. */
  needsPicker() { return this.data.profiles.length > 1 || !!this.data.profiles[0].pinHash; }
  setLast(id) { if (this.get(id)) { this.data.last = id; this.save(); } }

  progressFile(id) { return path.join(this.dir, id === 'main' ? 'progress.json' : `progress-${id}.json`); }
  loadProgress(id) { return readJson(this.progressFile(id), {}); }
  saveProgress(id, progress) { writeJson(this.progressFile(id), progress); }

  checkPin(id, pin) {
    const p = this.get(id);
    if (!p) return false;
    if (!p.pinHash) return true;
    const want = Buffer.from(p.pinHash, 'hex');
    const got = Buffer.from(hashPin(p.pinSalt, String(pin || '')), 'hex');
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  /** Create (no id) or update a profile. Returns { ok, profile } or { ok: false, error }. */
  upsert(input) {
    const name = cleanName(input.name);
    if (!name) return { ok: false, error: 'Give the profile a name.' };
    let p = input.id ? this.get(input.id) : null;
    if (input.id && !p) return { ok: false, error: 'Profile not found' };
    if (this.data.profiles.some((x) => x.name.toLowerCase() === name.toLowerCase() && (!p || x.id !== p.id))) {
      return { ok: false, error: 'There is already a profile with that name.' };
    }
    if (!p) {
      if (this.data.profiles.length >= MAX_PROFILES) return { ok: false, error: `Up to ${MAX_PROFILES} profiles.` };
      const used = new Set(this.data.profiles.map((x) => x.color));
      p = { id: crypto.randomBytes(4).toString('hex'), color: COLORS.find((c) => !used.has(c)) || COLORS[0] };
      this.data.profiles.push(p);
    }
    p.name = name;
    if (input.color && /^#[0-9a-f]{6}$/i.test(input.color)) p.color = input.color;
    if ('kids' in input) p.kids = !!input.kids;
    if ('maxLevel' in input) p.maxLevel = Math.min(3, Math.max(1, Number(input.maxLevel) || 1));
    if ('allowUnrated' in input) p.allowUnrated = !!input.allowUnrated;
    if ('preferredLang' in input) p.preferredLang = String(input.preferredLang || '').slice(0, 8);
    if ('subLang' in input) p.subLang = String(input.subLang || '').slice(0, 8);
    if ('avatar' in input) {
      const a = String(input.avatar || '');
      if (a === '' || /^char:[a-z]{2,20}$/.test(a)) p.avatar = a;
      else if (a === 'photo' && p.photo && fs.existsSync(p.photo)) p.avatar = 'photo';
    }
    this.save();
    return { ok: true, profile: this.public(p) };
  }

  /** A photo for a profile: bytes of a JPEG / PNG / WebP / GIF picture (kept in <data>/avatars). */
  setPhoto(id, bytes, ext) {
    const p = this.get(id);
    if (!p) return { ok: false, error: 'Profile not found' };
    if (!bytes || !bytes.length || bytes.length > 12 * 1024 * 1024) return { ok: false, error: 'That picture is too big.' };
    const e = String(ext || 'jpg').toLowerCase().replace('jpeg', 'jpg');
    if (!/^(jpg|png|webp|gif)$/.test(e)) return { ok: false, error: 'Use a JPEG, PNG or WebP picture.' };
    const dir = path.join(this.dir, 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}-${Date.now()}.${e}`);
    fs.writeFileSync(file, bytes);
    if (p.photo && p.photo !== file) { try { fs.unlinkSync(p.photo); } catch {} }
    p.photo = file; p.avatar = 'photo';
    this.save();
    return { ok: true, profile: this.public(p) };
  }

  setPin(id, pin) {
    const p = this.get(id);
    if (!p) return { ok: false, error: 'Profile not found' };
    if (pin === null || pin === '') { delete p.pinHash; delete p.pinSalt; this.save(); return { ok: true }; }
    if (!/^\d{4}$/.test(String(pin))) return { ok: false, error: 'A PIN is 4 digits.' };
    p.pinSalt = crypto.randomBytes(8).toString('hex');
    p.pinHash = hashPin(p.pinSalt, String(pin));
    this.save();
    return { ok: true };
  }

  remove(id) {
    if (this.data.profiles.length <= 1) return { ok: false, error: "You can't delete the only profile." };
    const i = this.data.profiles.findIndex((p) => p.id === id);
    if (i < 0) return { ok: false, error: 'Profile not found' };
    const gone = this.data.profiles[i];
    if (gone.photo) { try { fs.unlinkSync(gone.photo); } catch {} }
    this.data.profiles.splice(i, 1);
    if (this.data.last === id) this.data.last = this.data.profiles[0].id;
    this.save();
    try { if (id !== 'main') fs.unlinkSync(this.progressFile(id)); } catch {}
    return { ok: true };
  }
}

module.exports = { Profiles, MAX_PROFILES, COLORS };
