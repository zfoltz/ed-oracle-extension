// Ed Oracle — background service worker: token capture, scheduled sync.

importScripts("lib/db.js", "lib/ed.js");

const DEFAULTS = {
  edBaseUrl: "https://us.edstem.org/api",
  courseId: 100459,
  edToken: "",
  edTokenExp: null,
  llmBaseUrl: "https://api.deepinfra.com/v1/openai",
  llmApiKey: "",
  llmModel: "zai-org/GLM-5.3-Flash",
  courseName: "CS 7643 (Deep Learning)",
  syncIntervalMin: 120,
  lastSyncStatus: "",
};

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await chrome.storage.local.get(null);
  const updates = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in cur)) updates[k] = v;
  }
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  await scheduleAlarms();
  grabToken();
  setupSidePanel();
  syncAll().catch(() => {});
});

// Clicking the toolbar icon opens the oracle as a docked side panel that
// survives clicks elsewhere on the page (Chrome 114+). The popup remains
// as a fallback for older browsers / when the side panel isn't supported.
function setupSidePanel() {
  try {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
    chrome.sidePanel.setOptions({ path: "popup.html?view=side" }).catch(() => {});
  } catch (e) {
    /* sidePanel API unavailable — popup fallback still works */
  }
}

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarms();
  grabToken();
  setupSidePanel();
});

async function scheduleAlarms() {
  const { syncIntervalMin } = await chrome.storage.local.get("syncIntervalMin");
  chrome.alarms.create("sync", { periodInMinutes: Math.max(5, syncIntervalMin || 120) });
  chrome.alarms.create("renew-token", { periodInMinutes: 60 * 12 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "sync") syncAll().catch(console.error);
  if (alarm.name === "renew-token") renewIfNeeded().catch(console.error);
});

// ---------- token ----------

async function grabToken() {
  // 1) cookie fallback (content script usually beats it with the localStorage JWT)
  const cookieToken = await Ed.grabCookieToken();
  if (cookieToken) await Ed.storeToken(cookieToken);
  // 2) try renewing if expiring soon
  await renewIfNeeded();
}

async function renewIfNeeded() {
  const { edToken, edTokenExp } = await chrome.storage.local.get(["edToken", "edTokenExp"]);
  if (!edToken) return;
  const exp = edTokenExp || Ed.tokenExp(edToken);
  if (!exp) return;
  const daysLeft = (exp * 1000 - Date.now()) / 86400000;
  if (daysLeft < 3) await Ed.renewToken();
}

// ---------- sync ----------

function nowIso() {
  return new Date().toISOString();
}

async function syncAll() {
  const started = Date.now();
  try {
    const stats = await doSync();
    const msg =
      `${stats.listed} threads, ${stats.detailsFetched} updated, ${stats.deleted} deleted` +
      (stats.errors ? `, ${stats.errors} errors` : "") +
      ` (${Math.round((Date.now() - started) / 1000)}s)`;
    await chrome.storage.local.set({ lastSyncStatus: `OK: ${msg}`, lastSyncAt: nowIso() });
    return stats;
  } catch (e) {
    await chrome.storage.local.set({ lastSyncStatus: `ERROR: ${e.message || e}` });
    throw e;
  }
}

async function doSync() {
  const { edToken } = await chrome.storage.local.get("edToken");
  if (!edToken) {
    throw new Error("No Ed token yet — open edstem.org while logged in (the extension grabs it automatically)");
  }
  let listed = 0;
  let detailsFetched = 0;
  let deleted = 0;
  let errors = 0;

  // 1) activity-sorted thread list, paged
  const all = [];
  const users = {};
  let offset = 0;
  for (;;) {
    const data = await Ed.listThreads(100, offset);
    for (const u of data.users || []) if (u) users[u.id] = u;
    const batch = data.threads || [];
    if (!batch.length) break;
    all.push(...batch);
    offset += batch.length;
    if (batch.length < 100) break;
  }
  listed = all.length;

  // 2) upsert list rows; decide which need a detail re-fetch
  const stale = [];
  const seen = new Set();
  for (const t of all) {
    seen.add(t.id);
    const old = await DB.getThread(t.id);
    const [name, role] = authorInfo(users, t.user_id, t.is_anonymous);
    await DB.upsertThreadList(t, name, role, nowIso());
    if (!old || old.updated_at !== t.updated_at || !old.detail_synced_at || old.reply_count !== t.reply_count) {
      stale.push(t.id);
    }
  }

  // 3) fetch details for stale threads (sequential; keeps Ed happy)
  for (const tid of stale) {
    try {
      const detail = await Ed.getThread(tid);
      const [name, role] = authorInfo(users, detail.thread.user_id, detail.thread.is_anonymous);
      await DB.storeThreadDetail(detail, name, role);
      detailsFetched++;
    } catch (e) {
      errors++;
      console.warn(`detail fetch failed for thread ${tid}:`, e.message || e);
    }
  }

  // 4) mark threads no longer listed as deleted
  const allCached = await DB.getAllThreads();
  const gone = allCached.filter((t) => !t.deleted && !seen.has(t.id)).map((t) => t.id);
  if (gone.length) {
    await DB.markDeleted(gone);
    deleted = gone.length;
  }

  await DB.setMeta("last_sync", nowIso());
  await DB.setMeta("total_threads", String(listed));
  return { listed, detailsFetched, deleted, errors };
}

function authorInfo(userMap, userId, isAnonymous) {
  if (isAnonymous) return ["Anonymous", "anonymous"];
  const u = userMap[userId];
  if (!u) return ["Unknown", "unknown"];
  let role = u.course_role || u.role || "student";
  if (role === "user") role = "student";
  return [u.name || "Unknown", role];
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ed-token" && msg.token) {
    Ed.storeToken(msg.token).then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg.type === "sync-now") {
    doSync()
      .then(async (stats) => {
        const msg2 = `${stats.listed} threads, ${stats.detailsFetched} updated, ${stats.deleted} deleted, ${stats.errors} errors`;
        await chrome.storage.local.set({ lastSyncStatus: `OK: ${msg2}`, lastSyncAt: nowIso() });
        sendResponse({ ok: true, stats, message: msg2 });
      })
      .catch(async (e) => {
        await chrome.storage.local.set({ lastSyncStatus: `ERROR: ${e.message || e}` });
        sendResponse({ ok: false, error: e.message || String(e) });
      });
    return true;
  }
  if (msg.type === "renew-token") {
    Ed.renewToken().then((ok) => sendResponse({ ok }));
    return true;
  }
  if (msg.type === "grab-cookie-token") {
    Ed.grabCookieToken()
      .then(async (t) => {
        if (t) await Ed.storeToken(t);
        sendResponse({ ok: !!t });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});
