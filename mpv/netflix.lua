-- Screenroom: Netflix-style on-screen controller for mpv.
-- Replaces the stock OSC. Loaded with:  mpv --osc=no --script=netflix.lua
-- Options (via --script-opts): netflix-meta=<json file>, netflix-font=<name>, netflix-accent=<RRGGBB>
local mp = require 'mp'
local utils = require 'mp.utils'
local options = require 'mp.options'

local o = { meta = '', font = '', accent = 'E50914' }
options.read_options(o, 'netflix')

-- ---------------------------------------------------------------- constants
local HIDE_AFTER = 3.2     -- seconds of inactivity before controls fade
local SKIP = 10            -- seconds for skip buttons / arrow keys
local NEXT_CARD_AT = 30    -- seconds before the end that the "Next Episode" card appears
local MARGIN = 80

local function bgr(hex) return hex:sub(5, 6) .. hex:sub(3, 4) .. hex:sub(1, 2) end
local ACCENT = bgr(o.accent)
local WHITE, GRAY, BLACK, PANEL = 'FFFFFF', 'B3B3B3', '000000', '181818'
local FONT = (o.font ~= '') and ('\\fn' .. o.font) or ''

-- ---------------------------------------------------------------- state
local W, H = 1920, 1080     -- virtual ASS canvas (height fixed at 1080, width follows window aspect)
local osd_w, osd_h = 1280, 720
local S = {
  pos = 0, dur = 0, paused = false, vol = 100, mute = false, fs = false,
  loaded = false, last_act = 0, fade = 0, pfade = 0, last_tick = 0, pause_t = nil,
  mx = -1, my = -1, drag = nil, scrub = nil,
  menu = false, col = 1, row = 1,
  toast = nil, toast_until = 0,
  next_dismissed = false, pref_audio = nil, pref_sub = nil,
}
local meta = {}
local lines, hits = {}, {}
local blank_sent = false

local function now() return mp.get_time() end
local function clamp(v, a, b) return math.max(a, math.min(b, v)) end

-- ---------------------------------------------------------------- metadata
if o.meta ~= '' then
  local f = io.open(o.meta, 'r')
  if f then
    local txt = f:read('*a'); f:close()
    meta = utils.parse_json(txt) or {}
  end
end

local function meta_for(path)
  local m = path and meta[path]
  if m then return m end
  return { title = mp.get_property('media-title') or '', sub = '', name = '', desc = '' }
end

local function playlist_info()
  local pl = mp.get_property_native('playlist') or {}
  local cur = 0
  for i, e in ipairs(pl) do if e.current then cur = i end end
  local nxt = pl[cur + 1]
  return { count = #pl, cur = cur, next = nxt and meta_for(nxt.filename) or nil }
end

-- ---------------------------------------------------------------- ASS helpers
local function alpha(op)
  local a = 255 - math.floor(clamp(op, 0, 1) * 255 + 0.5)
  return string.format('&H%02X&', a)
end

local function add(s) lines[#lines + 1] = s end

local function shape(path, color, op, extra)
  if op <= 0.003 then return end
  add(string.format('{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H%s&\\1a%s%s\\p1}%s{\\p0}', color, alpha(op), extra or '', path))
end

local function rect(x, y, w, h) return string.format('m %.1f %.1f l %.1f %.1f l %.1f %.1f l %.1f %.1f', x, y, x + w, y, x + w, y + h, x, y + h) end

local function poly(pts)
  local t = {}
  for i, p in ipairs(pts) do t[#t + 1] = string.format('%s %.1f %.1f', i == 1 and 'm' or 'l', p[1], p[2]) end
  return table.concat(t, ' ')
end

local function circle(cx, cy, r)
  local pts = {}
  for i = 0, 27 do
    local a = i / 28 * 2 * math.pi
    pts[#pts + 1] = { cx + r * math.cos(a), cy + r * math.sin(a) }
  end
  return poly(pts)
end

local function esc(s) return (tostring(s or ''):gsub('[\\{}]', ''):gsub('\n', ' ')) end

local function text(x, y, str, fs, color, op, an, bold, extra)
  if op <= 0.003 or str == '' then return end
  add(string.format('{\\an%d\\pos(%.1f,%.1f)%s\\fs%d\\bord0\\shad1\\4c&H000000&\\4a&H90&\\1c&H%s&\\1a%s\\b%d%s}%s',
    an or 7, x, y, FONT, fs, color or WHITE, alpha(op), bold and 1 or 0, extra or '', esc(str)))
end

local function gradient(y0, y1, op0, op1, k)
  local n = 22
  local hh = (y1 - y0) / n
  for i = 0, n - 1 do
    local f = (i + 0.5) / n
    shape(rect(0, y0 + i * hh, W, hh + 1.5), BLACK, (op0 + (op1 - op0) * f) * k)
  end
end

local function trunc(s, n)
  s = tostring(s or '')
  if #s <= n then return s end
  return s:sub(1, math.max(1, n - 1)) .. '…'
end

local function wrap(s, maxc, maxlines)
  local out, cur = {}, ''
  for word in tostring(s or ''):gmatch('%S+') do
    if #cur + #word + 1 > maxc and cur ~= '' then
      out[#out + 1] = cur; cur = word
      if #out == maxlines then break end
    else
      cur = (cur == '') and word or (cur .. ' ' .. word)
    end
  end
  if #out < maxlines and cur ~= '' then out[#out + 1] = cur end
  if #out == maxlines and #(table.concat(out, ' ')) < #tostring(s or '') then
    out[#out] = trunc(out[#out], maxc - 1) .. (out[#out]:sub(-1) == '…' and '' or '…')
  end
  return out
end

local function fmt_time(t)
  t = math.max(0, math.floor(t or 0))
  local h, m, s = math.floor(t / 3600), math.floor(t % 3600 / 60), t % 60
  if h > 0 then return string.format('%d:%02d:%02d', h, m, s) end
  return string.format('%d:%02d', m, s)
end

-- ---------------------------------------------------------------- icons (vector, centred on cx,cy; s = nominal size)
local function ring(cx, cy, ro, ri, a0, a1, sx)
  local outer, inner = {}, {}
  local steps = math.max(6, math.floor(math.abs(a1 - a0) / 8))
  for i = 0, steps do
    local a = math.rad(a0 + (a1 - a0) * i / steps)
    outer[#outer + 1] = { cx + sx * ro * math.cos(a), cy + ro * math.sin(a) }
  end
  for i = steps, 0, -1 do
    local a = math.rad(a0 + (a1 - a0) * i / steps)
    inner[#inner + 1] = { cx + sx * ri * math.cos(a), cy + ri * math.sin(a) }
  end
  for _, p in ipairs(inner) do outer[#outer + 1] = p end
  return poly(outer)
end

local function icon_play(cx, cy, s, c, op)
  shape(poly({ { cx - 0.36 * s, cy - 0.5 * s }, { cx + 0.5 * s, cy }, { cx - 0.36 * s, cy + 0.5 * s } }), c, op)
end

local function icon_pause(cx, cy, s, c, op)
  shape(rect(cx - 0.40 * s, cy - 0.5 * s, 0.28 * s, s), c, op)
  shape(rect(cx + 0.12 * s, cy - 0.5 * s, 0.28 * s, s), c, op)
end

local function icon_skip(cx, cy, s, c, op, forward)
  local sx = forward and -1 or 1
  local ro, ri = 0.52 * s, 0.42 * s
  shape(ring(cx, cy + 0.04 * s, ro, ri, 285, 595, sx), c, op)
  -- arrowhead at the 285 degree end, pointing back along the ring
  local th = math.rad(285)
  local mr = (ro + ri) / 2
  local bx, by = cx + sx * mr * math.cos(th), cy + 0.04 * s + mr * math.sin(th)
  local tx, ty = sx * math.sin(th), -math.cos(th)
  local rx, ry = sx * math.cos(th), math.sin(th)
  local L, B = 0.30 * s, 0.20 * s
  shape(poly({ { bx + tx * L, by + ty * L }, { bx + rx * B, by + ry * B }, { bx - rx * B, by - ry * B } }), c, op)
  text(cx, cy + 0.06 * s, tostring(SKIP), math.floor(0.36 * s), c, op, 5, true)
end

local function icon_volume(cx, cy, s, c, op, level, muted)
  shape(poly({ { cx - 0.55 * s, cy - 0.2 * s }, { cx - 0.25 * s, cy - 0.2 * s }, { cx + 0.1 * s, cy - 0.5 * s },
    { cx + 0.1 * s, cy + 0.5 * s }, { cx - 0.25 * s, cy + 0.2 * s }, { cx - 0.55 * s, cy + 0.2 * s } }), c, op)
  if muted or level <= 0 then
    shape(poly({ { cx + 0.22 * s, cy - 0.22 * s }, { cx + 0.32 * s, cy - 0.32 * s }, { cx + 0.62 * s, cy + 0.22 * s + 0.1 * s },
      { cx + 0.52 * s, cy + 0.32 * s + 0.1 * s } }), c, op)
    shape(poly({ { cx + 0.52 * s, cy - 0.32 * s }, { cx + 0.62 * s, cy - 0.22 * s }, { cx + 0.32 * s, cy + 0.32 * s + 0.1 * s },
      { cx + 0.22 * s, cy + 0.22 * s + 0.1 * s } }), c, op)
  else
    shape(ring(cx + 0.1 * s, cy, 0.38 * s, 0.30 * s, -50, 50, 1), c, op)
    if level > 45 then shape(ring(cx + 0.1 * s, cy, 0.62 * s, 0.54 * s, -50, 50, 1), c, op) end
  end
end

local function icon_next(cx, cy, s, c, op)
  shape(poly({ { cx - 0.5 * s, cy - 0.5 * s }, { cx + 0.3 * s, cy }, { cx - 0.5 * s, cy + 0.5 * s } }), c, op)
  shape(rect(cx + 0.30 * s, cy - 0.5 * s, 0.2 * s, s), c, op)
end

local function icon_subs(cx, cy, s, c, op)
  shape(rect(cx - 0.58 * s, cy - 0.48 * s, 1.16 * s, 0.82 * s), c, op)
  shape(poly({ { cx - 0.25 * s, cy + 0.3 * s }, { cx - 0.25 * s, cy + 0.62 * s }, { cx + 0.08 * s, cy + 0.3 * s } }), c, op)
  shape(rect(cx - 0.42 * s, cy - 0.22 * s, 0.34 * s, 0.1 * s), '000000', op * 0.85)
  shape(rect(cx + 0.02 * s, cy - 0.22 * s, 0.4 * s, 0.1 * s), '000000', op * 0.85)
  shape(rect(cx - 0.42 * s, cy + 0.04 * s, 0.5 * s, 0.1 * s), '000000', op * 0.85)
  shape(rect(cx + 0.16 * s, cy + 0.04 * s, 0.26 * s, 0.1 * s), '000000', op * 0.85)
end

local function icon_fullscreen(cx, cy, s, c, op)
  local t, l = 0.12 * s, 0.34 * s
  for _, sx in ipairs({ -1, 1 }) do
    for _, sy in ipairs({ -1, 1 }) do
      local x0, y0 = cx + sx * 0.5 * s, cy + sy * 0.5 * s
      shape(rect(math.min(x0, x0 - sx * l), math.min(y0, y0 - sy * t), l, t), c, op)
      shape(rect(math.min(x0, x0 - sx * t), math.min(y0, y0 - sy * l), t, l), c, op)
    end
  end
end

local function icon_back(cx, cy, s, c, op)
  shape(poly({ { cx - 0.5 * s, cy }, { cx - 0.05 * s, cy - 0.45 * s }, { cx + 0.02 * s, cy - 0.38 * s },
    { cx - 0.28 * s, cy - 0.07 * s }, { cx + 0.5 * s, cy - 0.07 * s }, { cx + 0.5 * s, cy + 0.07 * s },
    { cx - 0.28 * s, cy + 0.07 * s }, { cx + 0.02 * s, cy + 0.38 * s }, { cx - 0.05 * s, cy + 0.45 * s } }), c, op)
end

local function icon_check(cx, cy, s, c, op)
  shape(poly({ { cx - 0.5 * s, cy + 0.05 * s }, { cx - 0.35 * s, cy - 0.1 * s }, { cx - 0.12 * s, cy + 0.13 * s },
    { cx + 0.36 * s, cy - 0.38 * s }, { cx + 0.5 * s, cy - 0.23 * s }, { cx - 0.12 * s, cy + 0.42 * s } }), c, op)
end

-- ---------------------------------------------------------------- track labelling
local LANGS = {
  eng = 'English', en = 'English', spa = 'Spanish', es = 'Spanish', fra = 'French', fre = 'French', fr = 'French',
  deu = 'German', ger = 'German', de = 'German', ita = 'Italian', it = 'Italian', por = 'Portuguese', pt = 'Portuguese',
  jpn = 'Japanese', ja = 'Japanese', kor = 'Korean', ko = 'Korean', zho = 'Chinese', chi = 'Chinese', zh = 'Chinese',
  rus = 'Russian', ru = 'Russian', nld = 'Dutch', dut = 'Dutch', swe = 'Swedish', nor = 'Norwegian', dan = 'Danish',
  fin = 'Finnish', pol = 'Polish', tur = 'Turkish', ara = 'Arabic', heb = 'Hebrew', hin = 'Hindi', tha = 'Thai',
  und = 'Unknown',
}
local function lang_name(code)
  if not code or code == '' then return nil end
  return LANGS[code:lower()] or code
end

local function channel_name(n)
  return ({ [1] = 'Mono', [2] = 'Stereo', [3] = '2.1', [6] = '5.1', [7] = '6.1', [8] = '7.1' })[n] or (n and (n .. 'ch') or nil)
end

local function codec_label(t)
  local c = (t.codec or ''):lower()
  local p = t['codec-profile'] or ''
  local pl = p:lower()
  local lab
  if c == 'ac3' then lab = 'Dolby Digital'
  elseif c == 'eac3' then lab = pl:find('atmos') and 'Dolby Digital Plus Atmos' or 'Dolby Digital Plus'
  elseif c == 'truehd' then lab = pl:find('atmos') and 'Dolby TrueHD Atmos' or 'Dolby TrueHD'
  elseif c == 'dts' then
    if pl:find('dts:x') then lab = 'DTS:X'
    elseif pl:find('ma') then lab = 'DTS-HD MA'
    elseif pl:find('hra') or pl:find('high res') then lab = 'DTS-HD HRA'
    elseif pl:find('es') then lab = 'DTS-ES'
    else lab = 'DTS' end
  elseif c == 'aac' then lab = 'AAC'
  elseif c == 'flac' then lab = 'FLAC'
  elseif c == 'opus' then lab = 'Opus'
  elseif c == 'mp3' then lab = 'MP3'
  else lab = c:upper() end
  local ch = channel_name(t['demux-channel-count'])
  return ch and (lab .. ' ' .. ch) or lab
end

local menu_audio, menu_subs = {}, {}

local function build_menu_lists()
  menu_audio, menu_subs = {}, {}
  local any_sub = false
  for _, t in ipairs(mp.get_property_native('track-list') or {}) do
    if t.type == 'audio' then
      menu_audio[#menu_audio + 1] = {
        id = t.id, selected = t.selected, lang = t.lang, codec = t.codec,
        label = lang_name(t.lang) or t.title or ('Track ' .. t.id), sub = codec_label(t),
      }
    elseif t.type == 'sub' then
      local label = lang_name(t.lang) or t.title or ('Track ' .. t.id)
      if t.title and lang_name(t.lang) and t.title:lower() ~= (t.lang or ''):lower() then label = label .. ' [' .. t.title .. ']' end
      if t.forced then label = label .. ' (Forced)' end
      menu_subs[#menu_subs + 1] = { id = t.id, selected = t.selected, lang = t.lang, label = label, sub = '' }
      if t.selected then any_sub = true end
    end
  end
  table.insert(menu_subs, 1, { id = 'no', selected = not any_sub, label = 'Off', sub = '' })
end

local function selected_index(list)
  for i, e in ipairs(list) do if e.selected then return i end end
  return 1
end

local function apply_entry(col, e)
  if col == 1 then
    mp.set_property('aid', e.id)
    S.pref_audio = { lang = e.lang, codec = e.codec }
  else
    mp.set_property('sid', e.id)
    S.pref_sub = (e.id == 'no') and 'no' or { lang = e.lang }
  end
  build_menu_lists()
  -- mpv updates 'selected' asynchronously; reflect the choice immediately
  local list = (col == 1) and menu_audio or menu_subs
  for _, x in ipairs(list) do x.selected = (x.id == e.id) end
end

-- ---------------------------------------------------------------- rendering
local function hit(x, y, w, h, spec)
  spec.x, spec.y, spec.w, spec.h = x, y, w, h
  hits[#hits + 1] = spec
end

local function in_rect(h, x, y) return x >= h.x and x <= h.x + h.w and y >= h.y and y <= h.y + h.h end

local function topmost_hit()
  for i = #hits, 1, -1 do
    if in_rect(hits[i], S.mx, S.my) then return hits[i] end
  end
  return nil
end

local function toast(msg_text)
  S.toast, S.toast_until = msg_text, now() + 1.3
end

local function seek_by(d)
  mp.commandv('seek', d, 'relative+exact')
  S.last_act = now()
end

local function toggle_pause() mp.set_property_native('pause', not S.paused); S.last_act = now() end
local function toggle_fullscreen() mp.set_property_native('fullscreen', not S.fs); S.last_act = now() end
local function toggle_mute() mp.set_property_native('mute', not S.mute); S.last_act = now() end
local function play_next() mp.commandv('playlist-next', 'force') end
local function quit_player() mp.commandv('quit') end

local function draw_menu(k)
  local rows_a, rows_s = #menu_audio, #menu_subs
  local vis = 9
  local nrows = math.min(vis, math.max(rows_a, rows_s))
  local colw, gap, pad, rowh = 500, 40, 44, 58
  local pw, ph = colw * 2 + gap + pad * 2, 110 + nrows * rowh + pad
  local px, py = W - MARGIN - pw, H - 300 - ph
  shape(rect(px, py, pw, ph), PANEL, 0.96 * k)
  hit(px, py, pw, ph, { panel = true })
  local cols = { { list = menu_audio, title = 'Audio' }, { list = menu_subs, title = 'Subtitles' } }
  for ci, c in ipairs(cols) do
    local cx = px + pad + (ci - 1) * (colw + gap)
    text(cx, py + 44, c.title, 34, WHITE, k, 4, true)
    local start = 1
    if ci == S.col then start = clamp(S.row - 4, 1, math.max(1, #c.list - vis + 1)) end
    for r = 0, vis - 1 do
      local idx = start + r
      local e = c.list[idx]
      if not e then break end
      local ry = py + 90 + r * rowh
      local focused = (ci == S.col and idx == S.row)
      local spec = { onclick = function() S.col, S.row = ci, idx; apply_entry(ci, e) end, menu_item = { ci, idx } }
      hit(cx, ry, colw, rowh - 4, spec)
      local hovered = in_rect(spec, S.mx, S.my)
      if focused or hovered then shape(rect(cx - 12, ry, colw + 24, rowh - 4), WHITE, 0.14 * k) end
      if e.selected then icon_check(cx + 14, ry + (rowh - 4) / 2, 26, WHITE, k) end
      text(cx + 54, ry + (rowh - 4) / 2, trunc(e.label, 22), 30, e.selected and WHITE or GRAY, k, 4, e.selected)
      if e.sub ~= '' then text(cx + colw, ry + (rowh - 4) / 2, trunc(e.sub, 26), 22, GRAY, k * 0.8, 6, false) end
    end
  end
end

local function draw_controls(k)
  local m = meta_for(mp.get_property('path'))
  local pl = playlist_info()
  local has_next = pl.next ~= nil
  local pos = S.scrub or S.pos
  local dur = S.dur
  local frac = (dur > 0) and clamp(pos / dur, 0, 1) or 0

  -- scrims
  gradient(0, 260, 0.75, 0, k)
  gradient(H - 360, H, 0, 0.88, k)

  -- back arrow
  icon_back(MARGIN + 30, 96, 46, WHITE, k)
  hit(MARGIN - 20, 40, 120, 112, { onclick = quit_player })

  -- progress bar
  local bx0, bx1 = MARGIN, W - MARGIN - 130
  local by = H - 190
  local bw = bx1 - bx0
  local over_bar = (S.my >= by - 36 and S.my <= by + 36 and S.mx >= bx0 - 10 and S.mx <= bx1 + 10) or S.drag ~= nil and S.drag.is_bar
  local bh = over_bar and 10 or 6
  shape(rect(bx0, by - bh / 2, bw, bh), WHITE, 0.30 * k)
  shape(rect(bx0, by - bh / 2, bw * frac, bh), ACCENT, k)
  shape(circle(bx0 + bw * frac, by, over_bar and 17 or 0), ACCENT, k)
  text(W - MARGIN, by, fmt_time(math.max(0, dur - pos)), 32, WHITE, k, 6, false)
  hit(bx0 - 10, by - 36, bw + 20, 72, {
    is_bar = true,
    ondrag = function(mx)
      local f = clamp((mx - bx0) / bw, 0, 1)
      S.scrub = f * dur
      mp.commandv('seek', string.format('%.2f', S.scrub), 'absolute+keyframes')
    end,
    onrelease = function()
      if S.scrub then mp.commandv('seek', string.format('%.2f', S.scrub), 'absolute+exact') end
      S.scrub = nil
    end,
  })
  if over_bar and dur > 0 and not S.drag then
    local f = clamp((S.mx - bx0) / bw, 0, 1)
    local tx = clamp(bx0 + bw * f, bx0 + 50, bx1 - 50)
    shape(rect(tx - 56, by - 84, 112, 44), PANEL, 0.95 * k)
    text(tx, by - 62, fmt_time(f * dur), 28, WHITE, k, 5, false)
  end

  -- button row
  local cy = H - 100
  local function btn(cx, size, draw, onclick)
    local spec = { onclick = onclick }
    hit(cx - size * 0.9, cy - size * 0.9, size * 1.8, size * 1.8, spec)
    local hov = in_rect(spec, S.mx, S.my)
    draw(cx, cy, size, WHITE, k * (hov and 1 or 0.85))
  end
  btn(MARGIN + 36, 56, S.paused and icon_play or icon_pause, toggle_pause)
  btn(MARGIN + 150, 60, function(x, y, sz, c, op) icon_skip(x, y, sz, c, op, false) end, function() seek_by(-SKIP) end)
  btn(MARGIN + 262, 60, function(x, y, sz, c, op) icon_skip(x, y, sz, c, op, true) end, function() seek_by(SKIP) end)
  local vx = MARGIN + 380
  btn(vx, 50, function(x, y, s, c, op) icon_volume(x, y, s, c, op, S.vol, S.mute) end, toggle_mute)
  local sx0, sw = vx + 50, 150
  local vfrac = S.mute and 0 or clamp(S.vol / 100, 0, 1)
  shape(rect(sx0, cy - 3, sw, 6), WHITE, 0.3 * k)
  shape(rect(sx0, cy - 3, sw * vfrac, 6), WHITE, k)
  shape(circle(sx0 + sw * vfrac, cy, 9), WHITE, k)
  hit(sx0 - 8, cy - 28, sw + 16, 56, {
    ondrag = function(mx)
      mp.set_property_native('mute', false)
      mp.set_property_native('volume', math.floor(clamp((mx - sx0) / sw, 0, 1) * 100 + 0.5))
    end,
  })

  -- right-hand group
  local rx = W - MARGIN - 36
  btn(rx, 50, icon_fullscreen, toggle_fullscreen)
  btn(rx - 110, 50, icon_subs, function()
    if S.menu then close_menu() else open_menu() end
  end)
  local right_edge = rx - 110 - 60
  if has_next then
    btn(rx - 220, 50, icon_next, play_next)
    right_edge = rx - 220 - 60
  end

  -- title (centre of the free span)
  local left_edge = sx0 + sw + 50
  local cxm = (left_edge + right_edge) / 2
  local maxc = math.floor((right_edge - left_edge) / 17)
  local ttl = m.title or ''
  local ep = ((m.sub and m.sub ~= '') and (m.sub .. '  ') or '') .. (m.name or '')
  if ep ~= '' then
    local t1 = trunc(ttl, math.floor(maxc * 0.5))
    local t2 = trunc(ep, maxc - #t1 - 2)
    add(string.format('{\\an5\\pos(%.1f,%.1f)%s\\fs34\\bord0\\shad1\\4c&H000000&\\4a&H90&\\1a%s\\b1\\1c&H%s&}%s{\\b0\\1c&H%s&}   %s',
      cxm, cy, FONT, alpha(k), WHITE, esc(t1), GRAY, esc(t2)))
  else
    text(cxm, cy, trunc(ttl, maxc), 34, WHITE, k, 5, true)
  end

  if S.menu then draw_menu(k) end
end

local function draw_pause_overlay(k)
  local m = meta_for(mp.get_property('path'))
  shape(rect(0, 0, W, H), BLACK, 0.62 * k)
  local x, y = 140, H * 0.30
  text(x, y, "You're watching", 30, GRAY, k, 7, false)
  text(x, y + 56, trunc(m.title or '', 34), 76, WHITE, k, 7, true)
  local ep = ((m.sub and m.sub ~= '') and (m.sub .. '  ') or '') .. (m.name or '')
  if ep ~= '' then text(x, y + 152, trunc(ep, 52), 40, WHITE, k, 7, true) end
  local ly = y + ((ep ~= '') and 220 or 170)
  for i, l in ipairs(wrap(m.desc or '', 58, 5)) do
    text(x, ly + (i - 1) * 46, l, 32, 'D9D9D9', k, 7, false)
  end
end

local function draw_next_card(k)
  local pl = playlist_info()
  if not pl.next or S.next_dismissed then return end
  local remaining = S.dur - S.pos
  if S.dur <= 0 or remaining > NEXT_CARD_AT or remaining < 0 then return end
  local cw, ch = 620, 150
  local cx = W - MARGIN - cw
  local cy = (S.fade > 0.5) and (H - 470) or (H - 250)
  shape(rect(cx, cy, cw, ch), PANEL, 0.96)
  -- countdown strip
  shape(rect(cx, cy + ch - 6, cw * (1 - clamp(remaining / NEXT_CARD_AT, 0, 1)), 6), ACCENT, 1)
  text(cx + 36, cy + 32, 'Next Episode', 24, GRAY, 1, 4, false)
  local n = pl.next
  local line = ((n.sub and n.sub ~= '') and (n.sub .. '  ') or '') .. ((n.name and n.name ~= '') and n.name or n.title or '')
  text(cx + 36, cy + 78, trunc(line, 30), 34, WHITE, 1, 4, true)
  icon_next(cx + cw - 56, cy + 62, 40, WHITE, 1)
  hit(cx, cy, cw, ch, { onclick = play_next })
end

local function draw_toast()
  local t = now()
  if not S.toast or t > S.toast_until then return end
  local k = clamp((S.toast_until - t) / 0.3, 0, 1)
  local w = 60 + #S.toast * 17
  shape(rect(W / 2 - w / 2, 120, w, 64), PANEL, 0.92 * k)
  text(W / 2, 152, S.toast, 30, WHITE, k, 5, true)
end

local function render()
  local w, h = mp.get_osd_size()
  if w and h and w > 0 and h > 0 then
    osd_w, osd_h = w, h
    H = 1080
    W = math.floor(1080 * w / h + 0.5)
  end
  local t = now()
  local dt = clamp(t - S.last_tick, 0, 0.2)
  S.last_tick = t

  local show = S.loaded and (S.menu or S.paused or S.drag ~= nil or (t - S.last_act < HIDE_AFTER)
    or (S.my > H - 320 and (t - S.last_act) < HIDE_AFTER * 2))
  local target = show and 1 or 0
  S.fade = S.fade + (target - S.fade) * clamp(dt * 12, 0, 1)
  if math.abs(target - S.fade) < 0.01 then S.fade = target end

  local pshow = S.loaded and S.paused and S.pause_t and (t - S.pause_t > 0.9) and not S.menu and S.drag == nil
  local ptarget = pshow and 1 or 0
  S.pfade = S.pfade + (ptarget - S.pfade) * clamp(dt * 8, 0, 1)
  if math.abs(ptarget - S.pfade) < 0.01 then S.pfade = ptarget end

  -- lift subtitles above the controls while they are showing
  local want_lift = S.fade > 0.5
  if want_lift ~= S.sub_lifted then
    S.sub_lifted = want_lift
    mp.set_property_number('sub-pos', want_lift and 78 or 100)
  end

  lines, hits = {}, {}
  if S.pfade > 0 then draw_pause_overlay(S.pfade) end
  if S.fade > 0 then draw_controls(S.fade) end
  if S.loaded then draw_next_card() end
  draw_toast()

  if #lines == 0 then
    if not blank_sent then mp.set_osd_ass(W, H, ''); blank_sent = true end
    return
  end
  blank_sent = false
  mp.set_osd_ass(W, H, table.concat(lines, '\n'))
end

-- ---------------------------------------------------------------- menu open/close + key handling
local MENU_KEYS = {}

function close_menu()
  if not S.menu then return end
  S.menu = false
  for _, n in ipairs(MENU_KEYS) do mp.remove_key_binding(n) end
  MENU_KEYS = {}
end

function open_menu()
  build_menu_lists()
  S.menu = true
  S.col = 1
  S.row = selected_index(menu_audio)
  S.last_act = now()
  local function move(dr, dc)
    return function()
      if dc ~= 0 then
        S.col = clamp(S.col + dc, 1, 2)
        local list = (S.col == 1) and menu_audio or menu_subs
        S.row = clamp(S.row, 1, #list)
      end
      if dr ~= 0 then
        local list = (S.col == 1) and menu_audio or menu_subs
        S.row = clamp(S.row + dr, 1, #list)
      end
    end
  end
  local function choose()
    local list = (S.col == 1) and menu_audio or menu_subs
    local e = list[S.row]
    if e then apply_entry(S.col, e) end
  end
  local binds = {
    { 'UP', 'nf_m_up', move(-1, 0) }, { 'DOWN', 'nf_m_down', move(1, 0) },
    { 'LEFT', 'nf_m_left', move(0, -1) }, { 'RIGHT', 'nf_m_right', move(0, 1) },
    { 'ENTER', 'nf_m_enter', choose }, { 'KP_ENTER', 'nf_m_kpenter', choose },
    { 'GAMEPAD_DPAD_UP', 'nf_m_gup', move(-1, 0) }, { 'GAMEPAD_DPAD_DOWN', 'nf_m_gdown', move(1, 0) },
    { 'GAMEPAD_DPAD_LEFT', 'nf_m_gleft', move(0, -1) }, { 'GAMEPAD_DPAD_RIGHT', 'nf_m_gright', move(0, 1) },
    { 'GAMEPAD_ACTION_DOWN', 'nf_m_ga', choose },
  }
  for _, b in ipairs(binds) do
    mp.add_forced_key_binding(b[1], b[2], b[3], { repeatable = true })
    MENU_KEYS[#MENU_KEYS + 1] = b[2]
  end
end

-- ---------------------------------------------------------------- input
local function update_mouse()
  local x, y = mp.get_mouse_pos()
  if x and y and osd_w > 0 then
    S.mx, S.my = x * W / osd_w, y * H / osd_h
  end
end

mp.add_forced_key_binding('mouse_move', 'nf_move', function()
  update_mouse()
  S.last_act = now()
  if S.drag and S.drag.ondrag then S.drag.ondrag(S.mx) end
end)

mp.add_forced_key_binding('mouse_leave', 'nf_leave', function() S.mx, S.my = -1, -1 end)

local function mouse_down()
  S.last_act = now()
  local h = topmost_hit()
  if h then
    if h.ondrag then S.drag = h; h.ondrag(S.mx)
    elseif h.onclick then h.onclick() end
    return
  end
  if S.menu then close_menu(); return end
  if S.fade > 0.5 and (S.my > H - 330 or S.my < 180) then return end
  toggle_pause()
end

local function mouse_up()
  if S.drag then
    if S.drag.onrelease then S.drag.onrelease(S.mx) end
    S.drag = nil
  end
end

mp.add_forced_key_binding('mbtn_left', 'nf_click', function(e)
  update_mouse()
  if e.event == 'down' then mouse_down()
  elseif e.event == 'up' then mouse_up()
  elseif e.event == 'press' then mouse_down(); mouse_up() end
end, { complex = true })

mp.add_forced_key_binding('SPACE', 'nf_space', toggle_pause)
mp.add_forced_key_binding('p', 'nf_p', toggle_pause)
mp.add_forced_key_binding('LEFT', 'nf_left', function() seek_by(-SKIP); toast('-' .. SKIP .. 's') end, { repeatable = true })
mp.add_forced_key_binding('RIGHT', 'nf_right', function() seek_by(SKIP); toast('+' .. SKIP .. 's') end, { repeatable = true })
mp.add_forced_key_binding('UP', 'nf_up', function()
  mp.set_property_native('mute', false)
  mp.commandv('add', 'volume', 5); S.last_act = now()
  toast('Volume ' .. math.floor(mp.get_property_number('volume', 0) + 0.5) .. '%')
end, { repeatable = true })
mp.add_forced_key_binding('DOWN', 'nf_down', function()
  mp.commandv('add', 'volume', -5); S.last_act = now()
  toast('Volume ' .. math.floor(mp.get_property_number('volume', 0) + 0.5) .. '%')
end, { repeatable = true })
mp.add_forced_key_binding('m', 'nf_mute', function() toggle_mute(); toast(S.mute and 'Muted' or 'Unmuted') end)
mp.add_forced_key_binding('f', 'nf_fs', toggle_fullscreen)
mp.add_forced_key_binding('c', 'nf_menu', function() if S.menu then close_menu() else open_menu() end end)
mp.add_forced_key_binding('n', 'nf_next', function() if playlist_info().next then play_next() end end)
local function enter_action()
  local pl = playlist_info()
  local remaining = S.dur - S.pos
  if pl.next and S.dur > 0 and remaining <= NEXT_CARD_AT then play_next() else toggle_pause() end
end
mp.add_forced_key_binding('ENTER', 'nf_enter', enter_action)
mp.add_forced_key_binding('KP_ENTER', 'nf_kpenter', enter_action)
mp.add_forced_key_binding('ESC', 'nf_esc', function()
  if S.menu then close_menu()
  elseif S.fs then mp.set_property_native('fullscreen', false)
  else quit_player() end
end)

-- Game controller (A = play/pause or OK, B = back, D-pad = seek/volume, Y = audio & subtitles, RB = next episode)
local function esc_action()
  if S.menu then close_menu() else quit_player() end
end
mp.add_forced_key_binding('GAMEPAD_ACTION_DOWN', 'nf_gp_a', enter_action)
mp.add_forced_key_binding('GAMEPAD_ACTION_RIGHT', 'nf_gp_b', esc_action)
mp.add_forced_key_binding('GAMEPAD_ACTION_UP', 'nf_gp_y', function() if S.menu then close_menu() else open_menu() end end)
mp.add_forced_key_binding('GAMEPAD_RIGHT_SHOULDER', 'nf_gp_rb', function() if playlist_info().next then play_next() end end)
mp.add_forced_key_binding('GAMEPAD_DPAD_LEFT', 'nf_gp_l', function() seek_by(-SKIP); toast('-' .. SKIP .. 's') end, { repeatable = true })
mp.add_forced_key_binding('GAMEPAD_DPAD_RIGHT', 'nf_gp_r', function() seek_by(SKIP); toast('+' .. SKIP .. 's') end, { repeatable = true })
mp.add_forced_key_binding('GAMEPAD_DPAD_UP', 'nf_gp_u', function()
  mp.set_property_native('mute', false); mp.commandv('add', 'volume', 5); S.last_act = now()
  toast('Volume ' .. math.floor(mp.get_property_number('volume', 0) + 0.5) .. '%')
end, { repeatable = true })
mp.add_forced_key_binding('GAMEPAD_DPAD_DOWN', 'nf_gp_d', function()
  mp.commandv('add', 'volume', -5); S.last_act = now()
  toast('Volume ' .. math.floor(mp.get_property_number('volume', 0) + 0.5) .. '%')
end, { repeatable = true })

-- ---------------------------------------------------------------- property tracking
mp.observe_property('time-pos', 'number', function(_, v) if v then S.pos = v end end)
mp.observe_property('duration', 'number', function(_, v) S.dur = v or 0 end)
mp.observe_property('pause', 'bool', function(_, v)
  S.paused = v and true or false
  S.pause_t = S.paused and now() or nil
  S.last_act = now()
end)
mp.observe_property('volume', 'number', function(_, v) if v then S.vol = v end end)
mp.observe_property('mute', 'bool', function(_, v) S.mute = v and true or false end)
mp.observe_property('fullscreen', 'bool', function(_, v) S.fs = v and true or false end)

local function track_matches(t, pref, kind)
  if kind == 'audio' then
    return (pref.lang == nil or t.lang == pref.lang) and (pref.codec == nil or t.codec == pref.codec)
  end
  return pref.lang == nil or t.lang == pref.lang
end

mp.register_event('file-loaded', function()
  S.loaded = true
  S.next_dismissed = false
  S.last_act = now()
  S.scrub = nil
  -- carry the viewer's audio/subtitle choice across episodes
  local tl = mp.get_property_native('track-list') or {}
  if S.pref_audio then
    local best
    for _, t in ipairs(tl) do
      if t.type == 'audio' and track_matches(t, S.pref_audio, 'audio') then best = best or t end
    end
    if not best then
      for _, t in ipairs(tl) do
        if t.type == 'audio' and S.pref_audio.lang and t.lang == S.pref_audio.lang then best = best or t end
      end
    end
    if best and not best.selected then mp.set_property('aid', best.id) end
  end
  if S.pref_sub == 'no' then
    mp.set_property('sid', 'no')
  elseif S.pref_sub then
    for _, t in ipairs(tl) do
      if t.type == 'sub' and track_matches(t, S.pref_sub, 'sub') then
        if not t.selected then mp.set_property('sid', t.id) end
        break
      end
    end
  end
  if S.menu then close_menu() end
end)

mp.register_event('end-file', function() S.loaded = false end)

S.last_tick = now()
mp.add_periodic_timer(1 / 30, function()
  local ok, err = pcall(render)
  if not ok then mp.msg.error('render: ' .. tostring(err)) end
end)
