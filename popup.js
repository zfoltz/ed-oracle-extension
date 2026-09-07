// Ed Oracle — popup logic: ask, history, thread browsing.

const $ = (id) => document.getElementById(id);

// When loaded as the docked side panel (chrome.sidePanel), fill the panel
// instead of acting like a fixed-size popup.
if (new URLSearchParams(location.search).get("view") === "side") {
  document.documentElement.classList.add("side");
}

// ---------- tiny markdown renderer ----------

function esc(s) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(text) {
  let s = esc(text);
  const blocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (m, code) => {
    blocks.push(`<pre>${code.replace(/^\n/, "")}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+)/g, '$1<a href="$2" target="_blank">$2</a>');

  const lines = s.split("\n");
  const out = [];
  let inList = false;
  for (const line of lines) {
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${li[1]}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (line.trim() === "") continue;
    out.push(`<p>${line}</p>`);
  }
  if (inList) out.push("</ul>");
  s = out.join("");
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[+i]);
  return s;
}

// ---------- tabs ----------

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`)
    );
    if (btn.dataset.tab === "history") loadHistory();
    if (btn.dataset.tab === "threads") loadRecentThreads();
  });
}

$("settings-btn").addEventListener("click", () => chrome.runtime.openOptionsPage());

// ---------- status footer ----------

async function refreshStatus() {
  const [{ edToken, lastSyncStatus, lastSyncAt }, n] = await Promise.all([
    chrome.storage.local.get(["edToken", "lastSyncStatus", "lastSyncAt"]),
    DB.threadCount(),
  ]);
  const { courseId } = await chrome.storage.local.get("courseId");
  let parts = [];
  if (!edToken) {
    parts.push(`no Ed token — open edstem.org once`);
  } else {
    const exp = await new Promise((r) => chrome.storage.local.get("edTokenExp", (d) => r(d.edTokenExp)));
    if (exp) {
      const days = Math.floor((exp * 1000 - Date.now()) / 86400000);
      if (days <= 2) parts.push(`token expires in ${days}d`);
    }
  }
  parts.push(`${n} threads cached`);
  if (lastSyncAt) parts.push(`synced ${new Date(lastSyncAt).toLocaleTimeString()}`);
  else if (lastSyncStatus) parts.push(lastSyncStatus);
  $("status").textContent = parts.join(" · ");
}

// ---------- ask ----------

let asking = false;

// Draft persistence: the popup can vanish when you click elsewhere (e.g. to
// check something on Ed), so save the half-typed question and restore it.
const DRAFT_KEY = "draftQuestion";
let draftTimer = null;
$("question").addEventListener("input", (e) => {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const val = e.target.value;
    if (val.trim()) chrome.storage.local.set({ [DRAFT_KEY]: val });
    else chrome.storage.local.remove(DRAFT_KEY);
  }, 200);
});
chrome.storage.local.get(DRAFT_KEY, ({ [DRAFT_KEY]: draft }) => {
  if (draft && !$("question").value.trim()) {
    $("question").value = draft;
    $("question").focus();
  }
});

$("ask-btn").addEventListener("click", ask);
$("question").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ask();
});

async function ask() {
  if (asking) return;
  const question = $("question").value.trim();
  if (!question) return;

  asking = true;
  $("ask-btn").disabled = true;
  $("ask-btn").textContent = "Thinking...";
  const progress = $("ask-progress");
  const answerBox = $("ask-answer");
  progress.classList.remove("hidden");
  answerBox.classList.add("hidden");
  answerBox.innerHTML = "";
  progress.textContent = "";
  const log = (line) => {
    progress.textContent += (progress.textContent ? "\n" : "") + line;
    progress.scrollIntoView({ block: "end" });
  };

  const entry = {
    id: Date.now(),
    question,
    answer: "",
    trace: [],
    at: new Date().toISOString(),
    status: "running",
  };
  await DB.putHistory(entry);

  try {
    const { courseName } = await chrome.storage.local.get("courseName");
    const overview = await Agent.cacheOverview();
    const system = Agent.DEFAULT_SYSTEM(courseName || "CS 7643 (Deep Learning)");
    const user = `${overview}\n\nQuestion: ${question}`;
    log("(agent working...)");

    const answer = await Agent.runAgent({
      system,
      user,
      onProgress: (i, fn, args) => {
        const line = `[${i}] ${fn}(${String(args).slice(0, 70)})`;
        log(line);
        entry.trace.push(line);
      },
    });

    entry.answer = answer;
    entry.status = "done";
    await DB.putHistory(entry);
    chrome.storage.local.remove(DRAFT_KEY);
    answerBox.innerHTML = renderMarkdown(answer);
    answerBox.classList.remove("hidden");
    log("(done)");
  } catch (e) {
    entry.status = "error";
    entry.answer = `**Error:** ${e.message || e}`;
    await DB.putHistory(entry);
    answerBox.innerHTML = `<div class="error-box">${esc(e.message || e)}</div>`;
    answerBox.classList.remove("hidden");
    log(`(error: ${e.message || e})`);
  } finally {
    asking = false;
    $("ask-btn").disabled = false;
    $("ask-btn").textContent = "Ask the Oracle";
    refreshStatus();
  }
}

// ---------- history ----------

async function loadHistory() {
  const list = $("history-list");
  const entries = await DB.getHistory();
  $("history-count").textContent = entries.length
    ? `${entries.length} question${entries.length === 1 ? "" : "s"}`
    : "";
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = `<div class="empty">No questions yet. Ask one on the Ask tab.</div>`;
    return;
  }
  for (const e of entries) {
    const item = document.createElement("div");
    item.className = "history-item";
    const when = new Date(e.at).toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
    const badge =
      e.status === "error" ? " · error" :
      e.status === "running" ? " · in progress" : "";
    item.innerHTML = `
      <div class="history-q">
        <span class="q">${esc(e.question)}</span>
        <span class="when">${esc(when)}${badge}</span>
      </div>
      <div class="history-a">
        <div class="history-meta">${(e.trace || []).length} tool calls</div>
        ${e.trace && e.trace.length ? `<div class="trace">${esc(e.trace.join("\n"))}</div>` : ""}
        <div class="answer-body">${e.answer ? renderMarkdown(e.answer) : '<span class="muted">(no answer yet)</span>'}</div>
        <button class="link-btn danger history-del">Delete</button>
      </div>`;
    item.querySelector(".history-q").addEventListener("click", () => item.classList.toggle("open"));
    item.querySelector(".history-del").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await DB.deleteHistory(e.id);
      loadHistory();
    });
    list.appendChild(item);
  }
}

$("clear-history").addEventListener("click", async () => {
  if (!confirm("Delete all saved questions and answers?")) return;
  await DB.clearHistory();
  loadHistory();
});

// ---------- threads ----------

const KIND_BADGES = {
  thread: "post",
  answer: "answer",
  accepted: "accepted",
  comment: "comment",
};

async function loadRecentThreads() {
  const results = $("thread-results");
  results.innerHTML = "";
  const all = await DB.getAllThreads();
  const rows = all
    .filter((t) => !t.deleted)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 40);
  if (!rows.length) {
    results.innerHTML = `<div class="empty">Cache is empty — hit &#8635; to sync, or wait for the background sync.</div>`;
    return;
  }
  for (const t of rows) results.appendChild(threadCard(t, null));
}

async function loadThreadSearch(q) {
  const results = $("thread-results");
  const hits = await DB.search(q, 25);
  results.innerHTML = "";
  if (!hits.length) {
    results.innerHTML = `<div class="empty">No matches for &quot;${esc(q)}&quot;.</div>`;
    return;
  }
  const threadIds = [...new Set(hits.map((h) => h.threadId))];
  const byId = {};
  for (const id of threadIds) byId[id] = await DB.getThread(id);
  for (const h of hits) {
    const t = byId[h.threadId];
    if (!t || t.deleted) continue;
    results.appendChild(threadCard(t, h));
  }
}

let POPUP_COURSE_ID = 100459;
chrome.storage.local.get("courseId", ({ courseId }) => { if (courseId) POPUP_COURSE_ID = courseId; });

function threadCard(t, hit) {
  const el = document.createElement("a");
  el.className = "thread-hit";
  el.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: el.href, active: true });
  });
  const title = document.createElement("div");
  title.className = "t";
  title.textContent = t.title || `(thread ${t.id})`;
  el.appendChild(title);

  const snippet = document.createElement("div");
  snippet.className = "s";
  snippet.textContent = hit ? hit.snippet : `${t.category || "?"}/${t.subcategory || "-"} · ${(t.updated_at || "").slice(0, 10)} · ${t.reply_count} replies`;
  el.appendChild(snippet);

  const badges = document.createElement("div");
  badges.className = "badges";
  if (hit) {
    const b = document.createElement("span");
    b.className = `badge ${hit.kind}`;
    b.textContent = KIND_BADGES[hit.kind] || hit.kind;
    badges.appendChild(b);
  }
  if (t.is_staff_answered) {
    const b = document.createElement("span");
    b.className = "badge staff";
    b.textContent = "staff answered";
    badges.appendChild(b);
  } else if (t.is_answered) {
    const b = document.createElement("span");
    b.className = "badge answer";
    b.textContent = "answered";
    badges.appendChild(b);
  } else {
    const b = document.createElement("span");
    b.className = "badge unanswered";
    b.textContent = "unanswered";
    badges.appendChild(b);
  }
  if (t.is_pinned) {
    const b = document.createElement("span");
    b.className = "badge pinned";
    b.textContent = "pinned";
    badges.appendChild(b);
  }
  el.appendChild(badges);

  // link (with comment anchor if hit)
  el.href = `https://edstem.org/us/courses/${POPUP_COURSE_ID}/discussion/${t.id}` +
    (hit && hit.kind !== "thread" ? `?comment=${hit.refId}` : "");
  return el;
}

let searchTimer = null;
$("thread-search").addEventListener("input", (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (q.length >= 2) loadThreadSearch(q);
    else loadRecentThreads();
  }, 250);
});

// ---------- sync button ----------

$("sync-btn").addEventListener("click", async () => {
  const btn = $("sync-btn");
  btn.disabled = true;
  $("status").textContent = "syncing...";
  chrome.runtime.sendMessage({ type: "sync-now" }, (resp) => {
    $("sync-btn").disabled = false;
    if (chrome.runtime.lastError) {
      $("status").textContent = `sync error: ${chrome.runtime.lastError.message}`;
      return;
    }
    if (resp && resp.ok) {
      $("status").textContent = `OK: ${resp.message}`;
      loadRecentThreads();
      refreshStatus();
    } else {
      $("status").textContent = `sync error: ${resp && resp.error}`;
    }
  });
});

// ---------- init ----------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.lastSyncStatus || changes.edToken || changes.edTokenExp)) {
    refreshStatus();
  }
});
refreshStatus();
