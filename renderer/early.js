// Runs before anything is drawn: the look from last time (light or dark, Parlor or Screenroom, the Rewind theme…)
// goes on straight away, and the page stays blank until the app has drawn itself, so the old, unstyled screen
// never flashes up first.
(function () {
  var b = document.body;
  b.classList.add('mat', 'booting');
  try {
    var c = localStorage.getItem('sr-look');
    if (c) c.split(' ').forEach(function (x) { if (x) b.classList.add(x); });
  } catch (e) {}
  setTimeout(function () { b.classList.remove('booting'); }, 5000); // (never stays blank)
})();
