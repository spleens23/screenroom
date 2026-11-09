// The Android phone apps (Parlor, and Screenroom for phones) run the iPhone app's screens and its window.api
// (ios-api.js) unchanged. This hands the page's calls to the Android app the way the iPhone app takes them
// (window.webkit.messageHandlers.screenroom), and the app answers through window.__iosReply / __iosEvent.
(() => {
  'use strict';
  const app = window.SRAndroid;
  if (!app) return;
  window.S_IOS = true;            // the touch screens (as on the iPhone)
  window.S_ANDROID = true;
  window.SR_APP = app.kind();     // 'parlor' or 'screenroom'
  // files on the phone are served by the app from this address (see WebFiles.kt)
  window.S_FILE_BASE = 'https://appassets.androidplatform.net/f';
  window.webkit = { messageHandlers: { screenroom: { postMessage: (m) => app.post(JSON.stringify(m)) } } };

  // Page errors are kept in a small log (page-errors.log), and a problem while the screens start up is shown on
  // screen, so it can be reported instead of leaving a half-drawn page.
  const t0 = Date.now();
  const log = (m) => { try { app.log(String(m)); } catch (e) {} };
  const show = (m) => {
    if (Date.now() - t0 > 20000) return;
    const put = () => {
      let b = document.getElementById('ios-problem');
      if (!b) {
        b = document.createElement('div'); b.id = 'ios-problem';
        b.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:99999;background:#3A1E16;color:#FFE2D6;border:1px solid #D2553A;border-radius:14px;padding:14px 18px;font:15px sans-serif;white-space:pre-wrap;max-height:40vh;overflow:auto';
        b.onclick = () => b.remove(); document.body.appendChild(b);
        b.textContent = 'The app hit a problem starting up (tap to hide). Please send a screenshot of this:';
      }
      b.textContent += '\n• ' + m;
    };
    document.body ? put() : addEventListener('DOMContentLoaded', put);
  };
  const report = (m) => { log(m); show(m); };
  window.__iosReport = report;
  window.addEventListener('error', (e) => report('error: ' + e.message + ' @ ' + String(e.filename).split('/').slice(-2).join('/') + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => report('rejection: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
  const ce = console.error;
  console.error = (...a) => { log('console: ' + a.join(' ')); ce.apply(console, a); };
})();
