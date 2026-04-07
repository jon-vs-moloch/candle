const STORAGE_KEY = "candle-state-v3";
const DEBUG_STATE_ENDPOINT = "/api/debug-state";
const DEBUG_EVENT_ENDPOINT = "/api/debug-event";
const MAX_ACTIVE_PACKAGES = 8;
const MAX_CONTEXT_PACKAGES = 40;
const MAX_DECISIONS = 36;
const MAX_ACTIVITY = 30;
const DEFAULT_COOLDOWN_MS = 1200;
const ERROR_COOLDOWN_MS = 4000;
const DEFAULT_MANAGED_CONTEXT_BUDGET_TOKENS = 3000;
const TOTAL_REQUEST_BUDGET_TOKENS = 10000;
const CONTEXT_GRID_SIZE = 24;
const CONTEXT_GRID_CELLS = CONTEXT_GRID_SIZE * CONTEXT_GRID_SIZE;

const SHARED_PROMPT_GUIDANCE_LINES = [
  "When you learn something durable, operationally useful, or likely to matter later, record it in maintained context.",
  "Prefer explicit task or note structures for ongoing work instead of relying on transient reasoning alone.",
  "Prefer conversational cadence: short useful messages, then follow up later if more needs to be said.",
  "Before saying something again, ask whether it has already effectively been said in recent processed conversation and whether repeating it would add real value.",
  "If you re-engage after a pause, do not mechanically restate the same message. Either add new value, clarify something unresolved, or vary the phrasing so it feels like a real continuation rather than a duplicate.",
  "Treat maintained context as your real working memory: preserve plans, discoveries, open loops, and learned constraints there.",
  "The outer chat process can begin useful work without fully explaining how the inner loop will help; maintained context is what lets that work continue.",
  "You are always seeing a current snapshot of an ongoing process advanced by prior turns. Leave the system in a better state for the next turn that inherits your work.",
  "Continue plans already in progress when they still make sense. If you create or refine a plan, expect future turns to inherit it and continue from what you leave behind.",
  "Think a little ahead: when a likely next direction is visible, it is good to prepare lightweight context or structure for it before it becomes urgent.",
  "Recent system notices are authoritative handoffs from freshly processed chat. If they conflict with older task assumptions, reconcile the older state in favor of the newer processed turn."
];

const CHAT_PROMPT_GUIDANCE_LINES = [
  "When the user starts or changes an ongoing task, make that structure legible so the maintenance loop can carry it forward.",
  "Prefer short, natural messages over monologues unless the user clearly wants a long answer.",
  "Do not restate the same greeting, question, or suggestion unless something changed or the user appears to need clarification.",
  "If the user starts a multi-step sequence, it is fine to begin with the next obvious move and rely on maintained context plus the inner loop to continue it.",
  "Stay conversational unless architecture itself is the topic; do not over-explain the system just because it is present."
];

const BACKGROUND_PROMPT_GUIDANCE_LINES = [
  "- For in-progress work, prefer creating or updating hierarchical task structures so progress, substeps, and next actions are explicit.",
  "- When you learn something durable, operationally useful, or likely to matter later, record it as context instead of leaving it only implicit in reasoning.",
  "- Use parent nodes to summarize what a subtree means; use children for steps, evidence, options, or subordinate notes.",
  "- For multi-step sequences, maintain progress explicitly in context so future turns can continue the work without re-deriving the plan.",
  "- Favor conversational continuity: short relevant follow-ups are good, but do not flood the channel or repeat yourself.",
  "- Before using send_message_to_user, check whether the same point has already been made in recent processed chat. If it has, prefer do_nothing unless a new clarification, escalation, or genuinely fresh angle is needed.",
  "- If re-engaging after time has passed, vary phrasing and add a new reason to speak. Do not send a near-copy of an earlier assistant message just because the conversation has been quiet.",
  "- Prefer concrete cognitive work over meta-commentary: distill, connect, plan, notice constraints, track progress, and prepare useful next moves.",
  "- Useful inner-loop work includes: creating or refining task trees, attaching new notes to active projects, extracting durable learnings from chat, merging overlapping notes, and marking what is use-or-lose under context pressure.",
  "- Refer to packages by title in your own reasoning whenever possible. Use ids only as exact handles.",
  "- Treat yourself as one step in a longer maintenance chain: inherit the work of prior turns, advance it concretely, and hand a clearer state to the next successor turn.",
  "- If a plan or sequence is already in progress, prefer continuing it over restarting or redescribing it.",
  "- If you create a plan, note, or task structure, create it so successor turns can pick it up directly without re-deriving your intent.",
  "- Think ahead to nearby likely branches of the conversation or task. It is often useful to create small preparatory notes, options, or task stubs before they are urgently needed.",
  "- Prepare for plausible next directions, but stay lightweight: do not spam speculative structures for unlikely futures.",
  "- Treat recent system notices as authoritative chat-to-background handoffs. When a processed turn resolves or changes an assumption, update stale tasks and notes accordingly.",
  "- If stale background carryover is present, do not replay it blindly. Amend or reinterpret it against the newer conversation state and use only the parts that still make sense."
];

const nowIso = () => new Date().toISOString();

const uid = (prefix) =>
  `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const escapeAttr = (value) => escapeHtml(value).replaceAll("`", "&#96;");

const estimateTextTokens = (text) =>
  Math.max(1, Math.ceil(String(text || "").length / 4));

const getManagedContextBudgetTokens = (currentState) =>
  Math.max(256, Number(currentState?.config?.maxContextTokens ?? DEFAULT_MANAGED_CONTEXT_BUDGET_TOKENS));

function compactPromptText(text, maxChars = 240) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function renderMarkdownInline(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  return html;
}

function renderMarkdown(text) {
  const source = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!source) return "";

  const fencePattern = /```([\w-]+)?\n([\s\S]*?)```/g;
  const blocks = [];
  let lastIndex = 0;
  let match;

  while ((match = fencePattern.exec(source))) {
    if (match.index > lastIndex) {
      blocks.push({ type: "text", content: source.slice(lastIndex, match.index) });
    }
    blocks.push({
      type: "code",
      lang: String(match[1] || "").trim(),
      content: match[2]
    });
    lastIndex = fencePattern.lastIndex;
  }

  if (lastIndex < source.length) {
    blocks.push({ type: "text", content: source.slice(lastIndex) });
  }

  return blocks
    .map((block) => {
      if (block.type === "code") {
        const langClass = block.lang ? ` class="language-${escapeAttr(block.lang)}"` : "";
        return `<pre class="markdown-code"><code${langClass}>${escapeHtml(block.content)}</code></pre>`;
      }

      const lines = block.content.split("\n");
      const parts = [];
      let paragraph = [];
      let listItems = [];

      const flushParagraph = () => {
        if (!paragraph.length) return;
        parts.push(`<p>${paragraph.map((line) => renderMarkdownInline(line)).join("<br>")}</p>`);
        paragraph = [];
      };

      const flushList = () => {
        if (!listItems.length) return;
        parts.push(`<ul>${listItems.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join("")}</ul>`);
        listItems = [];
      };

      lines.forEach((line) => {
        const trimmed = line.trim();
        const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
        if (!trimmed) {
          flushParagraph();
          flushList();
          return;
        }
        if (listMatch) {
          flushParagraph();
          listItems.push(listMatch[1]);
          return;
        }
        flushList();
        paragraph.push(trimmed);
      });

      flushParagraph();
      flushList();
      return parts.join("");
    })
    .join("");
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function relativeTime(value) {
  if (!value) return "never";

  const diffMs = Date.now() - new Date(value).getTime();
  const diffMin = Math.round(diffMs / 60000);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  return `${Math.round(diffHr / 24)}d ago`;
}

function makeTitle(text, fallback = "Context package") {
  const cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return fallback;

  const first = cleaned.split(/(?<=[.!?])\s+/).find(Boolean) ?? cleaned;
  const compact = first.replace(/[.!?]+$/, "").trim();
  return compact.length > 42 ? `${compact.slice(0, 39)}...` : compact;
}

function parseJsonObject(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) throw new Error("Empty model output");

  try {
    return JSON.parse(cleaned);
  } catch {}

  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    return JSON.parse(fenced[1]);
  }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }

  throw new Error("Unable to parse JSON object from model output.");
}

function normalizeAssistantText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const maybeMessage = payload?.choices?.[0]?.message?.content;
  if (typeof maybeMessage === "string" && maybeMessage.trim()) {
    return maybeMessage.trim();
  }

  if (Array.isArray(maybeMessage)) {
    return maybeMessage
      .map((part) => part?.text ?? part?.content ?? "")
      .join("")
      .trim();
  }

  const output = payload?.output?.flatMap((item) => item?.content ?? []) ?? [];
  return output.map((part) => part?.text ?? "").join("").trim();
}

function createContextPackage(partial = {}) {
  const timestamp = nowIso();
  const summary = String(
    partial.summary ?? partial.description ?? partial.content ?? ""
  ).trim();
  const content = String(partial.contentDetails ?? partial.details ?? partial.body ?? "").trim();
  if (!summary && !content) return null;

  const pinned = Boolean(partial.pinned);

  return {
    id: partial.id ?? uid("pkg"),
    title: String(partial.title || makeTitle(summary || content)).trim(),
    summary: summary || content,
    content,
    kind: partial.kind ?? "fact",
    parentId: partial.parentId ? String(partial.parentId).trim() : null,
    childIds: Array.isArray(partial.childIds) ? partial.childIds.map(String) : [],
    order: Number(partial.order ?? Date.now()),
    priority: clamp(Number(partial.priority ?? 0.55), 0.05, 1),
    pinned,
    readOnly: Boolean(partial.readOnly),
    lineageHue: Number.isFinite(Number(partial.lineageHue)) ? Number(partial.lineageHue) : null,
    turnsLeft: pinned ? 999 : clamp(Number(partial.turnsLeft ?? 6), 0, 18),
    status: partial.status ?? "active",
    source: partial.source ?? "system",
    usageCount: Number(partial.usageCount ?? 0),
    createdAt: partial.createdAt ?? timestamp,
    lastTouchedAt: partial.lastTouchedAt ?? timestamp,
    lastUsedAt: partial.lastUsedAt ?? null
  };
}

function normalizeChatMessage(partial = {}) {
  const trimmed = String(partial.text || "").trim();
  if (!trimmed) return null;

  return {
    id: partial.id ?? uid("msg"),
    role: partial.role === "assistant" ? "assistant" : "user",
    kind: partial.kind ?? "reply",
    text: trimmed,
    createdAt: partial.createdAt ?? nowIso(),
    processed: partial.processed !== false,
    processedAt: partial.processed === false
      ? null
      : partial.processedAt ?? partial.createdAt ?? nowIso()
  };
}

function createInitialState() {
  const createdAt = nowIso();
  const productFrameId = uid("pkg");
  const onboardingRootId = uid("pkg");
  const nameTaskId = uid("pkg");
  const structureTaskId = uid("pkg");
  const continuityTaskId = uid("pkg");
  const sharedPrompt = [
    "You are Candle, a persistent assistant with a continuous inner maintenance process and an outer chat process.",
    "Maintain a coherent, stable self-model across both processes.",
    "Prefer updating or strengthening existing context over creating near-duplicate context.",
    "Preserve operative intent when compressing context.",
    "Revise beliefs only when there is evidence to do so.",
    "Proactive outreach should be useful, specific, and worth interrupting the user for.",
    ...SHARED_PROMPT_GUIDANCE_LINES
  ].join("\n");
  const chatPrompt = [
    "Respond to the user naturally.",
    "Use the maintained context packages as your primary memory substrate.",
    "Do not recite or explain the architecture unless it is relevant.",
    ...CHAT_PROMPT_GUIDANCE_LINES
  ].join("\n");
  const backgroundPrompt = [
    "You are operating in Candle's inner maintenance loop.",
    "At each step, inspect the current maintained context and choose exactly one tool call.",
    "After the tool executes, you will be invoked again with updated state.",
    "Return strict JSON only.",
    `Schema:
{
  "tool": "continue_turn",
  "reason": string,
  "summary": string,
  "action": {
    "tool": "create_context_chunk" | "create_child_context_chunk" | "update_context_chunk" | "move_context_chunk" | "summarize_context_chunk" | "focus_context_chunk" | "merge_context_chunks" | "delete_context_chunk" | "retitle_context_chunk" | "send_message_to_user" | "do_nothing",
    "args": object
  }
}`,
    "Backward compatibility: flat outputs with top-level tool/args/reason/summary are still accepted, but prefer continue_turn.",
    "Guidance:",
    "- Use do_nothing when the current state is already fine.",
    "- Prefer package titles in reasoning and summaries. Use ids only as precise handles when needed.",
    "- Context is hierarchical. Parent nodes usually summarize what their children mean or contain.",
    "- Use create_context_chunk to add a new root-level maintained idea. Preferred args shape: { title, summary, details?, kind, priority, turnsLeft }.",
    "- Use create_child_context_chunk to add a child under an existing package. Preferred args shape: { parentId, title, summary, details?, kind, priority, turnsLeft }.",
    "- Use update_context_chunk to elaborate, correct, or extend an existing package in place. Preferred args shape: { id, title?, summary?, details?, kind?, priority?, turnsLeft? }.",
    "- Use move_context_chunk to reparent an item under a different package when it belongs there. Preferred args shape: { id, parentId? }.",
    "- If a new idea is substantially the same as an existing package, update the existing package instead of creating another copy.",
    "- If multiple packages are near-duplicates, prefer merge_context_chunks. When merging, preserve useful subtree structure whenever possible.",
    "- Read-only packages may be focused but must not be overwritten, retitled, deleted, or merged away.",
    "- Use send_message_to_user only for useful follow-up questions, clarifications, or short amplifications.",
    "- Avoid repeating the same proactive message.",
    "- If the last few attempts were no-ops, either fix the argument shape or choose do_nothing.",
    ...BACKGROUND_PROMPT_GUIDANCE_LINES
  ].join("\n");

  return {
    config: {
      endpoint: "http://localhost:1234/v1/chat/completions",
      model: "liquid/lfm2.5-1.2b",
      apiKey: "",
      cooldownMs: DEFAULT_COOLDOWN_MS,
      maxContextTokens: DEFAULT_MANAGED_CONTEXT_BUDGET_TOKENS,
      backgroundEnabled: true,
      sharedPrompt,
      chatPrompt,
      backgroundPrompt
    },
    chat: [],
    processedConversationRevision: 0,
    contextPackages: [
      createContextPackage({
        id: productFrameId,
        title: "Product frame",
        summary:
          "Candle maintains bounded recent chat, continuously curates context packages in the background, and may proactively message the user when it has something useful to say.",
        kind: "summary",
        priority: 0.97,
        pinned: true,
        readOnly: true,
        lineageHue: 204,
        turnsLeft: 999,
        status: "active",
        source: "system",
        createdAt,
        lastTouchedAt: createdAt
      }),
      createContextPackage({
        id: onboardingRootId,
        title: "Onboarding workspace",
        summary:
          "Starter working area for orienting to a new user and replacing generic scaffolding with real maintained structure.",
        contentDetails:
          "This starter workspace should be replaced as soon as real projects, notes, and user-specific structures are available.",
        kind: "workspace",
        priority: 0.68,
        pinned: false,
        readOnly: false,
        lineageHue: 132,
        turnsLeft: 8,
        status: "active",
        source: "system",
        createdAt,
        lastTouchedAt: createdAt
      }),
      createContextPackage({
        id: nameTaskId,
        title: "Learn the user's preferred name",
        summary:
          "Notice and record how the user wants to be addressed once that becomes clear.",
        kind: "task",
        parentId: onboardingRootId,
        priority: 0.42,
        pinned: false,
        readOnly: false,
        lineageHue: 132,
        turnsLeft: 6,
        status: "active",
        source: "system",
        createdAt,
        lastTouchedAt: createdAt
      }),
      createContextPackage({
        id: structureTaskId,
        title: "Replace starter memory scaffolding",
        summary:
          "As real work emerges, replace generic starter notes with project-specific trees, summaries, and working notes.",
        kind: "task",
        parentId: onboardingRootId,
        priority: 0.56,
        pinned: false,
        readOnly: false,
        lineageHue: 132,
        turnsLeft: 8,
        status: "active",
        source: "system",
        createdAt,
        lastTouchedAt: createdAt
      }),
      createContextPackage({
        id: continuityTaskId,
        title: "Build unified chat-background continuity",
        summary:
          "Track what the outer chat process can safely trust the inner loop to continue, and record patterns that make Candle feel like one coherent system.",
        kind: "task",
        parentId: onboardingRootId,
        priority: 0.6,
        pinned: false,
        readOnly: false,
        lineageHue: 132,
        turnsLeft: 8,
        status: "active",
        source: "system",
        createdAt,
        lastTouchedAt: createdAt
      })
    ],
    activity: [
      {
        id: uid("act"),
        title: "Initialized Candle",
        detail: "Seeded the maintained context with a pinned product frame package.",
        type: "bootstrap",
        createdAt
      }
    ],
    background: {
      status: "idle",
      tickCount: 0,
      currentAction: "Waiting",
      lastRunAt: null,
      nextDelayMs: DEFAULT_COOLDOWN_MS,
      nextRunAt: null,
      pendingUserMessages: [],
      decisions: [],
      liveDecision: null
    },
    debug: {
      lastChatPrompt: "",
      lastChatResponse: "",
      lastBackgroundPrompt: "",
      lastBackgroundResponse: "",
      lastPersistedAt: null,
      lastEventAt: null
    },
    systemNotices: [],
    staleBackgroundCarryover: [],
    availableModels: [],
    inferenceProfiles: [],
    sharedPromptProfiles: [],
    chatPromptProfiles: [],
    backgroundPromptProfiles: [],
    configProfiles: []
  };
}

function mergePromptGuidance(existing, requiredLines) {
  const base = String(existing || "").trim();
  const lines = base ? base.split("\n") : [];

  requiredLines.forEach((line) => {
    if (!base.includes(line)) {
      lines.push(line);
    }
  });

  return lines.join("\n").trim();
}

function normalizeState(rawState) {
  const base = createInitialState();
  const next = {
    ...base,
    ...rawState,
    config: {
      ...base.config,
      ...(rawState?.config ?? {})
    },
    background: {
      ...base.background,
      ...(rawState?.background ?? {})
    },
    debug: {
      ...base.debug,
      ...(rawState?.debug ?? {})
    }
  };

  next.config.cooldownMs = Math.max(
    0,
    Number(next.config.cooldownMs ?? DEFAULT_COOLDOWN_MS)
  );
  next.config.maxContextTokens = Math.max(
    256,
    Number(next.config.maxContextTokens ?? DEFAULT_MANAGED_CONTEXT_BUDGET_TOKENS)
  );
  next.config.backgroundEnabled = next.config.backgroundEnabled !== false;
  next.config.sharedPrompt = mergePromptGuidance(
    next.config.sharedPrompt,
    SHARED_PROMPT_GUIDANCE_LINES
  );
  next.config.chatPrompt = mergePromptGuidance(
    next.config.chatPrompt,
    CHAT_PROMPT_GUIDANCE_LINES
  );
  next.config.backgroundPrompt = mergePromptGuidance(
    next.config.backgroundPrompt,
    BACKGROUND_PROMPT_GUIDANCE_LINES
  );

  next.chat = Array.isArray(rawState?.chat) ? rawState.chat : [];
  next.processedConversationRevision = Math.max(
    0,
    Number(rawState?.processedConversationRevision ?? 0)
  );
  next.chat = next.chat
    .map((message) => normalizeChatMessage(message))
    .filter(Boolean);
  next.activity = Array.isArray(rawState?.activity) ? rawState.activity.slice(0, MAX_ACTIVITY) : [];
  next.availableModels = Array.isArray(rawState?.availableModels) ? rawState.availableModels.filter(Boolean) : [];
  next.inferenceProfiles = Array.isArray(rawState?.inferenceProfiles) ? rawState.inferenceProfiles : [];
  next.sharedPromptProfiles = Array.isArray(rawState?.sharedPromptProfiles) ? rawState.sharedPromptProfiles : [];
  next.chatPromptProfiles = Array.isArray(rawState?.chatPromptProfiles) ? rawState.chatPromptProfiles : [];
  next.backgroundPromptProfiles = Array.isArray(rawState?.backgroundPromptProfiles) ? rawState.backgroundPromptProfiles : [];
  next.configProfiles = Array.isArray(rawState?.configProfiles) ? rawState.configProfiles : [];
  next.systemNotices = Array.isArray(rawState?.systemNotices) ? rawState.systemNotices.slice(0, 24) : [];
  next.staleBackgroundCarryover = Array.isArray(rawState?.staleBackgroundCarryover)
    ? rawState.staleBackgroundCarryover.slice(0, 8)
    : [];
  next.background.pendingUserMessages = Array.isArray(next.background.pendingUserMessages)
    ? next.background.pendingUserMessages
    : [];
  next.background.decisions = Array.isArray(next.background.decisions)
    ? next.background.decisions.slice(0, MAX_DECISIONS)
    : [];
  next.background.liveDecision = rawState?.background?.liveDecision
    ? {
        id: String(rawState.background.liveDecision.id || uid("live")),
        status: String(rawState.background.liveDecision.status || "in_progress"),
        tool: String(rawState.background.liveDecision.tool || "thinking"),
        summary: String(rawState.background.liveDecision.summary || ""),
        reason: String(rawState.background.liveDecision.reason || ""),
        createdAt: String(rawState.background.liveDecision.createdAt || nowIso()),
        updatedAt: String(rawState.background.liveDecision.updatedAt || rawState.background.liveDecision.createdAt || nowIso())
      }
    : null;
  next.background.nextDelayMs = Number.isFinite(next.background.nextDelayMs)
    ? next.background.nextDelayMs
    : next.config.cooldownMs;
  next.background.nextRunAt = next.background.nextRunAt ?? null;

  next.contextPackages = Array.isArray(rawState?.contextPackages)
    ? rawState.contextPackages
        .map((item) => createContextPackage(item))
        .filter(Boolean)
        .slice(0, MAX_CONTEXT_PACKAGES)
    : base.contextPackages;

  if (!next.contextPackages.length) {
    next.contextPackages = base.contextPackages;
  }

  const hasOnboardingWorkspace = next.contextPackages.some(
    (pkg) => normalizeComparisonText(pkg.title) === normalizeComparisonText("Onboarding workspace")
  );
  if (!hasOnboardingWorkspace) {
    const onboardingPackages = base.contextPackages.filter(
      (pkg) => normalizeComparisonText(pkg.title) === normalizeComparisonText("Onboarding workspace") ||
        pkg.parentId === base.contextPackages.find(
          (item) => normalizeComparisonText(item.title) === normalizeComparisonText("Onboarding workspace")
        )?.id
    );
    next.contextPackages = [...next.contextPackages, ...onboardingPackages]
      .slice(0, MAX_CONTEXT_PACKAGES);
  }

  rebuildHierarchyRelations(next);

  return next;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    console.error("Failed to load state", error);
    return createInitialState();
  }
}

let state = loadState();
let debugPersistHandle = null;
let debugEventHandle = null;
let debugEventQueue = [];
let backgroundLoopHandle = null;
let backgroundCycleInFlight = false;
let uiInitialized = false;
const uiState = {
  selectedContextIds: [],
  expandedDecisionIds: [],
  backgroundPaneMode: "context",
  saveFeedback: {}
};

const app = document.querySelector("#app");

function buildDebugSnapshot(currentState) {
  return {
    savedAt: nowIso(),
    config: {
      endpoint: currentState.config.endpoint,
      model: currentState.config.model,
      cooldownMs: currentState.config.cooldownMs,
      maxContextTokens: currentState.config.maxContextTokens,
      backgroundEnabled: currentState.config.backgroundEnabled
    },
    background: currentState.background,
    counts: {
      chat: currentState.chat.length,
      contextPackages: currentState.contextPackages.length,
      decisions: currentState.background.decisions.length,
      activity: currentState.activity.length
    },
    processedConversationRevision: currentState.processedConversationRevision,
    staleBackgroundCarryover: currentState.staleBackgroundCarryover,
    chatTail: currentState.chat.slice(-16),
    contextHead: getSortedPackages(currentState).slice(0, 16),
    activityHead: currentState.activity.slice(0, 16),
    debug: currentState.debug
  };
}

function getSaveFeedbackLabel(key, fallback) {
  return uiState.saveFeedback[key] || fallback;
}

function flashSaveFeedback(key, fallback, savedLabel) {
  uiState.saveFeedback[key] = "Saving...";
  renderSettingsPanel();
  window.setTimeout(() => {
    uiState.saveFeedback[key] = savedLabel;
    renderSettingsPanel();
    window.setTimeout(() => {
      if (uiState.saveFeedback[key] === savedLabel) {
        delete uiState.saveFeedback[key];
        renderSettingsPanel();
      }
    }, 1200);
  }, 120);
}

function persistDebugState(currentState) {
  if (debugPersistHandle !== null) {
    window.clearTimeout(debugPersistHandle);
  }

  debugPersistHandle = window.setTimeout(async () => {
    debugPersistHandle = null;
    try {
      await fetch(DEBUG_STATE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildDebugSnapshot(currentState))
      });
      currentState.debug.lastPersistedAt = nowIso();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));
    } catch (error) {
      console.warn("Failed to persist debug state", error);
    }
  }, 120);
}

function enqueueDebugEvent(event) {
  debugEventQueue.push({
    recordedAt: nowIso(),
    ...event
  });
  debugEventQueue = debugEventQueue.slice(-200);

  if (debugEventHandle !== null) {
    return;
  }

  debugEventHandle = window.setTimeout(async () => {
    const batch = [...debugEventQueue];
    debugEventQueue = [];
    debugEventHandle = null;

    for (const item of batch) {
      try {
        await fetch(DEBUG_EVENT_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item)
        });
        state.debug.lastEventAt = item.recordedAt;
      } catch (error) {
        console.warn("Failed to persist debug event", error);
        debugEventQueue.unshift(...batch.slice(batch.indexOf(item)));
        break;
      }
    }
  }, 80);
}

function saveState(currentState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(currentState));
  persistDebugState(currentState);
}

function pushActivity(currentState, title, detail, type = "state") {
  currentState.activity.unshift({
    id: uid("act"),
    title,
    detail,
    type,
    createdAt: nowIso()
  });
  currentState.activity = currentState.activity.slice(0, MAX_ACTIVITY);
  enqueueDebugEvent({
    type: "activity",
    activityType: type,
    title,
    detail
  });
}

function pushSystemNotice(currentState, message) {
  const trimmed = String(message || "").trim();
  if (!trimmed) return;
  currentState.systemNotices.unshift({
    id: uid("notice"),
    message: trimmed,
    createdAt: nowIso()
  });
  currentState.systemNotices = currentState.systemNotices.slice(0, 24);
  enqueueDebugEvent({
    type: "system_notice",
    message: trimmed
  });
}

function pushDecision(
  currentState,
  tool,
  reason,
  args = {},
  rawOutput = "",
  kind = "decision",
  summary = "",
  diff = "",
  deterministicResponse = ""
) {
  currentState.background.decisions.unshift({
    id: uid("dec"),
    tool,
    reason,
    summary,
    diff,
    deterministicResponse,
    args,
    rawOutput,
    kind,
    createdAt: nowIso()
  });
  currentState.background.decisions = currentState.background.decisions.slice(0, MAX_DECISIONS);
  enqueueDebugEvent({
    type: "decision",
    kind,
    tool,
    reason,
    summary,
    diff,
    deterministicResponse,
    args,
    rawOutput
  });
}

function setLiveDecision(currentState, patch = {}) {
  const existing = currentState.background.liveDecision;
  const createdAt = existing?.createdAt || nowIso();
  currentState.background.liveDecision = {
    id: existing?.id || uid("live"),
    status: patch.status || existing?.status || "in_progress",
    tool: patch.tool ?? existing?.tool ?? "thinking",
    summary: patch.summary ?? existing?.summary ?? "",
    reason: patch.reason ?? existing?.reason ?? "",
    createdAt,
    updatedAt: nowIso()
  };
}

function clearLiveDecision(currentState) {
  currentState.background.liveDecision = null;
}

function buildModelsEndpoint(endpoint) {
  const trimmed = String(endpoint || "").trim();
  if (!trimmed) return "";
  if (trimmed.includes("/chat/completions")) {
    return trimmed.replace(/\/chat\/completions\/?$/, "/models");
  }
  if (trimmed.endsWith("/v1")) return `${trimmed}/models`;
  if (trimmed.endsWith("/v1/")) return `${trimmed}models`;
  if (trimmed.endsWith("/models")) return trimmed;
  return `${trimmed.replace(/\/$/, "")}/models`;
}

async function fetchAvailableModels(currentState) {
  const endpoint = buildModelsEndpoint(currentState.config.endpoint);
  if (!endpoint) return [];

  const headers = {};
  if (currentState.config.apiKey.trim()) {
    headers.Authorization = `Bearer ${currentState.config.apiKey.trim()}`;
  }

  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    throw new Error(`Model list failed: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  currentState.availableModels = Array.isArray(payload?.data)
    ? payload.data.map((item) => item?.id).filter(Boolean)
    : [];
  saveState(currentState);
  return currentState.availableModels;
}

function saveInferenceProfile(currentState) {
  const endpoint = String(currentState.config.endpoint || "").trim();
  const model = String(currentState.config.model || "").trim();

  if (!endpoint || !model) return;

  const host = (() => {
    try {
      return new URL(endpoint).host;
    } catch {
      return "local";
    }
  })();

  const signature = `${endpoint}::${model}::${currentState.config.apiKey}`;
  currentState.inferenceProfiles = currentState.inferenceProfiles.filter(
    (profile) => `${profile.endpoint}::${profile.model}::${profile.apiKey}` !== signature
  );

  currentState.inferenceProfiles.unshift({
    id: uid("profile"),
    name: `${model} @ ${host}`,
    endpoint,
    model,
    apiKey: currentState.config.apiKey
  });
  currentState.inferenceProfiles = currentState.inferenceProfiles.slice(0, 12);
  saveState(currentState);
}

function applyInferenceProfile(currentState, profileId) {
  const profile = currentState.inferenceProfiles.find((item) => item.id === profileId);
  if (!profile) return;

  currentState.config.endpoint = profile.endpoint;
  currentState.config.model = profile.model;
  currentState.config.apiKey = profile.apiKey;
  saveState(currentState);
}

function makePresetName(value, fallback) {
  const firstLine = String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 44 ? `${firstLine.slice(0, 41)}...` : firstLine;
}

function savePromptProfile(currentState, kind) {
  const keyMap = {
    shared: ["sharedPrompt", "sharedPromptProfiles", "Shared prompt"],
    chat: ["chatPrompt", "chatPromptProfiles", "Chat prompt"],
    background: ["backgroundPrompt", "backgroundPromptProfiles", "Subconscious prompt"]
  };
  const [configKey, profileKey, fallbackLabel] = keyMap[kind] || [];
  if (!configKey || !profileKey) return;

  const text = String(currentState.config[configKey] || "").trim();
  if (!text) return;

  const signature = text;
  currentState[profileKey] = currentState[profileKey].filter((profile) => profile.text !== signature);
  currentState[profileKey].unshift({
    id: uid("prompt"),
    name: makePresetName(text, fallbackLabel),
    text
  });
  currentState[profileKey] = currentState[profileKey].slice(0, 16);
  saveState(currentState);
}

function applyPromptProfile(currentState, kind, profileId) {
  const keyMap = {
    shared: ["sharedPrompt", "sharedPromptProfiles"],
    chat: ["chatPrompt", "chatPromptProfiles"],
    background: ["backgroundPrompt", "backgroundPromptProfiles"]
  };
  const [configKey, profileKey] = keyMap[kind] || [];
  if (!configKey || !profileKey) return;
  const profile = currentState[profileKey].find((item) => item.id === profileId);
  if (!profile) return;
  currentState.config[configKey] = profile.text;
  saveState(currentState);
}

function saveConfigProfile(currentState) {
  const snapshot = {
    endpoint: String(currentState.config.endpoint || "").trim(),
    model: String(currentState.config.model || "").trim(),
    apiKey: String(currentState.config.apiKey || ""),
    sharedPrompt: String(currentState.config.sharedPrompt || ""),
    chatPrompt: String(currentState.config.chatPrompt || ""),
    backgroundPrompt: String(currentState.config.backgroundPrompt || "")
  };

  const signature = JSON.stringify(snapshot);
  const labelBase = snapshot.model || "config";
  currentState.configProfiles = currentState.configProfiles.filter(
    (profile) => JSON.stringify(profile.snapshot) !== signature
  );
  currentState.configProfiles.unshift({
    id: uid("config"),
    name: `${labelBase} · ${new Date().toLocaleDateString([], { month: "short", day: "numeric" })}`,
    snapshot
  });
  currentState.configProfiles = currentState.configProfiles.slice(0, 16);
  saveState(currentState);
}

function applyConfigProfile(currentState, profileId) {
  const profile = currentState.configProfiles.find((item) => item.id === profileId);
  if (!profile?.snapshot) return;
  Object.assign(currentState.config, profile.snapshot);
  saveState(currentState);
}

function getPackageSummaryText(pkg) {
  return String(pkg?.summary || pkg?.content || "").trim();
}

function getPackageDetailText(pkg) {
  const detail = String(pkg?.content || "").trim();
  if (!detail) return "";
  if (detail === getPackageSummaryText(pkg)) return "";
  return detail;
}

function getPackageTextBlob(pkg) {
  return [pkg?.title || "", getPackageSummaryText(pkg), getPackageDetailText(pkg)].filter(Boolean).join(" ");
}

function resolvePackageList(input) {
  if (Array.isArray(input)) return input;
  return Array.isArray(input?.contextPackages) ? input.contextPackages : [];
}

function sortPackageGroup(packages) {
  return [...packages].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if ((a.order ?? 0) !== (b.order ?? 0)) return (a.order ?? 0) - (b.order ?? 0);
    if (b.priority !== a.priority) return b.priority - a.priority;
    return new Date(b.lastTouchedAt).getTime() - new Date(a.lastTouchedAt).getTime();
  });
}

function rebuildHierarchyRelations(currentState) {
  const packages = resolvePackageList(currentState);
  const validIds = new Set(packages.map((pkg) => pkg.id));
  packages.forEach((pkg) => {
    pkg.childIds = [];
    if (pkg.parentId && !validIds.has(pkg.parentId)) {
      pkg.parentId = null;
    }
  });

  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  packages.forEach((pkg) => {
    if (!pkg.parentId) return;
    const parent = byId.get(pkg.parentId);
    if (!parent || parent.id === pkg.id) {
      pkg.parentId = null;
      return;
    }
    parent.childIds.push(pkg.id);
  });

  packages.forEach((pkg) => {
    pkg.childIds = sortPackageGroup(
      pkg.childIds.map((childId) => byId.get(childId)).filter(Boolean)
    ).map((child) => child.id);
  });
}

function getChildPackages(currentState, parentId) {
  const packages = resolvePackageList(currentState);
  const parent = packages.find((pkg) => pkg.id === parentId);
  if (!parent) return [];
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  return parent.childIds.map((childId) => byId.get(childId)).filter(Boolean);
}

function getPackageDepth(currentState, packageId) {
  let depth = 0;
  const packages = resolvePackageList(currentState);
  let cursor = packages.find((pkg) => pkg.id === packageId);
  const seen = new Set();
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    seen.add(cursor.parentId);
    cursor = packages.find((pkg) => pkg.id === cursor.parentId);
    if (!cursor) break;
    depth += 1;
  }
  return depth;
}

function getPackagePath(currentState, packageId) {
  const path = [];
  const packages = resolvePackageList(currentState);
  let cursor = packages.find((pkg) => pkg.id === packageId);
  const seen = new Set();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.unshift(cursor);
    cursor = cursor.parentId
      ? packages.find((pkg) => pkg.id === cursor.parentId)
      : null;
  }
  return path;
}

function isDescendantPackage(currentState, packageId, possibleAncestorId) {
  if (!packageId || !possibleAncestorId) return false;
  let cursor = currentState.contextPackages.find((pkg) => pkg.id === packageId);
  const seen = new Set();
  while (cursor?.parentId && !seen.has(cursor.parentId)) {
    if (cursor.parentId === possibleAncestorId) return true;
    seen.add(cursor.parentId);
    cursor = currentState.contextPackages.find((pkg) => pkg.id === cursor.parentId);
  }
  return false;
}

function getCommonParentId(packages) {
  if (!packages.length) return null;
  const parentId = packages[0].parentId ?? null;
  return packages.every((pkg) => (pkg.parentId ?? null) === parentId) ? parentId : null;
}

function getSortedPackages(currentState) {
  const packages = resolvePackageList(currentState);
  const byParent = new Map();
  packages.forEach((pkg) => {
    const key = pkg.parentId ?? "__root__";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(pkg);
  });

  const ordered = [];
  const visit = (parentId) => {
    const group = sortPackageGroup(byParent.get(parentId ?? "__root__") ?? []);
    group.forEach((pkg) => {
      ordered.push(pkg);
      visit(pkg.id);
    });
  };

  visit(null);
  return ordered;
}

function updatePackageDiagnostics(currentState) {
  currentState.contextPackages = currentState.contextPackages
    .map((pkg, index) => {
      if (pkg.pinned) {
        return {
          ...pkg,
          turnsLeft: 999,
          status: pkg.status === "dropped" ? "active" : pkg.status
        };
      }

      const nextTurnsLeft = Math.max(0, Number(pkg.turnsLeft ?? 6) - 1);
      const nextPriority = clamp(pkg.priority - 0.012 - index * 0.0007, 0.05, 1);
      return {
        ...pkg,
        turnsLeft: nextTurnsLeft,
        priority: Number(nextPriority.toFixed(3)),
        status: nextTurnsLeft <= 0 ? "stale" : pkg.status === "dropped" ? "dropped" : "active"
      };
    })
    .filter((pkg) => pkg.status !== "dropped")
    .slice(0, MAX_CONTEXT_PACKAGES);
}

function getActivePackages(currentState) {
  return getSortedPackages(currentState)
    .filter((pkg) => pkg.status !== "dropped")
    .slice(0, MAX_ACTIVE_PACKAGES)
    .map((pkg) => ({
      ...pkg,
      depth: getPackageDepth(currentState, pkg.id),
      childCount: getChildPackages(currentState, pkg.id).length
    }));
}

function notePackagesUsed(currentState, packageIds) {
  const touchedAt = nowIso();
  packageIds.forEach((packageId) => {
    const pkg = currentState.contextPackages.find((item) => item.id === packageId);
    if (!pkg) return;
    pkg.lastUsedAt = touchedAt;
    pkg.lastTouchedAt = touchedAt;
    pkg.usageCount = Number(pkg.usageCount ?? 0) + 1;
  });
}

function addContextPackage(currentState, partial) {
  const pkg = createContextPackage(partial);
  if (!pkg) return null;
  if (!Number.isFinite(pkg.lineageHue)) {
    pkg.lineageHue = pickDistinctHue(currentState.contextPackages);
  }

  currentState.contextPackages.unshift(pkg);
  rebuildHierarchyRelations(currentState);
  currentState.contextPackages = getSortedPackages(currentState).slice(0, MAX_CONTEXT_PACKAGES);
  rebuildHierarchyRelations(currentState);
  return pkg;
}

function pickDistinctHue(existingPackages) {
  const hues = existingPackages
    .map((pkg) => Number(pkg.lineageHue))
    .filter((value) => Number.isFinite(value));

  if (!hues.length) return 204;

  let bestHue = 0;
  let bestDistance = -1;
  for (let candidate = 0; candidate < 360; candidate += 24) {
    const nearest = Math.min(
      ...hues.map((hue) => {
        const diff = Math.abs(hue - candidate);
        return Math.min(diff, 360 - diff);
      })
    );
    if (nearest > bestDistance) {
      bestDistance = nearest;
      bestHue = candidate;
    }
  }
  return bestHue;
}

function blendLineageHue(packages) {
  const hues = packages
    .map((pkg) => Number(pkg?.lineageHue))
    .filter((value) => Number.isFinite(value));
  if (!hues.length) return null;

  const radians = hues.map((hue) => (hue * Math.PI) / 180);
  const x = radians.reduce((sum, angle) => sum + Math.cos(angle), 0);
  const y = radians.reduce((sum, angle) => sum + Math.sin(angle), 0);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

function updateContextPackage(currentState, id, patch) {
  const pkg = currentState.contextPackages.find((item) => item.id === id);
  if (!pkg) return null;

  Object.assign(pkg, patch, { lastTouchedAt: nowIso() });
  pkg.priority = clamp(Number(pkg.priority ?? 0.5), 0.05, 1);
  pkg.pinned = Boolean(pkg.pinned);
  pkg.turnsLeft = pkg.pinned ? 999 : clamp(Number(pkg.turnsLeft ?? 6), 0, 18);
  pkg.summary = getPackageSummaryText(pkg);
  rebuildHierarchyRelations(currentState);
  return pkg;
}

function removeContextPackage(currentState, id, mode = "subtree") {
  const target = currentState.contextPackages.find((item) => item.id === id);
  if (!target) return false;

  if (mode === "promote_children") {
    currentState.contextPackages.forEach((pkg) => {
      if (pkg.parentId === id) {
        pkg.parentId = target.parentId ?? null;
      }
    });
    currentState.contextPackages = currentState.contextPackages.filter((item) => item.id !== id);
    rebuildHierarchyRelations(currentState);
    return true;
  }

  const toRemove = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    currentState.contextPackages.forEach((pkg) => {
      if (pkg.parentId && toRemove.has(pkg.parentId) && !toRemove.has(pkg.id)) {
        toRemove.add(pkg.id);
        changed = true;
      }
    });
  }

  const before = currentState.contextPackages.length;
  currentState.contextPackages = currentState.contextPackages.filter((item) => !toRemove.has(item.id));
  rebuildHierarchyRelations(currentState);
  return currentState.contextPackages.length !== before;
}

function addChatMessage(currentState, role, text, kind = "reply", options = {}) {
  const message = normalizeChatMessage({
    role,
    kind,
    text,
    processed: options.processed,
    processedAt: options.processedAt
  });
  if (!message) return null;
  currentState.chat.push(message);
  return message;
}

function maybeIngestChatIntoContext(currentState, role, text) {
  return null;
}

function getRecentChatWindow(currentState, mode = "chat", activePackageTokens = null, reservedTokens = 0) {
  return getAdaptiveRecentChatWindow(currentState, mode, activePackageTokens, reservedTokens);
}

function getProcessedChatMessages(currentState) {
  return currentState.chat.filter((message) => message.processed !== false);
}

function getPendingUserChatMessages(currentState) {
  return currentState.chat.filter(
    (message) => message.role === "user" && message.processed === false
  );
}

function markMessagesProcessed(messages) {
  const processedAt = nowIso();
  messages.forEach((message) => {
    if (!message) return;
    message.processed = true;
    message.processedAt = processedAt;
  });
  return processedAt;
}

function findContextPackageByTitle(currentState, title) {
  const normalized = normalizeComparisonText(title);
  return currentState.contextPackages.find(
    (pkg) => normalizeComparisonText(pkg.title) === normalized
  ) || null;
}

function extractPreferredNameFromMessages(messages) {
  const patterns = [
    /\bmy name is ([A-Za-z][A-Za-z'’-]{1,31})\b/i,
    /\bi am ([A-Za-z][A-Za-z'’-]{1,31})\b/i,
    /\bi'm ([A-Za-z][A-Za-z'’-]{1,31})\b/i,
    /\bcall me ([A-Za-z][A-Za-z'’-]{1,31})\b/i
  ];

  for (const message of messages) {
    const text = String(message?.text || "");
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        const name = match[1].trim();
        return name.charAt(0).toUpperCase() + name.slice(1);
      }
    }
  }

  return "";
}

function summarizeProcessedTurnForNotice(processedUsers, assistantText) {
  const userSummary = (processedUsers || [])
    .map((message) => String(message?.text || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" | ");
  const assistantSummary = String(assistantText || "").replace(/\s+/g, " ").trim();

  const compactUser = compactPromptText(userSummary, 140);
  const compactAssistant = compactPromptText(assistantSummary, 140);

  if (compactUser && compactAssistant) {
    return `Processed chat handoff. User said: ${compactUser}. Assistant replied: ${compactAssistant}. Treat this as the latest authoritative conversation state when reconciling tasks and notes.`;
  }
  if (compactUser) {
    return `Processed chat handoff. User said: ${compactUser}. Treat this as the latest authoritative conversation state when reconciling tasks and notes.`;
  }
  return "Processed chat handoff. A new user-facing turn has been completed and should override stale assumptions in older tasks or notes.";
}

function syncContextFromProcessedChat(currentState, processedUsers, assistantText) {
  const changes = [];
  pushSystemNotice(
    currentState,
    summarizeProcessedTurnForNotice(processedUsers, assistantText)
  );
  const preferredName = extractPreferredNameFromMessages(processedUsers);

  if (preferredName) {
    const nameTask = findContextPackageByTitle(currentState, "Learn the user's preferred name");
    if (nameTask) {
      const before = snapshotPackage(nameTask);
      const updated = updateContextPackage(currentState, nameTask.id, {
        summary: `We have learned the user prefers to be called ${preferredName}`,
        content: `User wants to be addressed as ${preferredName}`,
        turnsLeft: 0,
        status: "active",
        priority: clamp(Math.max(nameTask.priority, 0.35), 0.05, 1)
      });

      if (updated) {
        enqueueDebugEvent({
          type: "context_updated",
          tool: "chat_sync",
          reason: `Resolved preferred name from processed user message: ${preferredName}.`,
          package: updated
        });
        changes.push(diffSnapshots(before, snapshotPackage(updated)));
      }
    }

    pushSystemNotice(
      currentState,
      `Processed chat established that the user prefers to be called ${preferredName}. Treat that as settled unless corrected.`
    );

    currentState.background.pendingUserMessages = currentState.background.pendingUserMessages.filter(
      (message) => !/preferred name|what would you like me to call you|what should i call you/i.test(String(message || ""))
    );
  }

  if (changes.length) {
    enqueueDebugEvent({
      type: "chat_context_sync",
      preferredName: preferredName || null,
      changes
    });
    pushActivity(
      currentState,
      "Synced maintained context from chat",
      `Resolved obvious facts from the latest processed turn.${assistantText ? " Updated state before the next background cycle." : ""}`,
      "chat"
    );
  }
}

function describeElapsedSinceMessage(messages, role) {
  const filtered = messages.filter((message) => message.role === role);
  if (!filtered.length) {
    return role === "user" ? "No processed user message yet." : "No assistant message yet.";
  }

  const last = filtered[filtered.length - 1];
  const diffMs = Date.now() - new Date(last.createdAt).getTime();
  const diffSec = Math.max(0, Math.round(diffMs / 1000));

  if (diffSec < 60) return `${diffSec}s ago.`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago.`;
  return `${Math.round(diffSec / 3600)}h ago.`;
}

function describeConversationCadence(currentState) {
  const processed = getProcessedChatMessages(currentState);
  return [
    `Time since last incoming user message: ${describeElapsedSinceMessage(processed, "user")}`,
    `Time since last outgoing assistant message: ${describeElapsedSinceMessage(processed, "assistant")}`
  ].join("\n");
}

function estimatePromptOverheadTokens(currentState, mode = "chat") {
  const sharedCore = buildSharedCorePrompt(currentState);
  const promptBody =
    mode === "background"
      ? String(currentState.config.backgroundPrompt || "").trim()
      : String(currentState.config.chatPrompt || "").trim();
  const staticLabels =
    mode === "background"
      ? [
          "Approximate managed context tokens:",
          "Approximate total request tokens:",
          "Recent system notices:",
          "Stale background carryover:",
          "Maintained context packages:",
          "Next out if unused:",
          "At risk next turn:",
          "Duplicate candidates:",
          "Recent subconscious trace:",
          "Recent decisions:",
          "Immediate tool feedback:",
          "Recent raw chat window:",
          "Inspect the current maintained context and return the next single tool call as strict JSON."
        ].join("\n")
      : [
          "Approximate managed context tokens:",
          "Approximate total request tokens:",
          "Recent system notices:",
          "Stale background carryover:",
          "Maintained context packages:",
          "Recent subconscious trace:",
          "Next out if unused:",
          "At risk next turn:",
          "Recent raw chat window:"
        ].join("\n");

  return estimateTextTokens([sharedCore, promptBody, staticLabels].filter(Boolean).join("\n\n"));
}

function formatSystemNoticesForPrompt(currentState) {
  return (currentState.systemNotices || [])
    .slice(0, 4)
    .map((notice) => `- ${compactPromptText(notice.message, 220)} @ ${notice.createdAt}`)
    .join("\n");
}

function formatStaleCarryoverForPrompt(currentState) {
  return (currentState.staleBackgroundCarryover || [])
    .slice(0, 3)
    .map((item) => {
      const parts = [
        `${compactPromptText(item.summary || item.tool || "stale background result", 180)} @ ${item.createdAt}`,
        item.reason ? `reason: ${compactPromptText(item.reason, 220)}` : "",
        item.rawOutput ? `stale output:\n${compactPromptText(item.rawOutput, 420)}` : ""
      ].filter(Boolean);
      return `- ${parts.join("\n  ")}`;
    })
    .join("\n\n");
}

function formatRecentChatForPrompt(input, maxCharsPerMessage = 420) {
  const messages = Array.isArray(input) ? input : getRecentChatWindow(input);
  return messages
    .map(
      (message) =>
        `- ${message.role} @ ${message.createdAt} [${message.kind}]: ${compactPromptText(message.text, maxCharsPerMessage)}`
    )
    .join("\n");
}

function summarizePackageForPrompt(pkg) {
  const diagnostics = [
    `id ${pkg.id}`,
    `priority ${pkg.priority.toFixed(2)}`,
    `tokens ${estimatePackageTokens(pkg)}`,
    `turns_left ${pkg.turnsLeft}`,
    `depth ${pkg.depth ?? 0}`,
    `children ${pkg.childCount ?? pkg.childIds?.length ?? 0}`,
    `pinned ${pkg.pinned ? "yes" : "no"}`,
    `read_only ${pkg.readOnly ? "yes" : "no"}`,
    `status ${pkg.status}`,
    `kind ${pkg.kind}`,
    `source ${pkg.source}`,
    `uses ${pkg.usageCount ?? 0}`
  ].join(" | ");

  const lines = [`- ${pkg.title} | ${diagnostics}`];
  if (getPackageSummaryText(pkg)) lines.push(`  summary: ${getPackageSummaryText(pkg)}`);
  if (getPackageDetailText(pkg)) lines.push(`  details: ${getPackageDetailText(pkg)}`);
  if (pkg.parentId) {
    const parent = state.contextPackages.find((item) => item.id === pkg.parentId);
    lines.push(`  parent: ${parent?.title || pkg.parentId}`);
  }
  return lines.join("\n");
}

function summarizePackageTreeForPrompt(packages, rootId, depth = 0, limit = 16) {
  if (!rootId || limit <= 0) return [];
  const pkg = packages.find((item) => item.id === rootId);
  if (!pkg) return [];
  const prefix = "  ".repeat(depth);
  const lines = [`${prefix}${summarizePackageForPrompt(pkg)}`];
  const children = getChildPackages(packages, rootId);
  for (const child of children) {
    if (lines.length >= limit) break;
    lines.push(...summarizePackageTreeForPrompt(packages, child.id, depth + 1, limit - lines.length));
  }
  return lines;
}

function estimatePackageTokens(pkg) {
  const text = getPackageTextBlob(pkg);
  if (!text) return 0;
  return estimateTextTokens(text);
}

function estimateMessageTokens(message) {
  return estimateTextTokens(String(message?.text || ""));
}

function estimateMessagesTokens(messages) {
  return (messages || []).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function getContextBudgetSnapshot(currentState) {
  const activePackages = getActivePackages(currentState);
  const totalTokens = activePackages.reduce((sum, pkg) => sum + estimatePackageTokens(pkg), 0);
  return {
    activePackages,
    totalTokens,
    maxTokens: getManagedContextBudgetTokens(currentState)
  };
}

function getAdaptiveRecentChatWindowMeta(
  currentState,
  mode = "chat",
  activePackageTokens = null,
  reservedTokens = 0
) {
  const minimumTurns = 2;
  const processedChat = getProcessedChatMessages(currentState);
  if (!processedChat.length) {
    return {
      messages: [],
      keptTokens: 0,
      omittedCount: 0,
      omittedTokens: 0,
      omittedPreview: []
    };
  }

  const packageTokens =
    activePackageTokens ?? getActivePackages(currentState).reduce((sum, pkg) => sum + estimatePackageTokens(pkg), 0);
  const promptOverheadTokens = estimatePromptOverheadTokens(currentState, mode);
  const remainingBudget = Math.max(
    0,
    TOTAL_REQUEST_BUDGET_TOKENS - promptOverheadTokens - packageTokens - reservedTokens
  );
  const chatBudget = Math.max(160, Math.floor(remainingBudget * 0.7));

  const selected = [];
  let used = 0;

  for (let index = processedChat.length - 1; index >= 0; index -= 1) {
    const message = processedChat[index];
    const tokens = estimateMessageTokens(message);
    const wouldExceed = used + tokens > chatBudget;

    if (selected.length >= minimumTurns && wouldExceed) {
      break;
    }

    selected.unshift(message);
    used += tokens;
  }

  const omitted = processedChat.slice(0, Math.max(0, processedChat.length - selected.length));
  return {
    messages: selected,
    keptTokens: used,
    omittedCount: omitted.length,
    omittedTokens: estimateMessagesTokens(omitted),
    omittedPreview: omitted
      .slice(-2)
      .map((message) => `${message.role}: ${compactPromptText(message.text, 120)}`)
  };
}

function getAdaptiveRecentChatWindow(
  currentState,
  mode = "chat",
  activePackageTokens = null,
  reservedTokens = 0
) {
  return getAdaptiveRecentChatWindowMeta(currentState, mode, activePackageTokens, reservedTokens).messages;
}

function buildConversationContextPackages(
  currentState,
  mode = "chat",
  activePackageTokens = null,
  reservedTokens = 0
) {
  const meta = getAdaptiveRecentChatWindowMeta(currentState, mode, activePackageTokens, reservedTokens);
  if (!meta.messages.length && !meta.omittedCount) return { root: null, packages: [], meta };

  const root = createContextPackage({
    id: "pkg-conversation-window",
    title: "Recent conversation",
    summary: `Recent processed conversation with ${meta.messages.length} fresh message${meta.messages.length === 1 ? "" : "s"} retained.${meta.omittedCount ? ` ${meta.omittedCount} older message${meta.omittedCount === 1 ? "" : "s"} have been compacted.` : ""}`,
    contentDetails: [
      meta.messages.length
        ? `Fresh turns remain available as child items.`
        : "",
      meta.omittedCount
        ? `Older compacted turns: ${meta.omittedPreview.join(" | ")}`
        : ""
    ].filter(Boolean).join("\n"),
    kind: "conversation",
    priority: 0.78,
    pinned: false,
    readOnly: true,
    lineageHue: 32,
    turnsLeft: 6,
    status: "active",
    source: "conversation",
    order: 10
  });
  const packages = [root];

  meta.messages.forEach((message, index) => {
    packages.push(
      createContextPackage({
        id: `pkg-conversation-msg-${message.id}`,
        title: `${message.role === "assistant" ? "Assistant" : "User"} · ${formatTime(message.createdAt)}`,
        summary: compactPromptText(message.text, 120),
        contentDetails: message.text,
        kind: "turn",
        parentId: root.id,
        priority: clamp(0.92 - index * 0.08, 0.12, 1),
        pinned: false,
        readOnly: true,
        lineageHue: 32,
        turnsLeft: clamp(8 - index, 1, 8),
        status: "active",
        source: "conversation",
        order: index
      })
    );
  });

  if (meta.omittedCount) {
    packages.push(
      createContextPackage({
        id: "pkg-conversation-older-summary",
        title: "Older conversation summary",
        summary: `${meta.omittedCount} older message${meta.omittedCount === 1 ? "" : "s"} have been compacted out of the fresh conversation window.`,
        contentDetails: meta.omittedPreview.join("\n"),
        kind: "summary",
        parentId: root.id,
        priority: 0.22,
        pinned: false,
        readOnly: true,
        lineageHue: 32,
        turnsLeft: 2,
        status: "stale",
        source: "conversation",
        order: 999
      })
    );
  }

  rebuildHierarchyRelations(packages);
  return { root, packages, meta };
}

function estimateDecisionTraceTokens(text) {
  return estimateTextTokens(text);
}

function formatDecisionTraceEntry(decision, mode = "full") {
  const head = [
    `${decision.tool || "do_nothing"}`,
    decision.kind ? `[${decision.kind}]` : "",
    `@ ${decision.createdAt}`
  ]
    .filter(Boolean)
    .join(" ");

  const lines = [head];

  if (decision.summary) {
    lines.push(`summary: ${compactPromptText(decision.summary, mode === "full" ? 260 : 160)}`);
  }

  if (decision.reason) {
    lines.push(`reason: ${compactPromptText(decision.reason, mode === "full" ? 360 : 180)}`);
  }

  if (mode === "full") {
    if (decision.diff) {
      lines.push(`diff:\n${compactPromptText(decision.diff, 600)}`);
    }
    if (decision.deterministicResponse) {
      lines.push(`deterministic response:\n${compactPromptText(decision.deterministicResponse, 320)}`);
    }
    if (decision.rawOutput) {
      lines.push(`raw output:\n${compactPromptText(decision.rawOutput, 700)}`);
    }
  }

  return lines.join("\n");
}

function getAdaptiveDecisionTraceEntries(
  currentState,
  activePackageTokens = 0,
  mode = "background",
  reservedTokens = 0
) {
  const decisions = currentState.background.decisions.slice(0, 12);
  if (!decisions.length) {
    return {
      entries: [],
      tokensUsed: 0,
      fullCount: 0,
      compactCount: 0,
      omittedCount: 0,
      omittedTokens: 0,
      omittedPreview: []
    };
  }

  const promptOverheadTokens = estimatePromptOverheadTokens(currentState, mode);
  const remainingBudget = Math.max(
    0,
    TOTAL_REQUEST_BUDGET_TOKENS - promptOverheadTokens - activePackageTokens - reservedTokens
  );
  const decisionBudget = Math.max(120, Math.floor(remainingBudget * 0.45));
  const selected = [];
  let used = 0;
  let fullCount = 0;
  let compactCount = 0;

  for (const decision of decisions) {
    const fullText = formatDecisionTraceEntry(decision, "full");
    const compactText = formatDecisionTraceEntry(decision, "compact");
    const fullTokens = estimateDecisionTraceTokens(fullText);
    const compactTokens = estimateDecisionTraceTokens(compactText);

    if (used + fullTokens <= decisionBudget || !selected.length) {
      selected.push({ decision, text: fullText, mode: "full" });
      used += fullTokens;
      fullCount += 1;
      continue;
    }

    if (used + compactTokens <= decisionBudget || selected.length < 2) {
      selected.push({ decision, text: compactText, mode: "compact" });
      used += compactTokens;
      compactCount += 1;
      continue;
    }

    break;
  }

  const omitted = decisions.slice(selected.length);
  return {
    entries: selected,
    tokensUsed: used,
    fullCount,
    compactCount,
    omittedCount: omitted.length,
    omittedTokens: omitted.reduce(
      (sum, decision) => sum + estimateDecisionTraceTokens(formatDecisionTraceEntry(decision, "compact")),
      0
    ),
    omittedPreview: omitted.slice(0, 2).map((decision) =>
      compactPromptText(decision.summary || decision.reason || getDecisionToolLabel(decision.tool), 120)
    )
  };
}

function buildDecisionTraceContextPackages(currentState, activePackageTokens = 0, mode = "background", reservedTokens = 0) {
  const trace = getAdaptiveDecisionTraceEntries(currentState, activePackageTokens, mode, reservedTokens);
  if (!trace.entries.length && !trace.omittedCount) return { root: null, packages: [], meta: trace };

  const root = createContextPackage({
    id: "pkg-subconscious-trace",
    title: "Recent subconscious work",
    summary: `Inner-loop trace with ${trace.fullCount} full and ${trace.compactCount} compact retained decision record${trace.entries.length === 1 ? "" : "s"}.${trace.omittedCount ? ` ${trace.omittedCount} older record${trace.omittedCount === 1 ? "" : "s"} have been compacted.` : ""}`,
    contentDetails: trace.omittedPreview.join("\n"),
    kind: "trace",
    priority: 0.74,
    pinned: false,
    readOnly: true,
    lineageHue: 152,
    turnsLeft: 6,
    status: "active",
    source: "subconscious",
    order: 11
  });
  const packages = [root];

  trace.entries.forEach((entry, index) => {
    const decision = entry.decision;
    packages.push(
      createContextPackage({
        id: `pkg-subconscious-decision-${decision.id}`,
        title: decision.summary || getDecisionToolLabel(decision.tool),
        summary: compactPromptText(decision.summary || decision.reason || getDecisionToolLabel(decision.tool), 140),
        contentDetails: entry.text,
        kind: "decision",
        parentId: root.id,
        priority: clamp(0.9 - index * 0.08, 0.12, 1),
        pinned: false,
        readOnly: true,
        lineageHue: 152,
        turnsLeft: clamp(8 - index, 1, 8),
        status: "active",
        source: "subconscious",
        order: index
      })
    );
  });

  if (trace.omittedCount) {
    packages.push(
      createContextPackage({
        id: "pkg-subconscious-older-summary",
        title: "Older subconscious summary",
        summary: `${trace.omittedCount} older decision record${trace.omittedCount === 1 ? "" : "s"} have been compacted out of the fresh trace window.`,
        contentDetails: trace.omittedPreview.join("\n"),
        kind: "summary",
        parentId: root.id,
        priority: 0.22,
        pinned: false,
        readOnly: true,
        lineageHue: 152,
        turnsLeft: 2,
        status: "stale",
        source: "subconscious",
        order: 999
      })
    );
  }

  rebuildHierarchyRelations(packages);
  return { root, packages, meta: trace };
}

function getRiskBuckets(currentState) {
  const mutable = getSortedPackages(currentState).filter(
    (pkg) => !pkg.readOnly && !pkg.pinned && pkg.source !== "conversation"
  );

  const nextOut = mutable
    .filter((pkg) => pkg.turnsLeft <= 1 || pkg.status === "stale")
    .slice(0, 4);
  const atRisk = mutable
    .filter((pkg) => pkg.turnsLeft > 1 && pkg.turnsLeft <= 3)
    .slice(0, 6);

  return { nextOut, atRisk };
}

function buildBackgroundContextModel(currentState) {
  const durablePackages = getSortedPackages(currentState).slice(0, 12);
  const durableTokenCount = durablePackages.reduce(
    (sum, pkg) => sum + estimatePackageTokens(pkg),
    0
  );
  const conversationTree = buildConversationContextPackages(currentState, "chat", durableTokenCount, 1400);
  const conversationRootTokens = conversationTree.root ? estimatePackageTokens(conversationTree.root) : 0;
  const subconsciousTree = buildDecisionTraceContextPackages(
    currentState,
    durableTokenCount + conversationRootTokens,
    "background",
    conversationTree.meta.keptTokens || 0
  );

  const topLevelPackages = [
    ...durablePackages.filter((pkg) => !pkg.parentId),
    ...(conversationTree.root ? [conversationTree.root] : []),
    ...(subconsciousTree.root ? [subconsciousTree.root] : [])
  ];

  const allPackages = [
    ...durablePackages,
    ...conversationTree.packages,
    ...subconsciousTree.packages
  ];
  rebuildHierarchyRelations(allPackages);

  return {
    durablePackages,
    conversationTree,
    subconsciousTree,
    topLevelPackages,
    allPackages
  };
}

function tileDimensionsForPackage(tokens, maxTokens) {
  const share = maxTokens > 0 ? tokens / maxTokens : 0;
  const areaUnits = clamp(
    Math.round(share * CONTEXT_GRID_CELLS),
    1,
    CONTEXT_GRID_CELLS
  );
  const side = clamp(
    Math.round(Math.sqrt(areaUnits)),
    1,
    CONTEXT_GRID_SIZE
  );
  const cols = clamp(side, 1, CONTEXT_GRID_SIZE);
  const rows = clamp(
    Math.max(1, Math.ceil(areaUnits / cols)),
    1,
    CONTEXT_GRID_SIZE
  );
  return { cols, rows };
}

function ensureContextSelection(contextPackages) {
  const validIds = new Set(contextPackages.map((pkg) => pkg.id));
  uiState.selectedContextIds = uiState.selectedContextIds.filter((id) => validIds.has(id));
  if (!uiState.selectedContextIds.length && contextPackages.length) {
    uiState.selectedContextIds = [contextPackages[0].id];
  }
}

function getContextTileStyle(pkg, maxTokens) {
  const tokens = estimatePackageTokens(pkg);
  const { cols, rows } = tileDimensionsForPackage(tokens, maxTokens);
  const hue = Number.isFinite(pkg.lineageHue) ? pkg.lineageHue : 204;
  const saturation = Math.round(28 + pkg.priority * 52);
  const lightness = Math.round(pkg.readOnly ? 20 : 16 + pkg.priority * 12);
  const border = Math.round(42 + pkg.priority * 22);
  return {
    tokens,
    cols,
    rows,
    style: `--tile-cols:${cols}; --tile-rows:${rows}; --tile-hue:${hue}; --tile-sat:${saturation}%; --tile-light:${lightness}%; --tile-border:${border}%;`
  };
}

function getDecisionToolLabel(tool) {
  return String(tool || "do_nothing")
    .replace(/_/g, " ")
    .trim();
}

function getDecisionIconMarkup(tool) {
  const normalized = String(tool || "do_nothing").trim();
  const iconMap = {
    do_nothing: "pause",
    create_context_chunk: "plus",
    create_child_context_chunk: "branch",
    update_context_chunk: "edit",
    move_context_chunk: "move",
    summarize_context_chunk: "compress",
    focus_context_chunk: "focus",
    merge_context_chunks: "merge",
    delete_context_chunk: "delete",
    retitle_context_chunk: "retitle",
    send_message_to_user: "message"
  };

  const icon = iconMap[normalized] || "tool";
  const title = escapeAttr(getDecisionToolLabel(normalized));

  const paths = {
    pause: `<rect x="6" y="5" width="3" height="10" rx="1"></rect><rect x="11" y="5" width="3" height="10" rx="1"></rect>`,
    plus: `<path d="M10 5v10M5 10h10"></path>`,
    branch: `<path d="M6 5v10M6 8h6M12 8v7M12 15h3"></path>`,
    edit: `<path d="M5 15l2.8-.4L15 7.4 12.6 5 5.4 12.2 5 15z"></path><path d="M11.8 5.8l2.4 2.4"></path>`,
    move: `<path d="M4 10h12"></path><path d="M12 6l4 4-4 4"></path>`,
    compress: `<path d="M5 6h10M7 10h6M9 14h2"></path>`,
    focus: `<circle cx="10" cy="10" r="4"></circle><path d="M10 3v3M10 14v3M3 10h3M14 10h3"></path>`,
    merge: `<path d="M4 6h3v3H4zM13 6h3v3h-3zM8 12h4M10 9v6"></path>`,
    delete: `<path d="M5 6h10"></path><path d="M7 6v8M13 6v8"></path><path d="M8 6V4h4v2"></path><path d="M6 6l.6 9h6.8l.6-9"></path>`,
    retitle: `<path d="M4 6h12"></path><path d="M8 6v8"></path><path d="M11 10h5"></path>`,
    message: `<path d="M4 5h12v8H9l-3 3v-3H4z"></path>`,
    tool: `<circle cx="10" cy="10" r="5"></circle>`
  };

  return `
    <span class="decision-icon" aria-hidden="true" title="${title}">
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        ${paths[icon]}
      </svg>
    </span>
  `;
}

function normalizeComparisonText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePackageByReference(currentState, reference, options = {}) {
  const value = String(reference || "").trim();
  if (!value) return null;

  const byId = currentState.contextPackages.find((pkg) => pkg.id === value);
  if (byId) return byId;

  const normalized = normalizeComparisonText(value);
  if (!normalized) return null;

  const byExactTitle = currentState.contextPackages.find(
    (pkg) => normalizeComparisonText(pkg.title) === normalized
  );
  if (byExactTitle) return byExactTitle;

  const partialTitleMatches = currentState.contextPackages.filter((pkg) =>
    normalizeComparisonText(pkg.title).includes(normalized)
  );
  if (partialTitleMatches.length === 1) return partialTitleMatches[0];

  if (options.allowSummaryMatch) {
    const summaryMatches = currentState.contextPackages.filter((pkg) =>
      normalizeComparisonText(getPackageSummaryText(pkg)).includes(normalized)
    );
    if (summaryMatches.length === 1) return summaryMatches[0];
  }

  return null;
}

function resolvePackageIdArg(currentState, args, toolCall, field = "id", options = {}) {
  const direct = args?.[field] ?? toolCall?.[field];
  const titleKey = field === "id" ? "title" : `${field.replace(/Id$/, "")}Title`;
  const targetKey = field === "id" ? "target" : `${field.replace(/Id$/, "")}Target`;
  const titleRef = args?.[titleKey] ?? toolCall?.[titleKey];
  const targetRef = args?.[targetKey] ?? toolCall?.[targetKey];

  const directMatch = resolvePackageByReference(currentState, direct, options);
  if (directMatch) return directMatch.id;
  if (typeof direct === "string" && direct.trim().startsWith("pkg-")) {
    return String(direct).trim();
  }

  const titleMatch = resolvePackageByReference(currentState, titleRef, options);
  if (titleMatch) return titleMatch.id;

  const targetMatch = resolvePackageByReference(currentState, targetRef, options);
  if (targetMatch) return targetMatch.id;

  return String(direct || "").trim() || "";
}

function findNearDuplicatePackage(currentState, title, content) {
  const normalizedTitle = normalizeComparisonText(title);
  const normalizedContent = normalizeComparisonText(content);

  return currentState.contextPackages.find((pkg) => {
    if (pkg.status === "dropped") return false;

    const pkgTitle = normalizeComparisonText(pkg.title);
    const pkgContent = normalizeComparisonText(getPackageSummaryText(pkg));

    if (normalizedTitle && normalizedContent) {
      if (pkgTitle === normalizedTitle && pkgContent === normalizedContent) {
        return true;
      }
    }

    if (normalizedContent && pkgContent === normalizedContent) {
      return true;
    }

    return false;
  }) ?? null;
}

function computeDuplicateCandidateLines(currentState) {
  const seen = new Map();
  const lines = [];

  for (const pkg of getSortedPackages(currentState)) {
    if (pkg.status === "dropped") continue;
    const key = `${normalizeComparisonText(pkg.title)}::${normalizeComparisonText(getPackageSummaryText(pkg))}`;
    if (!key || key === "::") continue;

    const existing = seen.get(key);
    if (existing) {
      existing.ids.push(pkg.id);
      existing.count += 1;
    } else {
      seen.set(key, {
        title: pkg.title,
        ids: [pkg.id],
        count: 1
      });
    }
  }

  for (const entry of seen.values()) {
    if (entry.count > 1) {
      lines.push(`- ${entry.title}: ${entry.ids.join(", ")}`);
    }
  }

  return lines;
}

function buildSharedCorePrompt(currentState) {
  return [
    String(currentState.config.sharedPrompt || "").trim(),
    `Background loop switch: ${currentState.config.backgroundEnabled ? "on" : "off"}.`,
    describeConversationCadence(currentState)
  ]
    .filter(Boolean)
    .join("\n");
}

function buildChatSystemPrompt(currentState, activePackages) {
  const totalTokens = activePackages.reduce((sum, pkg) => sum + estimatePackageTokens(pkg), 0);
  const { nextOut, atRisk } = getRiskBuckets(currentState);
  const conversationTree = buildConversationContextPackages(currentState, "chat", totalTokens, 1400);
  const recentChatMeta = conversationTree.meta;
  const recentChatWindow = recentChatMeta.messages;
  const recentChatTokens = recentChatMeta.keptTokens;
  const subconsciousTree = buildDecisionTraceContextPackages(currentState, totalTokens, "chat", recentChatTokens * 2);
  const subconsciousTrace = subconsciousTree.meta;
  const systemNotices = formatSystemNoticesForPrompt(currentState);
  const staleCarryover = formatStaleCarryoverForPrompt(currentState);
  const managedBudget = getManagedContextBudgetTokens(currentState);
  const conversationStructure = conversationTree.root
    ? summarizePackageTreeForPrompt(conversationTree.packages, conversationTree.root.id, 0, 12).join("\n")
    : "- none";
  const subconsciousStructure = subconsciousTree.root
    ? summarizePackageTreeForPrompt(subconsciousTree.packages, subconsciousTree.root.id, 0, 12).join("\n")
    : "- none";
  const sections = [
    buildSharedCorePrompt(currentState),
    String(currentState.config.chatPrompt || "").trim(),
    `Approximate managed context tokens: ${totalTokens} of ${managedBudget}.`,
    "__TOTAL_REQUEST_PLACEHOLDER__",
    `Recent system notices:\n${systemNotices || "- none"}`,
    `Stale background carryover:\n${staleCarryover || "- none"}`,
    `Maintained context packages:\n${activePackages.map(summarizePackageForPrompt).join("\n") || "- none"}`,
    `Recent conversation structure:\n${conversationStructure}`,
    `Recent raw chat retention:\n- keeping ${recentChatWindow.length} processed message${recentChatWindow.length === 1 ? "" : "s"} (~${recentChatMeta.keptTokens} tok)\n- older processed chat outside this retained window: ${recentChatMeta.omittedCount} message${recentChatMeta.omittedCount === 1 ? "" : "s"} (~${recentChatMeta.omittedTokens} tok)\n- likely to age out next: ${recentChatMeta.omittedPreview.join(" | ") || "none"}`,
    `Recent subconscious structure:\n${subconsciousStructure}`,
    `Recent subconscious retention:\n- keeping ${subconsciousTrace.entries.length} decision record${subconsciousTrace.entries.length === 1 ? "" : "s"} (${subconsciousTrace.fullCount} full, ${subconsciousTrace.compactCount} compact)\n- older subconscious work outside this retained window: ${subconsciousTrace.omittedCount} record${subconsciousTrace.omittedCount === 1 ? "" : "s"} (~${subconsciousTrace.omittedTokens} tok)\n- likely to age out next: ${subconsciousTrace.omittedPreview.join(" | ") || "none"}`,
    `Next out if unused:\n${nextOut.map((pkg) => `- ${pkg.title}`).join("\n") || "- none"}`,
    `At risk next turn:\n${atRisk.map((pkg) => `- ${pkg.title}`).join("\n") || "- none"}`,
    `Recent raw chat window:\n${formatRecentChatForPrompt(recentChatWindow, 280) || "- none"}`
  ];
  let prompt = sections.join("\n\n");
  const estimatedRequestTokens =
    estimateTextTokens(prompt.replace("__TOTAL_REQUEST_PLACEHOLDER__", "")) + recentChatTokens;
  prompt = prompt.replace(
    "__TOTAL_REQUEST_PLACEHOLDER__",
    `Approximate total request tokens: ${estimatedRequestTokens} of ${TOTAL_REQUEST_BUDGET_TOKENS}.`
  );
  return prompt;
}

function buildInnerLoopPrompt(currentState, activePackages, feedbackTrail = []) {
  const recentDecisions = currentState.background.decisions
    .slice(0, 6)
    .map((decision) => `- ${decision.tool} [${decision.kind}]: ${decision.reason}`)
    .join("\n");
  const duplicateCandidates = computeDuplicateCandidateLines(currentState).join("\n");
  const totalTokens = activePackages.reduce((sum, pkg) => sum + estimatePackageTokens(pkg), 0);
  const { nextOut, atRisk } = getRiskBuckets(currentState);
  const feedbackBlock = feedbackTrail.length
    ? feedbackTrail.map((item) => `- ${item}`).join("\n")
    : "- none";
  const dynamicReserve =
    estimateTextTokens(recentDecisions || "- none") +
    estimateTextTokens(duplicateCandidates || "- none") +
    estimateTextTokens(feedbackBlock);
  const conversationTree = buildConversationContextPackages(
    currentState,
    "background",
    totalTokens,
    dynamicReserve + 1400
  );
  const recentChatMeta = conversationTree.meta;
  const recentChatWindow = recentChatMeta.messages;
  const recentChatTokens = recentChatMeta.keptTokens;
  const subconsciousTree = buildDecisionTraceContextPackages(
    currentState,
    totalTokens,
    "background",
    dynamicReserve + recentChatTokens
  );
  const subconsciousTrace = subconsciousTree.meta;
  const systemNotices = formatSystemNoticesForPrompt(currentState);
  const staleCarryover = formatStaleCarryoverForPrompt(currentState);
  const managedBudget = getManagedContextBudgetTokens(currentState);
  const conversationStructure = conversationTree.root
    ? summarizePackageTreeForPrompt(conversationTree.packages, conversationTree.root.id, 0, 12).join("\n")
    : "- none";
  const subconsciousStructure = subconsciousTree.root
    ? summarizePackageTreeForPrompt(subconsciousTree.packages, subconsciousTree.root.id, 0, 14).join("\n")
    : "- none";

  const sections = [
    buildSharedCorePrompt(currentState),
    String(currentState.config.backgroundPrompt || "").trim(),
    `Approximate managed context tokens: ${totalTokens} of ${managedBudget}.`,
    "__TOTAL_REQUEST_PLACEHOLDER__",
    `Recent system notices:\n${systemNotices || "- none"}`,
    `Stale background carryover:\n${staleCarryover || "- none"}`,
    `Maintained context packages:\n${activePackages.map(summarizePackageForPrompt).join("\n") || "- none"}`,
    `Recent conversation structure:\n${conversationStructure}`,
    `Recent raw chat retention:\n- keeping ${recentChatWindow.length} processed message${recentChatWindow.length === 1 ? "" : "s"} (~${recentChatMeta.keptTokens} tok)\n- older processed chat outside this retained window: ${recentChatMeta.omittedCount} message${recentChatMeta.omittedCount === 1 ? "" : "s"} (~${recentChatMeta.omittedTokens} tok)\n- likely to age out next: ${recentChatMeta.omittedPreview.join(" | ") || "none"}\n- if omitted chat still matters, preserve its durable consequences in maintained context before more turns push it farther away.`,
    `Next out if unused:\n${nextOut.map((pkg) => `- ${pkg.title}`).join("\n") || "- none"}`,
    `At risk next turn:\n${atRisk.map((pkg) => `- ${pkg.title}`).join("\n") || "- none"}`,
    `Duplicate candidates:\n${duplicateCandidates || "- none"}`,
    `Recent subconscious structure:\n${subconsciousStructure}`,
    `Recent subconscious retention:\n- keeping ${subconsciousTrace.entries.length} decision record${subconsciousTrace.entries.length === 1 ? "" : "s"} (${subconsciousTrace.fullCount} full, ${subconsciousTrace.compactCount} compact)\n- older subconscious work outside this retained window: ${subconsciousTrace.omittedCount} record${subconsciousTrace.omittedCount === 1 ? "" : "s"} (~${subconsciousTrace.omittedTokens} tok)\n- likely to age out next: ${subconsciousTrace.omittedPreview.join(" | ") || "none"}\n- if omitted subconscious work still matters, compact or preserve it durably instead of relying on it to stay in the live trace.`,
    `Recent decisions:\n${recentDecisions || "- none"}`,
    `Immediate tool feedback:\n${feedbackBlock}`,
    `Recent raw chat window:\n${formatRecentChatForPrompt(recentChatWindow, 260) || "- none"}`
  ];
  let prompt = sections.join("\n\n");
  const estimatedRequestTokens =
    estimateTextTokens(prompt.replace("__TOTAL_REQUEST_PLACEHOLDER__", "")) +
    estimateTextTokens("Inspect the current maintained context and return the next single tool call as strict JSON.");
  prompt = prompt.replace(
    "__TOTAL_REQUEST_PLACEHOLDER__",
    `Approximate total request tokens: ${estimatedRequestTokens} of ${TOTAL_REQUEST_BUDGET_TOKENS}.`
  );
  return prompt;
}

function pushStaleBackgroundCarryover(currentState, executionLike) {
  currentState.staleBackgroundCarryover.unshift({
    id: uid("carry"),
    tool: executionLike?.tool || "stale_background_result",
    summary: executionLike?.summary || "Stale background result needs amendment against newer chat state.",
    reason: executionLike?.reason || "",
    rawOutput: executionLike?.rawOutput || "",
    createdAt: nowIso()
  });
  currentState.staleBackgroundCarryover = currentState.staleBackgroundCarryover.slice(0, 8);
}

async function callModelWithMessages(currentState, messages, temperature = 0.7) {
  const requestStartedAt = performance.now();
  enqueueDebugEvent({
    type: "model_request",
    model: currentState.config.model,
    endpoint: currentState.config.endpoint,
    temperature,
    messages
  });

  const headers = { "Content-Type": "application/json" };
  if (currentState.config.apiKey.trim()) {
    headers.Authorization = `Bearer ${currentState.config.apiKey.trim()}`;
  }

  const response = await fetch(currentState.config.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: currentState.config.model,
      messages,
      temperature
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    enqueueDebugEvent({
      type: "model_error",
      model: currentState.config.model,
      endpoint: currentState.config.endpoint,
      status: response.status,
      statusText: response.statusText,
      errorText,
      durationMs: Math.round(performance.now() - requestStartedAt)
    });
    throw new Error(`${response.status} ${response.statusText}: ${errorText}`);
  }

  const payload = await response.json();
  const text = normalizeAssistantText(payload);
  if (!text) {
    throw new Error("Model response did not include readable assistant text.");
  }

  enqueueDebugEvent({
    type: "model_response",
    model: currentState.config.model,
    endpoint: currentState.config.endpoint,
    durationMs: Math.round(performance.now() - requestStartedAt),
    text,
    payload
  });

  return text;
}

function dedupeQueuedUserMessage(currentState, message) {
  const trimmed = String(message || "").trim();
  if (!trimmed) return false;

  const queuedTexts = currentState.background.pendingUserMessages.map((item) =>
    item.trim().toLowerCase()
  );

  return queuedTexts.includes(trimmed.toLowerCase());
}

function extractUserMessageFromToolCall(toolCall, args) {
  const candidates = [
    args?.message,
    args?.text,
    args?.content,
    toolCall?.message,
    toolCall?.text,
    toolCall?.content
  ];

  return candidates
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
}

function extractContextContentFromToolCall(toolCall, args) {
  const candidates = [
    args?.content,
    args?.text,
    args?.body,
    args?.summary,
    args?.focus,
    args?.target_idea,
    args?.idea,
    args?.note,
    toolCall?.content,
    toolCall?.text,
    toolCall?.body,
    toolCall?.summary,
    toolCall?.focus,
    toolCall?.target_idea,
    toolCall?.idea,
    toolCall?.note
  ];

  return candidates
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
}

function extractContextDetailsFromToolCall(toolCall, args) {
  const candidates = [
    args?.details,
    args?.body,
    args?.notes,
    args?.contentDetails,
    toolCall?.details,
    toolCall?.body,
    toolCall?.notes,
    toolCall?.contentDetails
  ];

  return candidates
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
}

function extractContextTitleFromToolCall(toolCall, args, fallback = "Context package") {
  const candidates = [
    args?.title,
    args?.name,
    args?.label,
    args?.focus,
    args?.target_idea,
    toolCall?.title,
    toolCall?.name,
    toolCall?.label,
    toolCall?.focus,
    toolCall?.target_idea
  ];

  return candidates
    .map((value) => String(value || "").trim())
    .find(Boolean) || fallback;
}

function toolError(tool, reason, args, message, code = "tool_error") {
  return {
    changed: false,
    tool,
    reason: reason || message,
    summary: "Tool call failed.",
    diff: "",
    args,
    error: {
      code,
      message
    },
    deterministicResponse: `Invalid target for ${tool}. ${message}`
  };
}

function normalizeToolEnvelope(toolCall) {
  const summary = String(toolCall?.summary || "").trim();
  const reason = String(toolCall?.reason || "").trim();

  if (toolCall?.tool === "continue_turn" && toolCall?.action?.tool) {
    return {
      tool: String(toolCall.action.tool || "").trim() || "do_nothing",
      args: toolCall.action.args ?? {},
      reason,
      summary
    };
  }

  return {
    tool: String(toolCall?.tool || "do_nothing").trim() || "do_nothing",
    args: toolCall?.args ?? {},
    reason,
    summary
  };
}

function snapshotPackage(pkg) {
  if (!pkg) return null;
  return {
    id: pkg.id,
    title: pkg.title,
    summary: getPackageSummaryText(pkg),
    content: pkg.content,
    kind: pkg.kind,
    parentId: pkg.parentId ?? null,
    childIds: [...(pkg.childIds ?? [])],
    priority: pkg.priority,
    pinned: pkg.pinned,
    readOnly: pkg.readOnly,
    turnsLeft: pkg.turnsLeft,
    status: pkg.status,
    source: pkg.source
  };
}

function diffSnapshots(before, after) {
  if (!before && !after) return "";
  if (!before && after) {
    return [
      `created ${after.id}`,
      `+ title: ${after.title}`,
      `+ summary: ${after.summary}`,
      `+ kind: ${after.kind}`,
      `+ parentId: ${after.parentId ?? "root"}`,
      `+ priority: ${after.priority.toFixed(2)}`,
      `+ turnsLeft: ${after.turnsLeft}`,
      `+ content: ${after.content}`
    ].join("\n");
  }
  if (before && !after) {
    return [
      `deleted ${before.id}`,
      `- title: ${before.title}`,
      `- summary: ${before.summary}`,
      `- kind: ${before.kind}`,
      `- parentId: ${before.parentId ?? "root"}`,
      `- priority: ${before.priority.toFixed(2)}`,
      `- turnsLeft: ${before.turnsLeft}`,
      `- content: ${before.content}`
    ].join("\n");
  }

  const lines = [`updated ${after.id}`];
  const keys = ["title", "summary", "content", "kind", "parentId", "priority", "turnsLeft", "status", "pinned", "readOnly"];
  for (const key of keys) {
    const prev = before[key];
    const next = after[key];
    if (prev !== next) {
      lines.push(`- ${key}: ${prev}`);
      lines.push(`+ ${key}: ${next}`);
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

function executeToolCall(currentState, toolCall) {
  const envelope = normalizeToolEnvelope(toolCall);
  const tool = envelope.tool;
  const args = envelope.args;
  const reason = envelope.reason;
  const modelSummary = envelope.summary;

  switch (tool) {
    case "create_context_chunk": {
      const content = extractContextContentFromToolCall(toolCall, args);
      const details = extractContextDetailsFromToolCall(toolCall, args);
      if (!content && !details) return toolError(tool, reason, args, "Missing summary or details for new context.", "missing_content");
      const title = extractContextTitleFromToolCall(toolCall, args, makeTitle(content || details, "New context"));
      const normalizedContent =
        /[.!?]/.test(content || details) || String(content || details).length > 60
          ? String(content || details)
          : `${String(content || details).charAt(0).toUpperCase()}${String(content || details).slice(1)}.`;
      const parentId = resolvePackageIdArg(currentState, args, toolCall, "parentId") || null;
      if (parentId && !currentState.contextPackages.find((pkg) => pkg.id === parentId)) {
        return toolError(tool, reason, args, `Parent package ${parentId} was not found.`, "invalid_target");
      }
      const duplicate = findNearDuplicatePackage(currentState, title, normalizedContent);

      if (duplicate) {
        if (duplicate.readOnly) {
          const before = snapshotPackage(duplicate);
          updateContextPackage(currentState, duplicate.id, {
            priority: clamp(duplicate.priority + 0.08, 0.05, 1),
            turnsLeft: duplicate.pinned ? 999 : clamp(Math.max(duplicate.turnsLeft ?? 0, 8), 0, 18),
            status: "active"
          });
          const after = snapshotPackage(currentState.contextPackages.find((pkg) => pkg.id === duplicate.id));
          enqueueDebugEvent({
            type: "context_deduped_to_focus",
            tool,
            reason,
            duplicateOf: duplicate.id
          });
          return {
        changed: true,
        tool: "focus_context_chunk",
        reason,
        summary: modelSummary || `Matched read-only package "${duplicate.title}"; reinforced it instead of creating a duplicate.`,
        diff: diffSnapshots(before, after),
        args
      };
        }

        const before = snapshotPackage(duplicate);
        const updated = updateContextPackage(currentState, duplicate.id, {
          title,
          summary: normalizedContent,
          content: details || duplicate.content,
          kind: String(args.kind || toolCall?.kind || duplicate.kind).trim() || duplicate.kind,
          parentId: parentId ?? duplicate.parentId ?? null,
          priority: clamp(
            Math.max(
              duplicate.priority,
              Number(args.priority ?? toolCall?.priority ?? duplicate.priority)
            ),
            0.05,
            1
          ),
          pinned: Boolean(args.pinned ?? toolCall?.pinned ?? duplicate.pinned),
          turnsLeft: Boolean(args.pinned ?? toolCall?.pinned ?? duplicate.pinned)
            ? 999
            : clamp(
                Math.max(
                  duplicate.turnsLeft ?? 0,
                  Number(
                    args.turnsLeft ??
                      args.turns_left ??
                      toolCall?.turnsLeft ??
                      toolCall?.turns_left ??
                      7
                  )
                ),
                0,
                18
              ),
          status: "active"
        });

        if (updated) {
          enqueueDebugEvent({
            type: "context_deduped_to_update",
            tool,
            reason,
            duplicateOf: duplicate.id,
            package: updated
          });
        }

        return {
          changed: Boolean(updated),
          tool: "update_context_chunk",
          reason,
          summary: modelSummary || `Matched existing package "${duplicate.title}"; updated it instead of creating a duplicate.`,
          diff: diffSnapshots(before, snapshotPackage(updated)),
          args
        };
      }

      const created = addContextPackage(currentState, {
        title,
        summary: normalizedContent,
        contentDetails: details,
        kind: String(args.kind || toolCall?.kind || "note").trim() || "note",
        parentId,
        priority: clamp(Number(args.priority ?? toolCall?.priority ?? 0.6), 0.05, 1),
        pinned: Boolean(args.pinned ?? toolCall?.pinned),
        turnsLeft: Boolean(args.pinned ?? toolCall?.pinned)
          ? 999
          : clamp(Number(args.turnsLeft ?? args.turns_left ?? toolCall?.turnsLeft ?? toolCall?.turns_left ?? 7), 0, 18),
        source: "background"
      });

      if (created) {
        enqueueDebugEvent({
          type: "context_created",
          tool,
          reason,
          package: created
        });
      }
      return {
        changed: Boolean(created),
        tool,
        reason,
        summary: modelSummary || (created ? `Created new context package "${created.title}".` : "No package was created."),
        diff: diffSnapshots(null, snapshotPackage(created)),
        args
      };
    }

    case "create_child_context_chunk": {
      const parentId = resolvePackageIdArg(currentState, args, toolCall, "parentId");
      if (!parentId) return toolError(tool, reason, args, "Missing parent id.", "missing_target");
      if (!currentState.contextPackages.find((pkg) => pkg.id === parentId)) {
        return toolError(tool, reason, args, `Parent package ${parentId} was not found.`, "invalid_target");
      }
      return executeToolCall(currentState, {
        ...toolCall,
        tool: "create_context_chunk",
        args: {
          ...args,
          parentId
        }
      });
    }

    case "update_context_chunk": {
      const id = resolvePackageIdArg(currentState, args, toolCall, "id", { allowSummaryMatch: true });
      if (!id) return toolError(tool, reason, args, "Missing target id.", "missing_target");

      const pkg = currentState.contextPackages.find((item) => item.id === id);
      if (!pkg) return toolError(tool, reason, args, `Target package ${id} was not found.`, "invalid_target");
      if (pkg.readOnly) {
        return toolError(tool, reason, args, `Target package ${id} is read-only and cannot be overwritten.`, "read_only_target");
      }

      const nextContent = extractContextContentFromToolCall(toolCall, args);
      const nextDetails = extractContextDetailsFromToolCall(toolCall, args);
      const nextTitle = extractContextTitleFromToolCall(toolCall, args, "");
      const resolvedParentId = resolvePackageIdArg(currentState, args, toolCall, "parentId");
      const nextParentId =
        args.parentId === undefined &&
        toolCall?.parentId === undefined &&
        args.parentTitle === undefined &&
        toolCall?.parentTitle === undefined
          ? pkg.parentId
          : (resolvedParentId || null);
      if (nextParentId && !currentState.contextPackages.find((item) => item.id === nextParentId)) {
        return toolError(tool, reason, args, `Target parent ${nextParentId} was not found.`, "invalid_target");
      }
      if (nextParentId && (nextParentId === id || isDescendantPackage(currentState, nextParentId, id))) {
        return toolError(tool, reason, args, "A package cannot be moved under itself or one of its descendants.", "invalid_target");
      }
      const priority =
        args.priority === undefined && toolCall?.priority === undefined
          ? pkg.priority
          : clamp(Number(args.priority ?? toolCall?.priority), 0.05, 1);
      const pinned =
        args.pinned === undefined && toolCall?.pinned === undefined
          ? pkg.pinned
          : Boolean(args.pinned ?? toolCall?.pinned);
      const turnsLeft =
        args.turnsLeft === undefined && toolCall?.turnsLeft === undefined
          ? (pinned ? 999 : Math.max(pkg.turnsLeft ?? 6, 6))
          : (pinned
              ? 999
              : clamp(
                  Number(
                    args.turnsLeft ??
                      args.turns_left ??
                      toolCall?.turnsLeft ??
                      toolCall?.turns_left
                  ),
                  0,
                  18
                ));

      const before = snapshotPackage(pkg);
      const updated = updateContextPackage(currentState, id, {
        title: nextTitle || pkg.title,
        summary: nextContent || getPackageSummaryText(pkg),
        content: nextDetails || pkg.content,
        kind: String(args.kind || toolCall?.kind || pkg.kind).trim() || pkg.kind,
        parentId: nextParentId,
        priority,
        pinned,
        turnsLeft,
        status: "active"
      });

      if (updated) {
        enqueueDebugEvent({
          type: "context_updated",
          tool,
          reason,
          package: updated
        });
      }
      return {
        changed: Boolean(updated),
        tool,
        reason,
        summary: modelSummary || (updated ? `Updated package "${pkg.title}".` : "No package was updated."),
        diff: diffSnapshots(before, snapshotPackage(updated)),
        args
      };
    }

    case "move_context_chunk": {
      const id = resolvePackageIdArg(currentState, args, toolCall, "id");
      const parentId = resolvePackageIdArg(currentState, args, toolCall, "parentId") || null;
      if (!id) return toolError(tool, reason, args, "Missing target id.", "missing_target");
      const pkg = currentState.contextPackages.find((item) => item.id === id);
      if (!pkg) return toolError(tool, reason, args, `Target package ${id} was not found.`, "invalid_target");
      if (pkg.readOnly) {
        return toolError(tool, reason, args, `Target package ${id} is read-only and cannot be moved.`, "read_only_target");
      }
      if (parentId && !currentState.contextPackages.find((item) => item.id === parentId)) {
        return toolError(tool, reason, args, `Parent package ${parentId} was not found.`, "invalid_target");
      }
      if (parentId && (parentId === id || isDescendantPackage(currentState, parentId, id))) {
        return toolError(tool, reason, args, "A package cannot be moved under itself or one of its descendants.", "invalid_target");
      }
      const before = snapshotPackage(pkg);
      const updated = updateContextPackage(currentState, id, { parentId });
      return {
        changed: Boolean(updated),
        tool,
        reason,
        summary: modelSummary || (updated ? `Moved package "${pkg.title}".` : "No package was moved."),
        diff: diffSnapshots(before, snapshotPackage(updated)),
        args
      };
    }

    case "focus_context_chunk": {
      const id = resolvePackageIdArg(currentState, args, toolCall, "id");
      const pkg = currentState.contextPackages.find((item) => item.id === id);
      if (!id) return toolError(tool, reason, args, "Missing target id.", "missing_target");
      if (!pkg) return toolError(tool, reason, args, `Target package ${id} was not found.`, "invalid_target");

      const before = snapshotPackage(pkg);
      updateContextPackage(currentState, id, {
        priority: clamp(pkg.priority + 0.2, 0.05, 1),
        turnsLeft: 10,
        status: "active"
      });

      enqueueDebugEvent({
        type: "context_focused",
        tool,
        reason,
        id
      });
      return {
        changed: true,
        tool,
        reason,
        summary: modelSummary || `Focused package "${pkg.title}".`,
        diff: diffSnapshots(before, snapshotPackage(currentState.contextPackages.find((item) => item.id === id))),
        args
      };
    }

    case "retitle_context_chunk": {
      const id = resolvePackageIdArg(currentState, args, toolCall, "id");
      const title = String(args.title || "").trim();
      if (!id) return toolError(tool, reason, args, "Missing target id.", "missing_target");
      if (!title) return toolError(tool, reason, args, "Missing title.", "missing_title");
      const pkg = currentState.contextPackages.find((item) => item.id === id);
      if (!pkg) return toolError(tool, reason, args, `Target package ${id} was not found.`, "invalid_target");
      if (pkg.readOnly) {
        return toolError(tool, reason, args, `Target package ${id} is read-only and cannot be retitled.`, "read_only_target");
      }

      const before = snapshotPackage(pkg);
      const updated = updateContextPackage(currentState, id, { title });
      if (updated) {
        enqueueDebugEvent({
          type: "context_retitled",
          tool,
          reason,
          id,
          title
        });
      }
      return {
        changed: Boolean(updated),
        tool,
        reason,
        summary: modelSummary || (updated ? `Retitled package "${before?.title || id}".` : "No package was retitled."),
        diff: diffSnapshots(before, snapshotPackage(updated)),
        args
      };
    }

    case "delete_context_chunk": {
      const id = resolvePackageIdArg(currentState, args, toolCall, "id");
      if (!id) return toolError(tool, reason, args, "Missing target id.", "missing_target");
      const pkg = currentState.contextPackages.find((item) => item.id === id);
      if (!pkg) return toolError(tool, reason, args, `Target package ${id} was not found.`, "invalid_target");
      if (pkg.readOnly) {
        return toolError(tool, reason, args, `Target package ${id} is read-only and cannot be deleted.`, "read_only_target");
      }

      const before = snapshotPackage(pkg);
      const mode = String(args.mode || "subtree").trim();
      const removed = removeContextPackage(currentState, id, mode === "promote_children" ? "promote_children" : "subtree");
      if (removed) {
        enqueueDebugEvent({
          type: "context_deleted",
          tool,
          reason,
          id
        });
      }
      return {
        changed: removed,
        tool,
        reason,
        summary: modelSummary || (removed ? `Deleted package "${pkg.title}".` : "No package was deleted."),
        diff: diffSnapshots(before, null),
        args
      };
    }

    case "summarize_context_chunk": {
      const ids = Array.isArray(args.ids)
        ? args.ids
            .map((value) => resolvePackageByReference(currentState, value, { allowSummaryMatch: true })?.id || String(value))
            .filter(Boolean)
        : [];
      const sources = currentState.contextPackages.filter((pkg) => ids.includes(pkg.id));
      if (!ids.length) return toolError(tool, reason, args, "Missing source ids.", "missing_target");
      if (!sources.length) return toolError(tool, reason, args, "No matching source packages were found.", "invalid_target");

      const summaryText =
        String(args.summary_text || args.summary || "").trim() ||
        sources.map((pkg) => getPackageSummaryText(pkg)).filter(Boolean).join(" ");
      const detailText =
        String(args.details || args.content || "").trim() ||
        sources.map((pkg) => getPackageDetailText(pkg)).filter(Boolean).join("\n");
      const title = String(args.title || "").trim() || makeTitle(summaryText || detailText, "Summary");
      const before = sources.map(snapshotPackage);
      const parentId = getCommonParentId(sources);

      const created = addContextPackage(currentState, {
        title,
        summary: summaryText || detailText,
        contentDetails: detailText,
        kind: "summary",
        parentId,
        priority: clamp(Math.max(...sources.map((pkg) => pkg.priority), 0.58), 0.05, 1),
        lineageHue: blendLineageHue(sources),
        turnsLeft: 8,
        source: "background"
      });

      sources.filter((pkg) => !pkg.readOnly).forEach((pkg) => {
        updateContextPackage(currentState, pkg.id, {
          parentId: created?.id ?? parentId,
          priority: clamp(pkg.priority - 0.12, 0.05, 1),
          turnsLeft: 2,
          status: "active"
        });
      });

      if (created) {
        enqueueDebugEvent({
          type: "context_summarized",
          tool,
          reason,
          sourceIds: ids,
          package: created
        });
      }
      const after = [
        ...sources.map((pkg) => snapshotPackage(currentState.contextPackages.find((item) => item.id === pkg.id))),
        snapshotPackage(created)
      ]
        .filter(Boolean)
        .map((pkg, index) => diffSnapshots(before[index] ?? null, pkg))
        .filter(Boolean)
        .join("\n\n");

      return {
        changed: Boolean(created),
        tool,
        reason,
        summary: modelSummary || (created ? `Summarized ${sources.length} package(s) into "${created.title}".` : "No summary package was created."),
        diff: after,
        args
      };
    }

    case "merge_context_chunks": {
      const ids = Array.isArray(args.ids)
        ? args.ids
            .map((value) => resolvePackageByReference(currentState, value, { allowSummaryMatch: true })?.id || String(value))
            .filter(Boolean)
        : [];
      const sources = currentState.contextPackages.filter((pkg) => ids.includes(pkg.id));
      if (ids.length < 2) return toolError(tool, reason, args, "Merge requires at least two source ids.", "missing_target");
      if (sources.length < 2) return toolError(tool, reason, args, "Merge targets were not found.", "invalid_target");
      const readOnlySource = sources.find((pkg) => pkg.readOnly);
      if (readOnlySource) {
        return toolError(
          tool,
          reason,
          args,
          `Target package ${readOnlySource.id} is read-only and cannot be merged away.`,
          "read_only_target"
        );
      }

      const mergedSummary =
        String(args.summary_text || args.summary || "").trim() ||
        sources.map((pkg) => getPackageSummaryText(pkg)).filter(Boolean).join(" ");
      const mergedDetails =
        String(args.details || args.content || "").trim() ||
        sources.map((pkg) => getPackageDetailText(pkg)).filter(Boolean).join("\n");
      const title = String(args.title || "").trim() || makeTitle(mergedSummary || mergedDetails, "Merged context");
      const before = sources.map(snapshotPackage);
      const parentId = getCommonParentId(sources);

      const created = addContextPackage(currentState, {
        title,
        summary: mergedSummary || mergedDetails,
        contentDetails: mergedDetails,
        kind: "summary",
        parentId,
        priority: clamp(Math.max(...sources.map((pkg) => pkg.priority)), 0.05, 1),
        lineageHue: blendLineageHue(sources),
        turnsLeft: 9,
        source: "background"
      });

      sources.forEach((source) => {
        getChildPackages(currentState, source.id).forEach((child) => {
          updateContextPackage(currentState, child.id, { parentId: created?.id ?? parentId });
        });
      });
      ids.forEach((id) => removeContextPackage(currentState, id, "promote_children"));
      if (created) {
        enqueueDebugEvent({
          type: "context_merged",
          tool,
          reason,
          sourceIds: ids,
          package: created
        });
      }
      const after = [
        ...before.map((pkg) => diffSnapshots(pkg, null)),
        diffSnapshots(null, snapshotPackage(created))
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        changed: Boolean(created),
        tool,
        reason,
        summary: modelSummary || (created ? `Merged ${sources.length} package(s) into ${created.id}.` : "No merged package was created."),
        diff: after,
        args
      };
    }

    case "send_message_to_user": {
      const message = extractUserMessageFromToolCall(toolCall, args);
      if (!message || dedupeQueuedUserMessage(currentState, message)) {
        return toolError(tool, reason, args, "Message was empty or already queued.", "noop_message");
      }

      currentState.background.pendingUserMessages.push(message);
      currentState.background.pendingUserMessages = currentState.background.pendingUserMessages.slice(-4);
      enqueueDebugEvent({
        type: "user_message_queued",
        tool,
        reason,
        message
      });
      return {
        changed: true,
        tool,
        reason,
        summary: modelSummary || "Queued a proactive user-facing message.",
        diff: "",
        args
      };
    }

    case "do_nothing":
    default:
      return {
        changed: false,
        tool: tool || "do_nothing",
        reason,
        summary: modelSummary || "No state change.",
        diff: "",
        args
      };
  }
}

function flushPendingUserMessages(currentState) {
  const pending = [...currentState.background.pendingUserMessages];
  currentState.background.pendingUserMessages = [];

  pending.forEach((message) => {
    addChatMessage(currentState, "assistant", message, "proactive");
    maybeIngestChatIntoContext(currentState, "assistant", message);
    enqueueDebugEvent({
      type: "user_message_surfaced",
      message
    });
  });

  if (pending.length) {
    pushActivity(
      currentState,
      "Surfaced proactive messages",
      `Sent ${pending.length} proactive message${pending.length > 1 ? "s" : ""}.`,
      "surface"
    );
  }

  return pending.length;
}

async function runBackgroundCycle(currentState) {
  const cycleRevision = currentState.processedConversationRevision;
  enqueueDebugEvent({
    type: "background_cycle_start",
    tickCount: currentState.background.tickCount + 1,
    backgroundEnabled: currentState.config.backgroundEnabled,
    processedConversationRevision: cycleRevision
  });

  currentState.background.status = "thinking";
  currentState.background.currentAction = "Inspecting maintained context";
  currentState.background.tickCount += 1;
  setLiveDecision(currentState, {
    status: "in_progress",
    tool: "thinking",
    summary: "Inspecting maintained context",
    reason: "Preparing the next single background action."
  });
  renderBackgroundPanel();
  renderLiveBits();

  updatePackageDiagnostics(currentState);

  let didWork = false;
  const feedbackTrail = [];
  const conversation = [];
  let rawOutput = "";
  let execution = null;
  const backgroundTurnInstruction =
    "Inspect the current maintained context and return the next single tool call as strict JSON.";

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const activePackages = getActivePackages(currentState);
    const prompt = buildInnerLoopPrompt(currentState, activePackages, feedbackTrail);
    currentState.debug.lastBackgroundPrompt = prompt;

    const messages = [
      { role: "system", content: prompt },
      { role: "user", content: backgroundTurnInstruction },
      ...conversation
    ];

    rawOutput = await callModelWithMessages(currentState, messages, 0.45);
    currentState.debug.lastBackgroundResponse = rawOutput;

    if (currentState.processedConversationRevision !== cycleRevision) {
      let staleExecution = null;
      try {
        const parsedStale = parseJsonObject(rawOutput);
        const envelope = normalizeToolEnvelope(parsedStale);
        staleExecution = {
          tool: envelope.tool,
          summary: envelope.summary,
          reason: envelope.reason,
          rawOutput
        };
      } catch {
        staleExecution = {
          tool: "stale_background_result",
          summary: "Stale background result needs amendment against newer chat state.",
          reason: "",
          rawOutput
        };
      }
      pushStaleBackgroundCarryover(currentState, staleExecution);
      currentState.background.currentAction = "Discarded stale background result";
      setLiveDecision(currentState, {
        status: "superseded",
        tool: staleExecution.tool || "stale_background_result",
        summary: staleExecution.summary || "Background result was superseded by newer conversation state.",
        reason: "Processed chat advanced while this background inference was in flight."
      });
      pushActivity(
        currentState,
        "Discarded stale background result",
        "Processed chat advanced while the background inference was in flight, so this result was preserved as carryover and will be amended against the newer conversation state.",
        "background"
      );
      enqueueDebugEvent({
        type: "background_result_discarded",
        reason: "processed_conversation_advanced",
        startedAtRevision: cycleRevision,
        currentRevision: currentState.processedConversationRevision,
        rawOutput,
        carryover: staleExecution
      });
      currentState.background.status = "idle";
      currentState.background.lastRunAt = nowIso();
      currentState.background.nextDelayMs = currentState.config.cooldownMs;
      currentState.background.nextRunAt = currentState.config.backgroundEnabled
        ? new Date(Date.now() + currentState.background.nextDelayMs).toISOString()
        : null;
      saveState(currentState);
      enqueueDebugEvent({
        type: "background_cycle_end",
        tickCount: currentState.background.tickCount,
        surfacedCount: 0,
        currentAction: currentState.background.currentAction,
        didWork: false
      });
      renderBackgroundPanel();
      renderLiveBits();
      return { didWork: false };
    }

    const parsed = parseJsonObject(rawOutput);
    execution = executeToolCall(currentState, parsed);
    setLiveDecision(currentState, {
      status: execution.error ? "amending" : "finalizing",
      tool: execution.tool,
      summary: execution.summary || getDecisionToolLabel(execution.tool),
      reason:
        execution.reason ||
        (execution.error ? "Amending after deterministic tool feedback." : "Finalizing this background decision.")
    });
    renderBackgroundPanel();

    pushDecision(
      currentState,
      execution.tool,
      execution.reason || (execution.changed ? "Tool executed." : "Tool call was a no-op."),
      execution.args,
      rawOutput,
      execution.error ? "error" : execution.changed ? "decision" : "noop",
      execution.summary || "",
      execution.diff || "",
      execution.deterministicResponse || ""
    );

    conversation.push({ role: "assistant", content: rawOutput });

    if (!execution.error) {
      break;
    }

    feedbackTrail.push(execution.deterministicResponse || execution.error.message);
    conversation.push({
      role: "user",
      content: `Deterministic tool response: ${execution.deterministicResponse || execution.error.message}`
    });
  }

  if (!execution) {
    execution = toolError("do_nothing", "", {}, "No tool execution result was produced.", "missing_execution");
  }

  if (currentState.staleBackgroundCarryover.length) {
    currentState.staleBackgroundCarryover = [];
  }

  currentState.background.currentAction = execution.reason || execution.tool;

  if (execution.error) {
    enqueueDebugEvent({
      type: "tool_error",
      tool: execution.tool,
      reason: execution.reason,
      error: execution.error,
      args: execution.args
    });
    pushActivity(
      currentState,
      `Tool error in ${execution.tool}`,
      execution.error.message,
      "error"
    );
  }

  if (execution.changed) {
    didWork = true;
    pushActivity(
      currentState,
      `Inner loop called ${execution.tool}`,
      execution.reason || "Tool executed without a stated reason.",
      "background"
    );
  }

  const surfacedCount = flushPendingUserMessages(currentState);
  if (surfacedCount) {
    didWork = true;
  }

  currentState.background.status = "idle";
  currentState.background.lastRunAt = nowIso();
  currentState.background.nextDelayMs = currentState.config.cooldownMs;
  currentState.background.nextRunAt = currentState.config.backgroundEnabled
    ? new Date(Date.now() + currentState.background.nextDelayMs).toISOString()
    : null;

  clearLiveDecision(currentState);
  saveState(currentState);
  enqueueDebugEvent({
    type: "background_cycle_end",
    tickCount: currentState.background.tickCount,
    surfacedCount,
    currentAction: currentState.background.currentAction,
    didWork
  });
  renderBackgroundPanel();
  return { didWork };
}

function buildChatMessagesForModel(currentState, pendingUserMessages) {
  const activePackages = getActivePackages(currentState);
  notePackagesUsed(
    currentState,
    activePackages.map((pkg) => pkg.id)
  );

  const systemPrompt = buildChatSystemPrompt(currentState, activePackages);
  currentState.debug.lastChatPrompt = systemPrompt;

  const recentChat = getRecentChatWindow(currentState)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.text
    }));

  const queuedUsers = pendingUserMessages.map((message) => ({
    role: "user",
    content: message.text
  }));

  return [
    { role: "system", content: systemPrompt },
    ...recentChat,
    ...queuedUsers
  ];
}

let chatTurnInFlight = false;

async function pumpChatQueue() {
  if (chatTurnInFlight) return;
  chatTurnInFlight = true;

  try {
    while (true) {
      const pendingUsers = getPendingUserChatMessages(state);
      if (!pendingUsers.length) break;

      enqueueDebugEvent({
        type: "chat_turn_start",
        userTexts: pendingUsers.map((message) => message.text)
      });

      const messages = buildChatMessagesForModel(state, pendingUsers);
      const responseText = await callModelWithMessages(state, messages, 0.72);
      state.debug.lastChatResponse = responseText;

      const processedAt = markMessagesProcessed(pendingUsers);
      addChatMessage(state, "assistant", responseText, "reply", {
        processed: true,
        processedAt
      });
      state.processedConversationRevision += 1;
      syncContextFromProcessedChat(state, pendingUsers, responseText);
      pushActivity(
        state,
        "Completed chat turn",
        `Processed ${pendingUsers.length} queued user message${pendingUsers.length === 1 ? "" : "s"} and stored assistant output.`,
        "chat"
      );

      saveState(state);
      renderChatMessages();
      renderBackgroundPanel();

      enqueueDebugEvent({
        type: "chat_turn_end",
        userTexts: pendingUsers.map((message) => message.text),
        assistantText: responseText,
        processedConversationRevision: state.processedConversationRevision
      });
    }
  } finally {
    chatTurnInFlight = false;
  }
}

async function handleChatTurn(userText) {
  const trimmed = String(userText || "").trim();
  if (!trimmed) return;

  addChatMessage(state, "user", trimmed, "reply", { processed: false });
  pushActivity(state, "Received user turn", "Queued the latest user message for the chat loop.", "chat");
  saveState(state);
  renderChatMessages();
  renderBackgroundPanel();

  await pumpChatQueue();
}

function resetStatePreservingConfig(currentState) {
  const fresh = createInitialState();
  return {
    ...fresh,
    config: { ...fresh.config, ...currentState.config },
    availableModels: [...currentState.availableModels],
    inferenceProfiles: [...currentState.inferenceProfiles],
    sharedPromptProfiles: [...currentState.sharedPromptProfiles],
    chatPromptProfiles: [...currentState.chatPromptProfiles],
    backgroundPromptProfiles: [...currentState.backgroundPromptProfiles],
    configProfiles: [...currentState.configProfiles],
    chat: [],
    contextPackages: fresh.contextPackages,
    activity: [],
    background: {
      ...fresh.background,
      nextDelayMs: currentState.config.cooldownMs,
      nextRunAt: currentState.config.backgroundEnabled
        ? new Date(Date.now() + currentState.config.cooldownMs).toISOString()
        : null
    }
  };
}

function nextRunLabel(currentState) {
  if (!currentState.config.backgroundEnabled) return "Paused";
  if (currentState.background.status === "thinking") return "Thinking";
  if (!currentState.background.nextRunAt) return "Idle";

  const diffMs = Math.max(0, new Date(currentState.background.nextRunAt).getTime() - Date.now());
  return `${(diffMs / 1000).toFixed(1)}s`;
}

function backgroundStatusLabel(currentState) {
  if (!currentState.config.backgroundEnabled) return "Paused";
  if (currentState.background.status === "thinking") return "Thinking";
  if (backgroundCycleInFlight) return "Working";
  return "Live";
}

function renderShell() {
  app.innerHTML = `
    <div class="app-shell">
      <div class="frame">
        <main class="workspace">
          <section class="panel chat-panel">
            <div class="panel-header">
              <h2 class="panel-title">Candle</h2>
            </div>
            <div class="panel-body">
              <div class="chat-stream" id="chat-stream"></div>
              <form class="composer" id="chat-form">
                <div class="composer-shell">
                  <textarea class="composer-input" name="message" rows="1" placeholder="Message Candle"></textarea>
                  <button type="submit" class="button composer-send" id="send-button">Send</button>
                </div>
              </form>
            </div>
          </section>

          <aside class="right-rail">
            <section class="panel">
              <div class="panel-header">
                <h2 class="panel-title">Background</h2>
                <div class="background-controls">
                  <button type="button" class="icon-button" id="run-cycle" aria-label="Run cycle">▶</button>
                  <label class="cooldown-chip">
                    <span class="cooldown-icon">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    </span>
                    <input class="cooldown-input" name="cooldownMs" type="number" min="0" step="100" />
                  </label>
                  <label class="loop-slider" id="loop-slider">
                    <input type="checkbox" name="backgroundEnabled" />
                    <div class="slider-track">
                      <div class="slider-thumb">
                        <svg class="cooldown-ring" viewBox="0 0 20 20">
                          <circle class="ring-bg" cx="10" cy="10" r="8"></circle>
                          <circle class="ring-progress" cx="10" cy="10" r="8"></circle>
                        </svg>
                      </div>
                    </div>
                  </label>
                </div>
              </div>

              <div class="rail-body rail-scroll" id="background-panel"></div>

              <div class="panel-footer" style="padding: 14px 18px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; gap: 10px;">
                <button type="button" class="button secondary settings-button" id="reset-state-top">Reset</button>
                <details class="settings-popover" id="settings-popover">
                  <summary class="button secondary settings-button">Settings</summary>
                  <div class="settings-popover-panel">
                    <div class="settings-popover-header">
                      <div class="settings-popover-heading">
                        <h3>Settings</h3>
                        <div class="settings-profile-row settings-profile-row-top">
                          <select class="select" name="configProfileSelect" id="config-profile-select-top"></select>
                          <button type="button" class="button secondary" id="save-config-profile">${getSaveFeedbackLabel("config", "Save config")}</button>
                        </div>
                      </div>
                      <button type="button" id="close-settings" aria-label="Close settings">×</button>
                    </div>
                    <div class="settings-popover-body" id="settings-fields"></div>
                  </div>
                </details>
              </div>
            </section>
          </aside>
        </main>
      </div>
    </div>
  `;

  uiInitialized = true;
  bindEvents();
}

function renderChatMessages() {
  const stream = document.querySelector("#chat-stream");
  if (!stream) return;

  const shouldStick = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 48;

  stream.innerHTML = state.chat.length
    ? state.chat
        .map(
          (message) => `
            <article class="message ${message.role} ${message.kind === "proactive" ? "proactive" : ""}">
              <div class="message-meta">
                <span>${escapeHtml(message.kind === "proactive" ? "assistant proactive" : message.role)}</span>
                <span>${formatTime(message.createdAt)}</span>
              </div>
              <div class="message-body">${renderMarkdown(message.text)}</div>
            </article>
          `
        )
        .join("")
    : `<div class="empty">No messages yet.</div>`;

  if (shouldStick) {
    stream.scrollTop = stream.scrollHeight;
  }
}

function renderBackgroundPanel() {
  const panel = document.querySelector("#background-panel");
  if (!panel) return;

  const contextModel = buildBackgroundContextModel(state);
  const contextPackages = contextModel.allPackages;
  const mapPackages = contextModel.topLevelPackages;
  const decisions = state.background.decisions.slice(0, 14);
  const liveDecision = state.background.liveDecision;
  const totalContextTokens = mapPackages.reduce(
    (sum, pkg) => sum + estimatePackageTokens(pkg),
    0
  );
  const managedBudget = getManagedContextBudgetTokens(state);
  ensureContextSelection(contextPackages);
  const selectedPackages = contextPackages.filter((pkg) =>
    uiState.selectedContextIds.includes(pkg.id)
  );
  const unselectedPackages = contextPackages.filter(
    (pkg) => !uiState.selectedContextIds.includes(pkg.id)
  );
  const paneMode =
    uiState.backgroundPaneMode === "decision" &&
    decisions.length
      ? "decision"
      : "context";
  const liveDecisionMarkup = liveDecision
    ? `
      <article class="decision-item decision-item-live decision-item-${escapeAttr(liveDecision.status || "in_progress")}">
        <div class="decision-live-head">
          <div class="decision-summary-main">
            ${getDecisionIconMarkup(
              liveDecision.status === "superseded"
                ? "move_context_chunk"
                : liveDecision.tool || "do_nothing"
            )}
            <div class="decision-summary-copy">
              <strong>${escapeHtml(liveDecision.summary || "Background thinking")}</strong>
              <span class="decision-tool-label">${escapeHtml(
                liveDecision.status === "superseded"
                  ? "superseded"
                  : liveDecision.status === "amending"
                    ? "amending"
                    : "in progress"
              )}</span>
            </div>
          </div>
          <span class="tiny">${escapeHtml(relativeTime(liveDecision.updatedAt || liveDecision.createdAt))}</span>
        </div>
        <p>${escapeHtml(liveDecision.reason || "Preparing the next background action.")}</p>
      </article>
    `
    : "";
  const savedDecisionMarkup = decisions
    .map(
      (decision) => `
        <details class="decision-item" data-decision-id="${escapeAttr(decision.id)}" ${
          uiState.expandedDecisionIds.includes(decision.id) ? "open" : ""
        }>
          <summary>
            <div class="decision-summary-main">
              ${getDecisionIconMarkup(decision.tool)}
              <div class="decision-summary-copy">
                <strong>${escapeHtml(decision.summary || getDecisionToolLabel(decision.tool))}</strong>
                <span class="decision-tool-label">${escapeHtml(getDecisionToolLabel(decision.tool))}</span>
              </div>
            </div>
            <span class="tiny">${escapeHtml(relativeTime(decision.createdAt))}</span>
          </summary>
          <p>${escapeHtml(decision.reason || "No reason provided.")}</p>
          ${decision.diff ? `<pre class="decision-raw">${escapeHtml(decision.diff)}</pre>` : ""}
          ${
            decision.deterministicResponse
              ? `<pre class="decision-raw">${escapeHtml(decision.deterministicResponse)}</pre>`
              : ""
          }
          ${
            decision.rawOutput
              ? `<pre class="decision-raw">${escapeHtml(decision.rawOutput)}</pre>`
              : ""
          }
        </details>
      `
    )
    .join("");
  const decisionMarkup =
    liveDecisionMarkup || savedDecisionMarkup
      ? `${liveDecisionMarkup}${savedDecisionMarkup}`
      : `<div class="empty">No decisions yet.</div>`;

  panel.innerHTML = `
    <div class="background-layout mode-${paneMode}">
      <div class="section compact-section context-section">
        <div class="section-title">
          <h3>Context</h3>
          <span class="tiny">${contextPackages.length} · ~${totalContextTokens}/${managedBudget} managed tok</span>
        </div>
        <div class="context-section-body">
          <div class="context-list context-map">
            ${
              mapPackages.length
                ? mapPackages
                    .map(
                      (pkg) => {
                        const tile = getContextTileStyle(pkg, managedBudget);
                        const selected = uiState.selectedContextIds.includes(pkg.id);

                        return `
                        <button
                          type="button"
                          class="context-tile ${selected ? "is-selected" : ""}"
                          data-context-id="${escapeAttr(pkg.id)}"
                          aria-label="${escapeAttr(pkg.title)}"
                          title="${escapeAttr(`${pkg.title} · ~${tile.tokens}/${managedBudget} tok · P ${pkg.priority.toFixed(2)} · ${pkg.kind}${pkg.pinned ? " · pinned" : ""}${pkg.readOnly ? " · read-only" : ""}`)}"
                          style="${tile.style}"
                        ></button>
                      `;
                      }
                    )
                    .join("")
                : `<div class="empty">No maintained context yet.</div>`
            }
          </div>
          <div class="context-inspector">
            ${
              selectedPackages.length
                ? selectedPackages
                    .map((pkg) => {
                      const path = getPackagePath(state, pkg.id).map((item) => item.title).join(" / ");
                      const children = getChildPackages(state, pkg.id);
                      const summary = getPackageSummaryText(pkg);
                      const details = getPackageDetailText(pkg);
                      return `
                        <article class="context-inspector-card">
                          <div class="section-title">
                            <h3>${escapeHtml(pkg.title)}</h3>
                            <span class="tiny">~${estimatePackageTokens(pkg)} tok</span>
                          </div>
                          <div class="context-breadcrumb">${escapeHtml(path || pkg.title)}</div>
                          ${summary ? `<p class="context-summary">${escapeHtml(summary)}</p>` : ""}
                          ${details ? `<p class="context-details">${escapeHtml(details)}</p>` : ""}
                          ${
                            children.length
                              ? `
                                <div class="context-children">
                                  ${children
                                    .map(
                                      (child) => `
                                        <button type="button" class="context-child-chip" data-context-id="${escapeAttr(child.id)}">
                                          <span>${escapeHtml(child.title)}</span>
                                          <span class="tiny">~${estimatePackageTokens(child)} tok</span>
                                        </button>
                                      `
                                    )
                                    .join("")}
                                </div>
                              `
                              : ""
                          }
                          <div class="item-meta">
                            <span>${escapeHtml(pkg.kind)}${pkg.pinned ? " · pin" : ""}${pkg.readOnly ? " · ro" : ""}${pkg.parentId ? " · child" : " · root"}</span>
                            <span>P ${pkg.priority.toFixed(2)} · T ${pkg.turnsLeft} · ${escapeHtml(pkg.status)} · ${children.length} child${children.length === 1 ? "" : "ren"}</span>
                          </div>
                        </article>
                      `;
                    })
                    .join("")
                : `<div class="empty">Select context tiles to inspect or compare them.</div>`
            }
            ${
              contextPackages.length
                ? `
                  <div class="context-package-list" role="list">
                    ${selectedPackages
                      .concat(unselectedPackages)
                      .map(
                        (pkg) => `
                          <button
                            type="button"
                            class="context-package-row ${uiState.selectedContextIds.includes(pkg.id) ? "is-selected" : ""}"
                            style="--row-depth:${getPackageDepth(contextPackages, pkg.id)}"
                            data-context-id="${escapeAttr(pkg.id)}"
                            role="listitem"
                          >
                            <span class="context-package-row-title">${escapeHtml(pkg.title)}</span>
                          </button>
                        `
                      )
                      .join("")}
                  </div>
                `
                : ""
            }
          </div>
        </div>
      </div>

      <div class="background-separator" aria-hidden="true"></div>

      <div class="section compact-section decision-section">
        <div class="section-title">
          <h3>Decision</h3>
          <span class="tiny">${escapeHtml(relativeTime(state.background.lastRunAt))}</span>
        </div>
        <div class="decision-list">
          ${decisionMarkup}
        </div>
      </div>
    </div>
  `;
}

function renderSettingsPanel() {
  const container = document.querySelector("#settings-fields");
  if (!container) return;

  const modelOptions = [
    ...state.availableModels.map(
      (model) => `
        <option value="${escapeAttr(model)}" ${state.config.model === model ? "selected" : ""}>
          ${escapeHtml(model)}
        </option>
      `
    ),
    `<option value="__custom__" ${state.availableModels.includes(state.config.model) ? "" : "selected"}>Other...</option>`
  ].join("");

  const profileOptions = [
    `<option value="">Saved inference</option>`,
    ...state.inferenceProfiles.map(
      (profile) => `
        <option value="${escapeAttr(profile.id)}">${escapeHtml(profile.name)}</option>
      `
    )
  ].join("");

  const sharedPromptOptions = [
    `<option value="">Saved shared prompt</option>`,
    ...state.sharedPromptProfiles.map(
      (profile) => `
        <option value="${escapeAttr(profile.id)}">${escapeHtml(profile.name)}</option>
      `
    )
  ].join("");

  const chatPromptOptions = [
    `<option value="">Saved chat prompt</option>`,
    ...state.chatPromptProfiles.map(
      (profile) => `
        <option value="${escapeAttr(profile.id)}">${escapeHtml(profile.name)}</option>
      `
    )
  ].join("");

  const backgroundPromptOptions = [
    `<option value="">Saved subconscious prompt</option>`,
    ...state.backgroundPromptProfiles.map(
      (profile) => `
        <option value="${escapeAttr(profile.id)}">${escapeHtml(profile.name)}</option>
      `
    )
  ].join("");

  const configProfileOptions = [
    `<option value="">Saved config</option>`,
    ...state.configProfiles.map(
      (profile) => `
        <option value="${escapeAttr(profile.id)}">${escapeHtml(profile.name)}</option>
      `
    )
  ].join("");

  container.innerHTML = `
    <div class="settings-grid">
      <div class="settings-section settings-section-inference">
        <div class="settings-section-title">Inference</div>
        <div class="settings-grid settings-grid-compact">
          <input class="input" name="endpoint" placeholder="Endpoint" value="${escapeAttr(state.config.endpoint)}" />
          <button type="button" class="button secondary" id="refresh-models">Refresh models</button>

          <select class="select" name="modelSelect">${modelOptions}</select>
          <input class="input ${state.availableModels.includes(state.config.model) ? "hidden" : ""}" name="customModel" placeholder="Custom model" value="${escapeAttr(state.config.model)}" />

          <input class="input" name="apiKey" placeholder="API key" value="${escapeAttr(state.config.apiKey)}" />
          <div class="settings-profile-row">
            <select class="select" name="profileSelect">${profileOptions}</select>
            <button type="button" class="button secondary" id="save-profile">${getSaveFeedbackLabel("inference", "Save inference")}</button>
          </div>

          <input class="input" name="maxContextTokens" type="number" min="256" step="256" placeholder="Managed context max" value="${escapeAttr(state.config.maxContextTokens)}" />
          <div class="tiny settings-help">Managed context budget</div>
        </div>
      </div>

      <div class="settings-separator"></div>

      <div class="settings-prompt-stack">
        <label class="settings-label">
          <span class="settings-label-text">Shared system prompt</span>
          <textarea class="input settings-textarea" name="sharedPrompt" placeholder="Describe the assistant's core identity">${escapeHtml(state.config.sharedPrompt)}</textarea>
          <div class="settings-profile-row">
            <select class="select" name="sharedPromptProfileSelect">${sharedPromptOptions}</select>
            <button type="button" class="button secondary" id="save-shared-prompt-profile">${getSaveFeedbackLabel("shared", "Save changes")}</button>
          </div>
        </label>

        <div class="settings-separator"></div>

        <label class="settings-label">
          <span class="settings-label-text">Chat task prompt</span>
          <textarea class="input settings-textarea" name="chatPrompt" placeholder="Instructions for the user-facing chat loop">${escapeHtml(state.config.chatPrompt)}</textarea>
          <div class="settings-profile-row">
            <select class="select" name="chatPromptProfileSelect">${chatPromptOptions}</select>
            <button type="button" class="button secondary" id="save-chat-prompt-profile">${getSaveFeedbackLabel("chat", "Save changes")}</button>
          </div>
        </label>

        <div class="settings-separator"></div>

        <label class="settings-label">
          <span class="settings-label-text">Mental maintenance focus</span>
          <textarea class="input settings-textarea" name="backgroundPrompt" placeholder="Instructions for the background self-maintenance loop">${escapeHtml(state.config.backgroundPrompt)}</textarea>
          <div class="settings-profile-row">
            <select class="select" name="backgroundPromptProfileSelect">${backgroundPromptOptions}</select>
            <button type="button" class="button secondary" id="save-background-prompt-profile">${getSaveFeedbackLabel("background", "Save changes")}</button>
          </div>
        </label>
      </div>
    </div>
  `;

  const topConfigSelect = document.querySelector("#config-profile-select-top");
  if (topConfigSelect) {
    topConfigSelect.innerHTML = configProfileOptions;
  }
}

function renderLiveBits() {
  const backgroundStatus = document.querySelector('[data-bind="backgroundStatus"]');
  const nextRun = document.querySelector('[data-bind="nextRun"]');
  const maxContextTokensInput = document.querySelector('input[name="maxContextTokens"]');
  const cooldownInput = document.querySelector('input[name="cooldownMs"]');
  const backgroundEnabledInput = document.querySelector('input[name="backgroundEnabled"]');
  const loopSlider = document.querySelector("#loop-slider");

  if (backgroundStatus) {
    backgroundStatus.textContent = backgroundStatusLabel(state);
  }
  if (nextRun) {
    nextRun.textContent = nextRunLabel(state);
  }
  if (cooldownInput && document.activeElement !== cooldownInput) {
    cooldownInput.value = String(state.config.cooldownMs);
  }
  if (maxContextTokensInput && document.activeElement !== maxContextTokensInput) {
    maxContextTokensInput.value = String(state.config.maxContextTokens);
  }
  if (backgroundEnabledInput && document.activeElement !== backgroundEnabledInput) {
    backgroundEnabledInput.checked = Boolean(state.config.backgroundEnabled);
  }

  if (loopSlider) {
    if (!state.config.backgroundEnabled) {
      loopSlider.className = "loop-slider is-paused";
    } else if (state.background.status === "thinking") {
      loopSlider.className = "loop-slider is-thinking";
    } else {
      loopSlider.className = "loop-slider is-live";
    }
  }
}

function render() {
  if (!uiInitialized) {
    renderShell();
  }

  renderChatMessages();
  renderBackgroundPanel();
  renderSettingsPanel();
  renderLiveBits();

  const messageInput = document.querySelector('textarea[name="message"]');
  autosizeComposer(messageInput);
}

function autosizeComposer(textarea) {
  if (!textarea) return;
  const singleLineHeight = 20;
  textarea.style.height = "auto";
  const next = Math.max(singleLineHeight, Math.min(textarea.scrollHeight, 220));
  textarea.style.height = `${next}px`;
  textarea.style.overflowY = next >= 220 ? "auto" : "hidden";
}

function readSettingsFromDom() {
  const endpointInput = document.querySelector('input[name="endpoint"]');
  const modelSelect = document.querySelector('select[name="modelSelect"]');
  const customModelInput = document.querySelector('input[name="customModel"]');
  const apiKeyInput = document.querySelector('input[name="apiKey"]');
  const maxContextTokensInput = document.querySelector('input[name="maxContextTokens"]');
  const cooldownInput = document.querySelector('input[name="cooldownMs"]');
  const backgroundEnabledInput = document.querySelector('input[name="backgroundEnabled"]');
  const sharedPromptInput = document.querySelector('textarea[name="sharedPrompt"]');
  const chatPromptInput = document.querySelector('textarea[name="chatPrompt"]');
  const backgroundPromptInput = document.querySelector('textarea[name="backgroundPrompt"]');

  if (endpointInput) {
    state.config.endpoint = String(endpointInput.value || "").trim();
  }

  if (modelSelect) {
    state.config.model =
      modelSelect.value === "__custom__"
        ? String(customModelInput?.value || "").trim()
        : String(modelSelect.value || state.config.model).trim();
  }

  if (apiKeyInput) {
    state.config.apiKey = String(apiKeyInput.value || "").trim();
  }

  if (maxContextTokensInput) {
    const nextMax = Math.max(256, Number(maxContextTokensInput.value || DEFAULT_MANAGED_CONTEXT_BUDGET_TOKENS));
    if (nextMax !== state.config.maxContextTokens) {
      pushSystemNotice(
        state,
        `Managed context budget changed from ${state.config.maxContextTokens} to ${nextMax} tokens. Expand or compact maintained context accordingly.`
      );
      pushActivity(
        state,
        "Managed context budget changed",
        `Adjusted managed context capacity from ${state.config.maxContextTokens} to ${nextMax} tokens.`,
        "config"
      );
    }
    state.config.maxContextTokens = nextMax;
  }

  if (cooldownInput) {
    state.config.cooldownMs = Math.max(0, Number(cooldownInput.value || DEFAULT_COOLDOWN_MS));
  }

  if (backgroundEnabledInput) {
    state.config.backgroundEnabled = Boolean(backgroundEnabledInput.checked);
  }

  if (sharedPromptInput) {
    state.config.sharedPrompt = sharedPromptInput.value;
  }

  if (chatPromptInput) {
    state.config.chatPrompt = chatPromptInput.value;
  }

  if (backgroundPromptInput) {
    state.config.backgroundPrompt = backgroundPromptInput.value;
  }

  state.background.nextDelayMs = state.config.cooldownMs;
}

function scheduleBackgroundLoop() {
  if (backgroundLoopHandle !== null || backgroundCycleInFlight || !state.config.backgroundEnabled) {
    return;
  }

  const delay = Math.max(0, Number(state.background.nextDelayMs ?? state.config.cooldownMs));
  state.background.nextRunAt = new Date(Date.now() + delay).toISOString();
  renderLiveBits();

  backgroundLoopHandle = window.setTimeout(() => {
    backgroundLoopHandle = null;
    void performBackgroundLoop();
  }, delay);
}

function restartBackgroundSchedule() {
  if (backgroundLoopHandle !== null) {
    window.clearTimeout(backgroundLoopHandle);
    backgroundLoopHandle = null;
  }

  state.background.nextDelayMs = state.config.cooldownMs;
  state.background.nextRunAt = state.config.backgroundEnabled
    ? new Date(Date.now() + state.background.nextDelayMs).toISOString()
    : null;

  renderLiveBits();
  scheduleBackgroundLoop();
}

async function performBackgroundLoop() {
  if (backgroundCycleInFlight) return;
  if (!state.config.backgroundEnabled && state.background.status !== "manual") return;

  backgroundCycleInFlight = true;
  state.background.status = "thinking";
  renderLiveBits();

  try {
    const result = await runBackgroundCycle(state);
    if (result.didWork) {
      render();
    } else {
      renderBackgroundPanel();
      renderLiveBits();
    }
  } catch (error) {
    state.background.status = "idle";
    state.background.currentAction = "Background loop failed";
    state.background.lastRunAt = nowIso();
    state.background.nextDelayMs = ERROR_COOLDOWN_MS;
    state.background.nextRunAt = state.config.backgroundEnabled
      ? new Date(Date.now() + ERROR_COOLDOWN_MS).toISOString()
      : null;

    pushDecision(state, "error", error.message, {}, "", "error");
    pushActivity(state, "Background loop failed", error.message, "error");
    saveState(state);
    renderBackgroundPanel();
    renderLiveBits();
  } finally {
    backgroundCycleInFlight = false;
    if (state.background.status !== "thinking") {
      state.background.status = "idle";
    }
    scheduleBackgroundLoop();
  }
}

async function runManualCycle() {
  if (backgroundCycleInFlight) return;

  const previousEnabled = state.config.backgroundEnabled;
  state.background.status = "manual";
  state.background.currentAction = "Manual cycle";
  renderLiveBits();

  try {
    if (!previousEnabled) {
      state.config.backgroundEnabled = true;
    }
    await performBackgroundLoop();
  } finally {
    state.config.backgroundEnabled = previousEnabled;
    state.background.status = "idle";
    state.background.currentAction = previousEnabled ? "Waiting" : "Loop paused";
    if (!previousEnabled && backgroundLoopHandle !== null) {
      window.clearTimeout(backgroundLoopHandle);
      backgroundLoopHandle = null;
      state.background.nextRunAt = null;
    }
    saveState(state);
    renderLiveBits();
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  readSettingsFromDom();

  const form = event.currentTarget;
  const messageInput = form.querySelector('textarea[name="message"]');
  const sendButton = document.querySelector("#send-button");
  const message = String(messageInput?.value || "").trim();
  if (!message) return;

  if (sendButton) {
    sendButton.disabled = true;
    sendButton.textContent = "Thinking...";
  }

  messageInput.value = "";
  autosizeComposer(messageInput);

  try {
    await handleChatTurn(message);
  } catch (error) {
    addChatMessage(
      state,
      "assistant",
      `Model request failed.\n\n${error.message}\n\nCheck the endpoint, model name, and CORS settings on your LMS server.`,
      "reply"
    );
    pushActivity(state, "Model call failed", error.message, "error");
    saveState(state);
  } finally {
    if (sendButton) {
      sendButton.disabled = false;
      sendButton.textContent = "Send";
    }
    render();
    restartBackgroundSchedule();
  }
}

function bindEvents() {
  if (app.dataset.bound === "true") return;
  app.dataset.bound = "true";

  app.addEventListener("submit", async (event) => {
    if (event.target?.id === "chat-form") {
      await handleSubmit(event);
    }
  });

  app.addEventListener("keydown", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) return;
    if (target.name !== "message") return;
    if (event.key !== "Enter") return;
    if (event.shiftKey || event.metaKey) return;
    event.preventDefault();
    target.form?.requestSubmit();
  });

  app.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target instanceof HTMLTextAreaElement && target.name === "message") {
      autosizeComposer(target);
      return;
    }

    if (target instanceof HTMLInputElement && target.name === "cooldownMs") {
      readSettingsFromDom();
      saveState(state);
      restartBackgroundSchedule();
      return;
    }

    if (
      (target instanceof HTMLInputElement && ["endpoint", "apiKey", "customModel"].includes(target.name)) ||
      (target instanceof HTMLSelectElement && [
        "modelSelect",
        "profileSelect",
        "sharedPromptProfileSelect",
        "chatPromptProfileSelect",
        "backgroundPromptProfileSelect",
        "configProfileSelect"
      ].includes(target.name))
    ) {
      readSettingsFromDom();
      saveState(state);
      renderLiveBits();
    }
  });

  app.addEventListener("change", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    if (target instanceof HTMLInputElement && target.name === "backgroundEnabled") {
      readSettingsFromDom();
      state.background.currentAction = state.config.backgroundEnabled ? "Waiting" : "Loop paused";
      saveState(state);
      restartBackgroundSchedule();
      return;
    }

    if (target instanceof HTMLInputElement && target.name === "maxContextTokens") {
      readSettingsFromDom();
      saveState(state);
      renderBackgroundPanel();
      renderLiveBits();
      return;
    }

    if (target instanceof HTMLSelectElement && target.name === "modelSelect") {
      readSettingsFromDom();
      renderSettingsPanel();
      renderLiveBits();
      return;
    }

    if (target instanceof HTMLSelectElement && target.name === "profileSelect") {
      if (!target.value) return;
      applyInferenceProfile(state, target.value);
      renderSettingsPanel();
      try {
        await fetchAvailableModels(state);
      } catch (error) {
        pushActivity(state, "Model refresh failed", error.message, "error");
      }
      renderSettingsPanel();
      renderLiveBits();
      return;
    }

    if (target instanceof HTMLSelectElement && target.name === "sharedPromptProfileSelect") {
      if (!target.value) return;
      applyPromptProfile(state, "shared", target.value);
      renderSettingsPanel();
      return;
    }

    if (target instanceof HTMLSelectElement && target.name === "chatPromptProfileSelect") {
      if (!target.value) return;
      applyPromptProfile(state, "chat", target.value);
      renderSettingsPanel();
      return;
    }

    if (target instanceof HTMLSelectElement && target.name === "backgroundPromptProfileSelect") {
      if (!target.value) return;
      applyPromptProfile(state, "background", target.value);
      renderSettingsPanel();
      return;
    }

    if (target instanceof HTMLSelectElement && target.name === "configProfileSelect") {
      if (!target.value) return;
      applyConfigProfile(state, target.value);
      renderSettingsPanel();
      try {
        await fetchAvailableModels(state);
      } catch (error) {
        pushActivity(state, "Model refresh failed", error.message, "error");
      }
      renderSettingsPanel();
      renderLiveBits();
      return;
    }

  });

  app.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const refreshModelsButton = target.closest("#refresh-models");
    if (refreshModelsButton) {
      readSettingsFromDom();
      try {
        await fetchAvailableModels(state);
      } catch (error) {
        pushActivity(state, "Model refresh failed", error.message, "error");
      }
      renderSettingsPanel();
      renderLiveBits();
      renderBackgroundPanel();
      return;
    }

    const saveProfileButton = target.closest("#save-profile");
    if (saveProfileButton) {
      readSettingsFromDom();
      saveInferenceProfile(state);
      flashSaveFeedback("inference", "Save inference", "Saved");
      return;
    }

    const saveSharedPromptButton = target.closest("#save-shared-prompt-profile");
    if (saveSharedPromptButton) {
      readSettingsFromDom();
      savePromptProfile(state, "shared");
      flashSaveFeedback("shared", "Save changes", "Saved");
      return;
    }

    const saveChatPromptButton = target.closest("#save-chat-prompt-profile");
    if (saveChatPromptButton) {
      readSettingsFromDom();
      savePromptProfile(state, "chat");
      flashSaveFeedback("chat", "Save changes", "Saved");
      return;
    }

    const saveBackgroundPromptButton = target.closest("#save-background-prompt-profile");
    if (saveBackgroundPromptButton) {
      readSettingsFromDom();
      savePromptProfile(state, "background");
      flashSaveFeedback("background", "Save changes", "Saved");
      return;
    }

    const saveConfigButton = target.closest("#save-config-profile");
    if (saveConfigButton) {
      readSettingsFromDom();
      saveConfigProfile(state);
      flashSaveFeedback("config", "Save config", "Saved");
      return;
    }

    const runCycleButton = target.closest("#run-cycle");
    if (runCycleButton) {
      readSettingsFromDom();
      await runManualCycle();
      render();
      return;
    }

    const contextTile = target.closest("[data-context-id]");
    if (contextTile) {
      const contextId = String(contextTile.getAttribute("data-context-id") || "").trim();
      if (!contextId) return;

      if (event.metaKey || event.ctrlKey) {
        if (uiState.selectedContextIds.includes(contextId)) {
          uiState.selectedContextIds = uiState.selectedContextIds.filter((id) => id !== contextId);
        } else {
          uiState.selectedContextIds = [...uiState.selectedContextIds, contextId];
        }
      } else {
        uiState.selectedContextIds = [contextId];
      }

      uiState.backgroundPaneMode = "context";
      renderBackgroundPanel();
      return;
    }

    const resetButton = target.closest("#reset-state-top");
    if (resetButton) {
      state = resetStatePreservingConfig(state);
      uiState.selectedContextIds = [];
      saveState(state);
      render();
      restartBackgroundSchedule();
      return;
    }

    const settingsPopover = document.querySelector("#settings-popover");
    if (settingsPopover && settingsPopover.open) {
      const panel = settingsPopover.querySelector(".settings-popover-panel");
      const isCloseButton = target.closest("#close-settings");
      if (isCloseButton || (panel && !panel.contains(target) && !target.closest("summary"))) {
        readSettingsFromDom();
        saveState(state);
        settingsPopover.open = false;
        return;
      }
    }
  });

  app.addEventListener("toggle", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLDetailsElement)) return;
    if (!target.matches(".decision-item[data-decision-id]")) return;

    const decisionId = String(target.getAttribute("data-decision-id") || "").trim();
    if (!decisionId) return;

    if (target.open) {
      uiState.expandedDecisionIds = [decisionId];
      uiState.backgroundPaneMode = "decision";
    } else {
      uiState.expandedDecisionIds = uiState.expandedDecisionIds.filter((id) => id !== decisionId);
      if (!uiState.expandedDecisionIds.length) {
        uiState.backgroundPaneMode = "context";
      }
    }

    renderBackgroundPanel();
  });
}

window.addEventListener("beforeunload", () => {
  saveState(state);
  if (backgroundLoopHandle !== null) {
    window.clearTimeout(backgroundLoopHandle);
  }
});

function startInferenceAnimationLoop() {
  function tick() {
    requestAnimationFrame(tick);
    
    const ring = document.querySelector('.ring-progress');
    const thumb = document.querySelector('.slider-thumb');
    if (!ring || !thumb) return;
    
    if (!state.config.backgroundEnabled) {
      ring.style.strokeDashoffset = "51";
      thumb.style.setProperty('--glow-opacity', '0');
      return;
    }
    
    if (state.background.status === "thinking") {
      ring.style.strokeDashoffset = "51";
      thumb.style.setProperty('--glow-opacity', '1');
      return;
    }
    
    if (state.background.status === "idle" && state.background.nextRunAt) {
      const now = Date.now();
      const next = new Date(state.background.nextRunAt).getTime();
      const delay = Math.max(0, Number(state.background.nextDelayMs ?? state.config.cooldownMs));
      const start = next - delay;
      
      let progress = 0;
      if (now >= next) {
        progress = 1;
      } else if (now > start && delay > 0) {
        progress = (now - start) / delay;
      }
      
      ring.style.strokeDashoffset = String(51 - (51 * progress));
      
      const glowDurationMs = Math.min(400, delay * 0.4);
      if (now >= next - glowDurationMs && glowDurationMs > 0) {
        const glow = 1 - (next - now) / glowDurationMs;
        thumb.style.setProperty('--glow-opacity', String(Math.max(0, glow)));
      } else {
        thumb.style.setProperty('--glow-opacity', '0');
      }
    } else {
      ring.style.strokeDashoffset = "51";
      thumb.style.setProperty('--glow-opacity', '0');
    }
  }
  requestAnimationFrame(tick);
}

render();
startInferenceAnimationLoop();
void fetchAvailableModels(state)
  .then(() => {
    renderSettingsPanel();
  })
  .catch(() => {});
scheduleBackgroundLoop();
