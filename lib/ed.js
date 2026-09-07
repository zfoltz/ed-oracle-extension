// Ed Oracle — Ed Discussion API client. Plain script (globals).

const Ed = (() => {
  const TOKEN_KEY = "authToken:us";

  async function getSettings() {
    const defaults = {
      edBaseUrl: "https://us.edstem.org/api",
      courseId: 100459,
      edToken: "",
    };
    const got = await chrome.storage.local.get(Object.keys(defaults));
    return { ...defaults, ...got };
  }

  function tokenExp(token) {
    try {
      const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(atob(payload + "==".slice((payload.length + 2) % 4)));
      return json.exp || null;
    } catch (e) {
      return null;
    }
  }

  async function storeToken(token) {
    if (!token || token.split(".").length !== 3) return false;
    const exp = tokenExp(token);
    await chrome.storage.local.set({ edToken: token, edTokenExp: exp });
    return true;
  }

  async function request(path, params = null, method = "GET", retries = 3) {
    const { edBaseUrl, edToken } = await getSettings();
    let url = edBaseUrl.replace(/\/$/, "") + path;
    if (params) url += "?" + new URLSearchParams(params).toString();
    const headers = {
      Accept: "application/json",
      "x-token": edToken || "",
      Origin: "https://edstem.org",
    };
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const resp = await fetch(url, { method, headers });
        if (resp.status === 401 || resp.status === 403) {
          throw new Error(
            "Ed token expired or invalid. Open edstem.org in a tab (the extension grabs the token automatically), or paste a token in Settings."
          );
        }
        if (!resp.ok) {
          lastErr = new Error(`Ed HTTP ${resp.status} for ${path}`);
          await sleep(2 ** attempt * 500);
          continue;
        }
        return await resp.json();
      } catch (e) {
        if (/expired or invalid/.test(e.message)) throw e;
        lastErr = e;
        await sleep(2 ** attempt * 500);
      }
    }
    throw lastErr || new Error(`Ed request failed: ${path}`);
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function listThreads(limit = 100, offset = 0) {
    const { courseId } = await getSettings();
    return request(`/courses/${courseId}/threads`, { limit, offset, sort: "new" });
  }

  async function getThread(id) {
    return request(`/threads/${id}`);
  }

  // Best-effort JWT refresh. Returns true if a new token was stored.
  async function renewToken() {
    try {
      const { edBaseUrl } = await getSettings();
      const { edToken } = await getSettings();
      if (!edToken) return false;
      const resp = await fetch(edBaseUrl.replace(/\/$/, "") + "/renew_token", {
        method: "POST",
        headers: { Accept: "application/json", "x-token": edToken, Origin: "https://edstem.org" },
      });
      if (!resp.ok) return false;
      const text = await resp.text();
      let token = null;
      try {
        const data = JSON.parse(text);
        token = data.token || data.new_token || (typeof data === "string" ? data : null);
      } catch (e) {
        if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(text.trim())) token = text.trim();
      }
      if (token) return storeToken(token);
      return false;
    } catch (e) {
      return false;
    }
  }

  // Fallback: look for an Ed session cookie that looks like a JWT.
  async function grabCookieToken() {
    const names = ["token", "edtoken", "session_token", "authToken"];
    const urls = ["https://us.edstem.org", "https://edstem.org", "https://aus.edstem.org", "https://eu.edstem.org"];
    for (const url of urls) {
      for (const name of names) {
        try {
          const c = await chrome.cookies.get({ url, name });
          if (c && c.value && c.value.split(".").length === 3 && c.value.length > 50) {
            return c.value;
          }
        } catch (e) { /* no permission or no cookie */ }
      }
    }
    return null;
  }

  return { getSettings, tokenExp, storeToken, request, listThreads, getThread, renewToken, grabCookieToken, TOKEN_KEY };
})();
