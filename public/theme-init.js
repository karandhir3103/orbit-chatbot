// Applies the saved theme before first paint so there is no flash. Dark is the default.
(function () {
  var theme = 'dark';
  try {
    if (localStorage.getItem('orbit-theme') === 'light') theme = 'light';
  } catch (e) { /* storage unavailable: keep the default */ }
  document.documentElement.setAttribute('data-theme', theme);
})();
