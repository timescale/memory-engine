// Applies the saved (or OS-preferred) theme before first paint to avoid a
// light-mode flash. Loaded as a blocking classic script from index.html's
// <head> (kept external so the hosted server's CSP covers it via 'self'
// with no inline-script hashing).
(() => {
  let theme = null;
  try {
    theme = localStorage.getItem("me-theme");
  } catch {
    // Storage can be unavailable (private mode); fall through to the OS hint.
  }
  const dark =
    theme === "dark" ||
    (theme !== "light" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
