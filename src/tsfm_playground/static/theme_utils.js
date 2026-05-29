(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.TSFMThemeUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STORAGE_KEY = "tsfm-playground.theme";
  const MODES = new Set(["system", "light", "dark"]);

  function sanitizeThemeMode(value) {
    return MODES.has(value) ? value : "system";
  }

  function resolveTheme(mode, prefersDark) {
    const clean = sanitizeThemeMode(mode);
    if (clean === "system") return prefersDark ? "dark" : "light";
    return clean;
  }

  function readStoredTheme(storage) {
    try {
      return sanitizeThemeMode(storage.getItem(STORAGE_KEY) || "system");
    } catch (_err) {
      return "system";
    }
  }

  function writeStoredTheme(storage, mode) {
    try {
      storage.setItem(STORAGE_KEY, sanitizeThemeMode(mode));
    } catch (_err) {
      return;
    }
  }

  return {
    STORAGE_KEY,
    sanitizeThemeMode,
    resolveTheme,
    readStoredTheme,
    writeStoredTheme,
  };
});
