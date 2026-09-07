// Ed Oracle — IndexedDB cache + search. Plain script (globals), shared by
// popup pages and the service worker.

const DB = (() => {
  const NAME = "ed-oracle";
  const VERSION = 1;
  let dbPromise = null;
  let searchCache = null; // {version, docs}

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("threads")) {
          d.createObjectStore("threads", { keyPath: "id" });
        }
        if (!d.objectStoreNames.contains("history")) {
          d.createObjectStore("history", { keyPath: "id" });
        }
        if (!d.objectStoreNames.contains("meta")) {
          d.createObjectStore("meta", { keyPath: "key" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return open().then((d) => d.transaction(store, mode).objectStore(store));
  }

  function wrap(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ---------- meta ----------

  async function getMeta(key, fallback = null) {
    const store = await tx("meta", "readonly");
    const row = await wrap(store.get(key));
    return row ? row.value : fallback;
  }

  async function setMeta(key, value) {
    const store = await tx("meta", "readwrite");
    await wrap(store.put({ key, value }));
  }

  // ---------- threads ----------

  async function getThread(id) {
    const store = await tx("threads", "readonly");
    return wrap(store.get(id));
  }

  async function getAllThreads() {
    const store = await tx("threads", "readonly");
    return wrap(store.getAll());
  }

  // Upsert list-level fields without clobbering detail data.
  async function upsertThreadList(t, authorName, authorRole, syncedAt) {
    const store = await tx("threads", "readwrite");
    const existing = await wrap(store.get(t.id));
    const rec = existing || { id: t.id, comments: [], document: "", detail_synced_at: null };
    Object.assign(rec, {
      number: t.number,
      title: t.title,
      type: t.type,
      category: t.category,
      subcategory: t.subcategory,
      created_at: t.created_at,
      updated_at: t.updated_at,
      is_answered: !!t.is_answered,
      is_staff_answered: !!t.is_staff_answered,
      is_pinned: !!t.is_pinned,
      is_locked: !!t.is_locked,
      is_private: !!t.is_private,
      is_anonymous: !!t.is_anonymous,
      reply_count: t.reply_count || 0,
      unresolved_count: t.unresolved_count || 0,
      vote_count: t.vote_count || 0,
      view_count: t.view_count || 0,
      user_id: t.user_id,
      author_name: authorName,
      author_role: authorRole,
      deleted: false,
      synced_at: syncedAt,
    });
    await wrap(store.put(rec));
    invalidate();
  }

  // Store full detail: body document + flattened comments/answers.
  async function storeThreadDetail(detail, authorName, authorRole) {
    const thread = detail.thread;
    const users = detail.users || [];
    const userMap = {};
    for (const u of users) if (u) userMap[u.id] = u;

    const store = await tx("threads", "readwrite");
    const rec = (await wrap(store.get(thread.id))) || { id: thread.id };
    const doc = thread.document || thread.content || "";

    if (!authorName) [authorName, authorRole] = authorInfo(userMap, thread.user_id, thread.is_anonymous);

    const comments = [];
    const seen = new Set();

    function flatten(node, isAnswer) {
      const out = [[node, isAnswer]];
      for (const child of node.comments || []) {
        out.push(...flatten(child, child.type === "answer"));
      }
      return out;
    }

    function addComment(c, isAnswer) {
      if (seen.has(c.id)) return;
      seen.add(c.id);
      const [name, role] = authorInfo(userMap, c.user_id, c.is_anonymous);
      comments.push({
        id: c.id,
        parent_id: c.parent_id,
        is_answer: !!(isAnswer || c.id === thread.accepted_id),
        is_accepted: c.id === thread.accepted_id,
        is_endorsed: !!c.is_endorsed,
        is_resolved: !!c.is_resolved,
        kind: c.kind || "normal",
        author_name: name,
        author_role: role,
        document: c.document || c.content || "",
        created_at: c.created_at,
      });
    }

    for (const a of thread.answers || []) {
      for (const [c, isAns] of flatten(a, true)) addComment(c, isAns);
    }
    for (const c of thread.comments || []) {
      for (const [cc] of flatten(c, false)) addComment(cc, cc.type === "answer");
    }

    Object.assign(rec, {
      document: doc,
      author_name: authorName || rec.author_name,
      author_role: authorRole || rec.author_role,
      comments,
      detail_synced_at: new Date().toISOString(),
    });
    await wrap(store.put(rec));
    invalidate();
  }

  async function markDeleted(ids) {
    const store = await tx("threads", "readwrite");
    for (const id of ids) {
      const rec = await wrap(store.get(id));
      if (rec) {
        rec.deleted = true;
        await wrap(store.put(rec));
      }
    }
    invalidate();
  }

  function authorInfo(userMap, userId, isAnonymous) {
    if (isAnonymous) return ["Anonymous", "anonymous"];
    const u = userMap[userId];
    if (!u) return ["Unknown", "unknown"];
    let role = u.course_role || u.role || "student";
    if (role === "user") role = "student";
    return [u.name || "Unknown", role];
  }

  async function threadCount() {
    const store = await tx("threads", "readonly");
    const all = await wrap(store.getAll());
    return all.filter((t) => !t.deleted).length;
  }

  async function commentCount() {
    const store = await tx("threads", "readonly");
    const all = await wrap(store.getAll());
    return all.filter((t) => !t.deleted).reduce((n, t) => n + (t.comments || []).length, 0);
  }

  async function categoryOverview() {
    const store = await tx("threads", "readonly");
    const all = await wrap(store.getAll());
    const counts = {};
    for (const t of all) {
      if (t.deleted) continue;
      const key = `${t.category || "?"}/${t.subcategory || "-"}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  }

  // ---------- search ----------

  const STOPWORDS = new Set(
    ("a an the is are was were be been being do does did can could should would will shall " +
      "i we you it its this that these those of for to in on at by with about from and or not " +
      "no if as so than then too how what when where which who whom why have has had having my " +
      "our their there").split(" ")
  );

  function tokenize(text) {
    const out = [];
    const re = /[a-z0-9_]{2,}/g;
    const s = (text || "").toLowerCase();
    let m;
    while ((m = re.exec(s))) {
      if (!STOPWORDS.has(m[0])) out.push(m[0]);
    }
    return out;
  }

  function invalidate() {
    searchCache = null;
  }

  async function buildDocs() {
    const store = await tx("threads", "readonly");
    const all = await wrap(store.getAll());
    const docs = [];
    for (const t of all) {
      if (t.deleted) continue;
      if (t.document && t.document.trim()) {
        docs.push({
          kind: "thread",
          threadId: t.id,
          refId: t.id,
          title: t.title || "",
          text: t.document,
        });
      }
      for (const c of t.comments || []) {
        if (c.document && c.document.trim()) {
          docs.push({
            kind: c.is_accepted ? "accepted" : c.is_answer ? "answer" : "comment",
            threadId: t.id,
            refId: c.id,
            title: t.title || "",
            text: c.document,
            isAccepted: !!c.is_accepted,
            isEndorsed: !!c.is_endorsed,
          });
        }
      }
    }
    return docs;
  }

  async function ensureIndex() {
    const store = await tx("threads", "readonly");
    const all = await wrap(store.getAll());
    const version = all.length + ":" + all.reduce((n, t) => n + (t.detail_synced_at ? 1 : 0), 0);
    if (searchCache && searchCache.version === version) return searchCache;
    const docs = await buildDocs();
    // doc -> {term: tf}
    const index = docs.map((d) => {
      const tf = {};
      for (const tok of tokenize(d.text)) tf[tok] = (tf[tok] || 0) + 1;
      for (const tok of tokenize(d.title)) tf["\u0001" + tok] = (tf["\u0001" + tok] || 0) + 3; // title boost
      return tf;
    });
    const df = {};
    for (const tf of index) for (const term in tf) df[term] = (df[term] || 0) + 1;
    searchCache = { version, docs, index, df, N: docs.length };
    return searchCache;
  }

  async function search(query, limit = 20) {
    const { docs, index, df, N } = await ensureIndex();
    const qTerms = tokenize(query);
    if (!qTerms.length) return [];

    const scored = [];
    for (let i = 0; i < docs.length; i++) {
      const tf = index[i];
      let score = 0;
      let matched = 0;
      for (const q of qTerms) {
        let best = 0;
        for (const term in tf) {
          if (term === q) best = Math.max(best, tf[term]);
          else if (q.length >= 4 && (term.startsWith(q) || q.startsWith(term))) {
            const stem = term.replace(/^\u0001/, "").startsWith(q.replace(/^\u0001/, "")) ||
                         q.replace(/^\u0001/, "").startsWith(term.replace(/^\u0001/, ""));
            if (stem) best = Math.max(best, tf[term] * 0.8);
          }
        }
        if (best > 0) {
          matched++;
          const idf = Math.log(1 + N / (1 + (df[q] || 0)));
          score += idf * (best / (best + 1.2));
        }
      }
      if (score > 0) {
        let s = score;
        if (docs[i].isAccepted) s *= 1.5;
        else if (docs[i].isEndorsed) s *= 1.2;
        scored.push([s, i]);
      }
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map(([score, i]) => {
      const d = docs[i];
      return {
        kind: d.kind,
        threadId: d.threadId,
        refId: d.refId,
        title: d.title,
        score,
        snippet: makeSnippet(d.text, qTerms),
      };
    });
  }

  function makeSnippet(text, qTerms) {
    const lower = (text || "").toLowerCase();
    let pos = -1;
    for (const q of qTerms) {
      const p = lower.indexOf(q);
      if (p !== -1 && (pos === -1 || p < pos)) pos = p;
    }
    if (pos === -1) return (text || "").slice(0, 160);
    const start = Math.max(0, pos - 60);
    const end = Math.min(text.length, pos + 140);
    return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
  }

  // ---------- history ----------

  async function getHistory() {
    const store = await tx("history", "readonly");
    const all = await wrap(store.getAll());
    return all.sort((a, b) => b.id - a.id);
  }

  async function putHistory(entry) {
    const store = await tx("history", "readwrite");
    await wrap(store.put(entry));
  }

  async function deleteHistory(id) {
    const store = await tx("history", "readwrite");
    await wrap(store.delete(id));
  }

  async function clearHistory() {
    const store = await tx("history", "readwrite");
    await wrap(store.clear());
  }

  return {
    getMeta, setMeta,
    getThread, getAllThreads, upsertThreadList, storeThreadDetail, markDeleted,
    threadCount, commentCount, categoryOverview,
    search, getHistory, putHistory, deleteHistory, clearHistory,
  };
})();
