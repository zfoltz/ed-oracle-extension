// Ed Oracle — agentic LLM Q&A loop over the local cache. Plain script (globals).
// Talks to any OpenAI-compatible /chat/completions endpoint.

const Agent = (() => {
  const MAX_TOOL_RESULT_CHARS = 12000;
  const MAX_ITERATIONS = 12;

  const TOOLS = [
    {
      type: "function",
      function: {
        name: "search_cache",
        description:
          "Full-text search over the cached Ed Discussion corpus (thread posts, answers, comments). " +
          "Ranked by relevance. Use plain keywords; multiple words broaden. " +
          "Example: search_cache('office hours schedule')",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "search keywords" },
            limit: { type: "integer", default: 20 },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_thread",
        description:
          "Read the full text of one thread: post body, category, status flags, and its comments/answers " +
          "with authors, roles, endorsed/accepted markers and permalinks. Long threads (megathreads) are " +
          "paginated via comment_offset/comment_limit.",
        parameters: {
          type: "object",
          properties: {
            thread_id: { type: "integer" },
            comment_offset: { type: "integer", default: 0 },
            comment_limit: { type: "integer", default: 60 },
          },
          required: ["thread_id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_threads",
        description:
          "List cached threads (most recent activity first) with title, category, dates and status flags. Optional filters.",
        parameters: {
          type: "object",
          properties: {
            category: { type: "string", description: "category/subcategory substring, e.g. 'Quizzes' or 'A1'" },
            answered_only: { type: "boolean" },
            staff_answered_only: { type: "boolean" },
            limit: { type: "integer", default: 30 },
            offset: { type: "integer", default: 0 },
          },
        },
      },
    },
  ];

  function truncate(text, limit = MAX_TOOL_RESULT_CHARS) {
    if (text.length <= limit) return text;
    return text.slice(0, limit) + `\n...[truncated, ${text.length} chars total]`;
  }

  function threadUrl(courseId, threadId, commentId = null) {
    let url = `https://edstem.org/us/courses/${courseId}/discussion/${threadId}`;
    if (commentId) url += `?comment=${commentId}`;
    return url;
  }

  // ---------- tool implementations ----------

  async function toolSearchCache(args) {
    const { courseId } = await chrome.storage.local.get("courseId");
    const limit = Math.min(parseInt(args.limit || 20, 10), 50);
    const hits = await DB.search(args.query || "", limit);
    if (!hits.length) return "No matches. Try fewer/different keywords.";
    return hits
      .map((h) => {
        const url = threadUrl(courseId, h.threadId, h.kind !== "thread" ? h.refId : null);
        return `[${h.kind}] ${h.title} | thread ${h.threadId} | ${url}\n    ${h.snippet}`;
      })
      .join("\n");
  }

  async function toolGetThread(args) {
    const { courseId } = await chrome.storage.local.get("courseId");
    const t = await DB.getThread(args.thread_id);
    if (!t || t.deleted) return `Thread ${args.thread_id} not found in cache (it may be private, deleted, or not yet synced).`;

    const offset = args.comment_offset || 0;
    const pageLimit = args.comment_limit || 60;
    const url = threadUrl(courseId, t.id);
    const head = [
      `# ${t.title}`,
      `URL: ${url}`,
      `Category: ${t.category || ""}/${t.subcategory || ""} | Author: ${t.author_name} (${t.author_role}) | ` +
        `Posted: ${(t.created_at || "").slice(0, 10)} | Last activity: ${(t.updated_at || "").slice(0, 10)} | Votes: ${t.vote_count}`,
      `Status: ${t.is_answered ? "answered" : "unanswered"}${t.is_staff_answered ? ", staff-answered" : ""}${t.is_pinned ? ", pinned" : ""}`,
      "",
      "POST:",
      truncate(t.document || "", 8000),
      "",
    ];
    const comments = (t.comments || []).slice().sort(
      (a, b) => (b.is_answer - a.is_answer) || (b.is_endorsed - a.is_endorsed) || String(a.created_at).localeCompare(String(b.created_at))
    );
    const total = comments.length;
    const page = comments.slice(offset, offset + pageLimit);
    const body = [
      `COMMENTS/ANSWERS (showing ${offset + 1}-${offset + page.length} of ${total}; page with comment_offset to see more):`,
    ];
    for (const c of page) {
      const label = c.is_accepted ? "ACCEPTED ANSWER" : c.is_endorsed ? "Endorsed answer" : c.is_answer ? "Answer" : "Comment";
      const curl = threadUrl(courseId, t.id, c.id);
      body.push(`\n--- [${label}] ${c.author_name} (${c.author_role}) on ${(c.created_at || "").slice(0, 10)} | ${curl}`);
      body.push(truncate(c.document || "", 2500));
    }
    if (offset + pageLimit < total) {
      body.push(`\n(... ${total - offset - page.length} more comments not shown; use comment_offset=${offset + page.length} to continue)`);
    }
    return head.concat(body).join("\n");
  }

  async function toolListThreads(args) {
    const { courseId } = await chrome.storage.local.get("courseId");
    const all = await DB.getAllThreads();
    const category = (args.category || "").toLowerCase();
    let rows = all.filter((t) => !t.deleted);
    if (category) {
      const c = category.toLowerCase();
      rows = rows.filter(
        (t) =>
          (t.category || "").toLowerCase().includes(c) ||
          (t.subcategory || "").toLowerCase().includes(c) ||
          (t.title || "").toLowerCase().includes(c)
      );
    }
    if (args.answered_only) rows = rows.filter((t) => t.is_answered);
    if (args.staff_answered_only) rows = rows.filter((t) => t.is_staff_answered);
    rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    const offset = args.offset || 0;
    const limit = Math.min(args.limit || 30, 100);
    rows = rows.slice(offset, offset + limit);
    if (!rows.length) return "No threads match.";
    return rows
      .map((r) => {
        const flags = [];
        if (r.is_answered) flags.push("answered");
        if (r.is_staff_answered) flags.push("staff");
        if (r.is_pinned) flags.push("pinned");
        return `${r.id} | ${(r.updated_at || "").slice(0, 10)} | ${r.category || ""}/${r.subcategory || ""} | ` +
          `${r.reply_count} replies | ${flags.join(",") || "-"} | ${r.title} | ${threadUrl(courseId, r.id)}`;
      })
      .join("\n");
  }

  const TOOL_IMPLS = {
    search_cache: (a) => toolSearchCache(a),
    get_thread: (a) => toolGetThread(a),
    list_threads: (a) => toolListThreads(a),
  };

  async function executeTool(name, argsJson) {
    try {
      const args = argsJson ? JSON.parse(argsJson) : {};
      const impl = TOOL_IMPLS[name];
      if (!impl) return `Unknown tool: ${name}`;
      return truncate(await impl(args));
    } catch (e) {
      return `Tool error: ${e.message || e}`;
    }
  }

  // ---------- LLM chat ----------

  async function chat(messages, tools = null, maxTokens = 4096, temperature = 0.2) {
    const { llmBaseUrl, llmApiKey, llmModel } = await chrome.storage.local.get([
      "llmBaseUrl", "llmApiKey", "llmModel",
    ]);
    if (!llmApiKey) throw new Error("LLM API key not configured — open Settings and add your endpoint + key.");
    const payload = {
      model: llmModel || "gpt-4o-mini",
      messages,
      temperature,
      max_tokens: maxTokens,
    };
    if (tools) payload.tools = tools;
    const resp = await fetch(llmBaseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmApiKey}`,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      let detail = "";
      try {
        const data = await resp.json();
        detail = (data.error && data.error.message) || JSON.stringify(data).slice(0, 300);
      } catch (e) {
        detail = resp.statusText;
      }
      throw new Error(`LLM HTTP ${resp.status}: ${detail}`);
    }
    const data = await resp.json();
    const msg = data.choices[0].message;
    const toolCalls = (msg.tool_calls || []).map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
    return { content: msg.content || "", toolCalls };
  }

  // ---------- agent loop ----------

  async function runAgent({ system, user, onProgress = null }) {
    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const { content, toolCalls } = await chat(messages, TOOLS);
      if (!toolCalls.length) return content;
      messages.push({ role: "assistant", content: content || "", tool_calls: toolCalls });
      for (const tc of toolCalls) {
        const fn = tc.function.name;
        if (onProgress) onProgress(i + 1, fn, tc.function.arguments);
        const result = await executeTool(fn, tc.function.arguments);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
    }
    const { content } = await chat(messages, null);
    return content;
  }

  async function cacheOverview() {
    const [n, nComments, last, cats] = await Promise.all([
      DB.threadCount(),
      DB.commentCount(),
      DB.getMeta("last_sync", "never"),
      DB.categoryOverview(),
    ]);
    const catLines = cats.map(([k, v]) => `  ${k}: ${v}`).join("\n");
    return `Cache: ${n} threads, ${nComments} comments/answers, last synced ${last}.\nCategories:\n${catLines}`;
  }

  const DEFAULT_SYSTEM = (courseName) =>
    `You are the "${courseName} Oracle", answering questions about the ${courseName} course. ` +
    `You have tools to explore a local cache of the course's Ed Discussion board. Cache stats and categories are provided in the user message.

Method:
- Investigate before answering. Start with search_cache using likely keywords. Try several query variants if the first misses - other people's phrasing may differ from yours.
- Use get_thread to read promising threads in full. Read accepted/endorsed/staff answers carefully; they carry the most authority. For megathreads, page with comment_offset.
- Use list_threads to orient (categories, what's pinned, what's recent) or to enumerate questions in a category.
- Stop searching once you can answer confidently; 2-5 tool calls is typical. Don't loop on the same query with no variation.

Answer rules:
- Ground every claim in the cache. Cite sources with their URLs inline.
- If the cache doesn't contain the answer, say so plainly and point to the closest related threads (with URLs). Never invent policy, deadlines, or instructor statements.
- Prefer the most recent information when posts conflict; note the date of what you cite.
- Be concise: a few sentences to a short structured answer. Use markdown links.`;

  return { runAgent, chat, cacheOverview, DEFAULT_SYSTEM, threadUrl };
})();
