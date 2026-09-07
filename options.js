// Ed Oracle — settings page.

const $ = (id) => document.getElementById(id);

const FIELDS = [
  "llmBaseUrl", "llmApiKey", "llmModel",
  "edToken", "edBaseUrl", "courseId", "courseName", "syncIntervalMin",
];

async function load() {
  const got = await chrome.storage.local.get(FIELDS);
  if (!got.llmBaseUrl) $("llmBaseUrl").value = "https://api.deepinfra.com/v1/openai";
  for (const f of FIELDS) {
    if (got[f] !== undefined && got[f] !== null && got[f] !== "") $(f).value = got[f];
  }
  renderTokenStatus();
  renderSyncStatus();
}

function renderTokenStatus() {
  chrome.storage.local.get(["edToken", "edTokenExp"], ({ edToken, edTokenExp }) => {
    const el = $("tokenStatus");
    if (!edToken) {
      el.innerHTML = `<span class="warn">No Ed token yet — open edstem.org while logged in and the extension grabs it automatically, or paste one above.</span>`;
      return;
    }
    if (!edTokenExp) {
      el.innerHTML = `<span class="warn">Ed token stored (expiry unknown).</span>`;
      return;
    }
    const days = Math.floor((edTokenExp * 1000 - Date.now()) / 86400000);
    if (days > 3) {
      el.innerHTML = `<span class="ok">Ed token active — expires in ~${days} day${days === 1 ? "" : "s"}.</span>`;
    } else if (days >= 0) {
      el.innerHTML = `<span class="warn">Ed token expires in ~${days} day${days === 1 ? "" : "s"} — opening edstem.org refreshes it automatically.</span>`;
    } else {
      el.innerHTML = `<span class="bad">Ed token expired — open edstem.org while logged in to re-grab it.</span>`;
    }
  });
}

function renderSyncStatus() {
  chrome.storage.local.get(["lastSyncStatus"], ({ lastSyncStatus }) => {
    $("syncStatus").textContent = lastSyncStatus || "not synced yet";
  });
}

$("save").addEventListener("click", async () => {
  const values = {};
  for (const f of FIELDS) values[f] = $(f).value.trim();
  values.courseId = parseInt(values.courseId, 10) || 100459;
  values.syncIntervalMin = Math.max(5, parseInt(values.syncIntervalMin, 10) || 120);

  // Request permission for the LLM endpoint origin so background/popup fetches work
  // even if the endpoint doesn't send CORS headers.
  let permMsg = "";
  try {
    const u = new URL(values.llmBaseUrl);
    if (u.protocol === "https:" || u.protocol === "http:") {
      const granted = await chrome.permissions.request({ origins: [u.origin + "/*"] });
      permMsg = granted ? "" : " (permission not granted — the endpoint must allow CORS)";
    }
  } catch (e) {
    permMsg = "";
  }

  await chrome.storage.local.set(values);
  await chrome.alarms.create("sync", { periodInMinutes: values.syncIntervalMin });
  $("saveMsg").textContent = "Saved." + permMsg;
  renderTokenStatus();
  setTimeout(() => ($("saveMsg").textContent = ""), 4000);
});

$("syncNow").addEventListener("click", () => {
  $("syncStatus").textContent = "syncing...";
  chrome.runtime.sendMessage({ type: "sync-now" }, (resp) => {
    if (chrome.runtime.lastError) {
      $("syncStatus").textContent = `error: ${chrome.runtime.lastError.message}`;
      return;
    }
    $("syncStatus").textContent =
      resp && resp.ok ? `OK: ${resp.message}` : `error: ${resp && resp.error}`;
  });
});

$("refreshToken").addEventListener("click", () => {
  $("tokenStatus").innerHTML = `<span class="warn">Requesting token renewal...</span>`;
  chrome.runtime.sendMessage({ type: "renew-token" }, (resp) => {
    renderTokenStatus();
    if (!resp || !resp.ok) {
      $("tokenStatus").innerHTML += ` <span class="bad">Renewal failed — open edstem.org while logged in instead (auto-grab will pick up the fresh token).</span>`;
    }
  });
});

$("clearCache").addEventListener("click", async () => {
  if (!confirm("Delete the entire cached Ed board (threads, answers, comments)?")) return;
  // Recreate by clearing all object stores via a fresh version bump is overkill;
  // just remove and let the next sync rebuild.
  indexedDB.deleteDatabase("ed-oracle");
  await chrome.storage.local.set({ lastSyncStatus: "cache cleared" });
  renderSyncStatus();
});

load();
