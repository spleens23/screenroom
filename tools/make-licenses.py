#!/usr/bin/env python3
"""Builds renderer/licenses.js: Screenroom's own license and the open-source parts each version of the app ships
with, each with its license text (fetched from the project's own repository), for Settings › About.
Run it when a dependency changes: python3 tools/make-licenses.py"""
import json, os, sys, urllib.request

RAW = 'https://raw.githubusercontent.com/'
# id, name, what it does, license, source page, license file (raw path), platforms ('ios', 'desktop', 'android', 'all')
PARTS = [
    ('screenroom', 'Screenroom', 'This app', 'GPL-3.0-or-later', 'https://github.com/spleens23/screenroom', None, 'all'),
    ('mpv', 'mpv', 'Plays DTS, TrueHD, MKV and other films', 'LGPL-2.1-or-later', 'https://github.com/mpv-player/mpv', 'mpv-player/mpv/master/LICENSE.LGPL', 'ios'),
    ('mpvkit', 'MPVKit', 'mpv and FFmpeg packaged for iPad', 'LGPL-3.0', 'https://github.com/mpvkit/MPVKit', 'mpvkit/MPVKit/main/LICENSE', 'ios'),
    ('ffmpeg', 'FFmpeg', 'Reads and decodes films and sound', 'LGPL-3.0-or-later', 'https://ffmpeg.org', 'FFmpeg/FFmpeg/master/COPYING.LGPLv3', 'ios'),
    ('libass', 'libass', 'Draws styled subtitles', 'ISC', 'https://github.com/libass/libass', 'libass/libass/master/COPYING', 'ios'),
    ('freetype', 'FreeType', 'Draws subtitle text', 'FreeType License', 'https://freetype.org', 'freetype/freetype/master/docs/FTL.TXT', 'ios'),
    ('fribidi', 'GNU FriBidi', 'Right-to-left subtitle text', 'LGPL-2.1-or-later', 'https://github.com/fribidi/fribidi', 'fribidi/fribidi/master/COPYING', 'ios'),
    ('harfbuzz', 'HarfBuzz', 'Shapes subtitle text', 'MIT (Old)', 'https://github.com/harfbuzz/harfbuzz', 'harfbuzz/harfbuzz/main/COPYING', 'ios'),
    ('libunibreak', 'libunibreak', 'Line breaking for subtitles', 'zlib', 'https://github.com/adah1972/libunibreak', 'adah1972/libunibreak/master/LICENCE', 'ios'),
    ('libplacebo', 'libplacebo', 'Draws the picture (HDR, colour)', 'LGPL-2.1-or-later', 'https://github.com/haasn/libplacebo', 'haasn/libplacebo/master/LICENSE', 'ios'),
    ('libdovi', 'libdovi (dovi_tool)', 'Dolby Vision metadata', 'MIT', 'https://github.com/quietvoid/dovi_tool', 'quietvoid/dovi_tool/main/LICENSE', 'ios'),
    ('moltenvk', 'MoltenVK', 'Vulkan graphics on Apple devices', 'Apache-2.0', 'https://github.com/KhronosGroup/MoltenVK', 'KhronosGroup/MoltenVK/main/LICENSE', 'ios'),
    ('shaderc', 'shaderc (with glslang, SPIRV-Tools)', 'Builds graphics shaders', 'Apache-2.0', 'https://github.com/google/shaderc', 'google/shaderc/main/LICENSE', 'ios'),
    ('lcms2', 'Little CMS', 'Colour management', 'MIT', 'https://github.com/mm2/Little-CMS', 'mm2/Little-CMS/master/LICENSE', 'ios'),
    ('dav1d', 'dav1d', 'AV1 video', 'BSD-2-Clause', 'https://code.videolan.org/videolan/dav1d', 'videolan/dav1d/master/COPYING', 'ios'),
    ('uavs3d', 'uavs3d', 'AVS3 video', 'BSD-3-Clause', 'https://github.com/uavs3/uavs3d', 'uavs3/uavs3d/master/COPYING', 'ios'),
    ('uchardet', 'uchardet', 'Guesses subtitle text encodings', 'MPL-1.1 / LGPL-2.1-or-later', 'https://www.freedesktop.org/wiki/Software/uchardet/', 'BYVoid/uchardet/master/COPYING', 'ios'),
    ('libbluray', 'libbluray', 'Blu-ray structures', 'LGPL-2.1-or-later', 'https://code.videolan.org/videolan/libbluray', 'choose:lgpl-2.1', 'ios'),
    ('openssl', 'OpenSSL', 'Secure connections', 'Apache-2.0', 'https://github.com/openssl/openssl', 'openssl/openssl/master/LICENSE.txt', 'ios'),
    ('gnutls', 'GnuTLS', 'Secure connections', 'LGPL-2.1-or-later', 'https://gnutls.org', 'choose:lgpl-2.1', 'ios'),
    ('nettle', 'Nettle', 'Cryptography for GnuTLS', 'LGPL-3.0-or-later or GPL-2.0-or-later', 'https://www.lysator.liu.se/~nisse/nettle/', 'gnutls/nettle/master/COPYING.LESSERv3', 'ios'),
    ('gmp', 'GNU MP', 'Arithmetic for GnuTLS', 'LGPL-3.0-or-later or GPL-2.0-or-later', 'https://gmplib.org', 'gnutls/nettle/master/COPYING.LESSERv3', 'ios'),
    ('electron', 'Electron (with Chromium and Node.js)', 'The app itself on Mac, Linux and the box', 'MIT', 'https://github.com/electron/electron', 'electron/electron/main/LICENSE', 'desktop'),
    ('qrcode', 'qrcode-generator', 'QR codes for the phone remote', 'MIT', 'https://github.com/kazuhikoarase/qrcode-generator', 'kazuhikoarase/qrcode-generator/master/LICENSE', 'desktop'),
    ('mpv-desktop', 'mpv', 'Plays films (a separate program)', 'GPL-2.0-or-later / LGPL-2.1-or-later', 'https://github.com/mpv-player/mpv', 'mpv-player/mpv/master/LICENSE.GPL', 'desktop'),
    ('ffmpeg-desktop', 'FFmpeg (ffprobe)', 'Reads films (a separate program)', 'LGPL-2.1-or-later / GPL-2.0-or-later', 'https://ffmpeg.org', 'FFmpeg/FFmpeg/master/LICENSE.md', 'desktop'),
    ('media3', 'AndroidX Media3 (ExoPlayer)', 'Plays films', 'Apache-2.0', 'https://github.com/androidx/media', 'androidx/media/release/LICENSE', 'android'),
    ('jellyfin-ffmpeg', 'Jellyfin Media3 FFmpeg decoder', 'DTS and TrueHD sound', 'GPL-3.0', 'https://github.com/jellyfin/jellyfin-androidx-media', 'jellyfin/jellyfin-androidx-media/master/LICENSE', 'android'),
    ('nanohttpd', 'NanoHTTPD', 'The phone remote', 'BSD-3-Clause', 'https://github.com/NanoHttpd/nanohttpd', 'NanoHttpd/nanohttpd/master/LICENSE.md', 'android'),
    ('fraunces', 'Fraunces (typeface)', 'Titles', 'OFL-1.1', 'https://github.com/undercasetype/Fraunces', 'undercasetype/Fraunces/master/OFL.txt', 'all'),
    ('dmsans', 'DM Sans (typeface)', 'Text', 'OFL-1.1', 'https://github.com/googlefonts/dm-fonts', 'google/fonts/main/ofl/dmsans/OFL.txt', 'all'),
    ('notojp', 'Noto Sans JP (typeface)', 'Japanese text', 'OFL-1.1', 'https://github.com/notofonts/noto-cjk', None, 'all'),
]

def get(path):
    if path.startswith('choose:'): # the standard text of a license, from GitHub's choosealicense.com
        t = get(f'github/choosealicense.com/gh-pages/_licenses/{path[7:]}.txt')
        return t.split('---', 2)[2] if t.startswith('---') else t
    with urllib.request.urlopen(RAW + path, timeout=30) as r:
        return r.read().decode('utf-8', 'replace')

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = []
for pid, name, what, lic, src, file, plat in PARTS:
    if pid == 'screenroom':
        text = open(os.path.join(root, 'NOTICE')).read() + '\n\n' + open(os.path.join(root, 'LICENSE')).read()
    elif pid == 'notojp':
        text = open(os.path.join(root, 'renderer/fonts/LICENSE-noto-sans-jp.txt')).read()
    else:
        try:
            text = get(file)
        except Exception as e:
            sys.exit(f'{name}: could not fetch {file}: {e}')
    out.append({'id': pid, 'name': name, 'what': what, 'license': lic, 'source': src, 'platforms': plat, 'text': text.strip()})
    print(f'{name}: {len(text)} chars')
js = ('// Made by tools/make-licenses.py: the open-source parts of Screenroom and their licenses (Settings › About).\n'
      'window.SR_LICENSES = ' + json.dumps(out, ensure_ascii=False, indent=0) + ';\n')
open(os.path.join(root, 'renderer/licenses.js'), 'w').write(js)
print('renderer/licenses.js', len(js), 'bytes')
