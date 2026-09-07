// Ed Oracle — grabs the Ed JWT from localStorage whenever you visit Ed
// and hands it to the extension. Primary auto-token mechanism.
(() => {
  try {
    const token =
      localStorage.getItem("authToken:us") ||
      localStorage.getItem("authToken") ||
      "";
    if (token && token.split(".").length === 3) {
      chrome.runtime.sendMessage({ type: "ed-token", token }).catch(() => {});
    }
  } catch (e) {
    /* ignore */
  }
})();
