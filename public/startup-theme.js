(function () {
  var storageKey = "termflow-startup-theme";
  var lightThemes = ["light-glass", "light-warm"];
  var darkThemes = ["dark-starry", "dark-mocha"];
  var categories = ["light", "dark", "system"];
  var startupTheme = {
    lightTheme: "light-glass",
    darkTheme: "dark-starry",
    themeCategory: "dark",
    systemPrefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
  };

  try {
    var cached = JSON.parse(localStorage.getItem(storageKey) || "null");
    if (cached && typeof cached === "object") {
      if (lightThemes.indexOf(cached.lightTheme) !== -1) {
        startupTheme.lightTheme = cached.lightTheme;
      }
      if (darkThemes.indexOf(cached.darkTheme) !== -1) {
        startupTheme.darkTheme = cached.darkTheme;
      }
      if (categories.indexOf(cached.themeCategory) !== -1) {
        startupTheme.themeCategory = cached.themeCategory;
      }
    }
  } catch (_error) {
    // A corrupt or unavailable cache must not prevent the application from starting.
  }

  var useDarkTheme =
    startupTheme.themeCategory === "dark" ||
    (startupTheme.themeCategory === "system" && startupTheme.systemPrefersDark);
  var activeTheme = useDarkTheme
    ? startupTheme.darkTheme
    : startupTheme.lightTheme;

  document.documentElement.setAttribute("data-theme", activeTheme);
  window.__TERMFLOW_STARTUP_THEME__ = startupTheme;
})();
