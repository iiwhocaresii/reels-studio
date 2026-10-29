/* Reels Studio – a click-through control panel on top of GitHub Actions. */
"use strict";

const DEFAULT_TIME = "17:00";
const PREP_LEAD = 35;            // the publish cron starts 35 min before publish time → same-day scheduling closes then
const MAX_DAYS_AHEAD = 88;       // GitHub keeps artifacts for 90 days at most
const STORE_KEY = "pod-reels-panel";
const FILTER_KEY = "pod-reels-short-filter";
const THEME_KEY = "pod-reels-theme";
const PUBLISH_WORKFLOW_PATH = ".github/workflows/publish.yml";
const SECRETS = [
  { name: "YOUTUBE_API_KEY", label: "YouTube Data API key", required: true, hint: "Google Cloud Console → APIs & Services → Credentials → API key." },
  { name: "GRAPH_API_ACCESS_TOKEN", label: "Instagram (Meta) access token", required: true, hint: "System User token from Meta Business Suite (starts with EAA…)." },
  { name: "GRAPH_API_ACCOUNT_ID", label: "Instagram account ID", required: true, hint: "The 17841… number from Graph API Explorer (instagram_business_account.id)." },
  { name: "YTDLP_PROXY", label: "YouTube download proxy (optional, paid)", required: false, hint: "Only if you want YouTube downloads without attaching files: a residential proxy URL, e.g. http://user:pass@host:port. Not needed when you attach videos." },
  { name: "YTDLP_COOKIES", label: "YouTube cookies (optional)", required: false, multiline: true, hint: "Only needed if YouTube blocks downloads (“Sign in to confirm you're not a bot”). Paste the contents of cookies.txt." },
];
const VARIABLES = {
  COVER_MODE: "grid", AI_LABEL: "off", MEDIA_HOST: "resumable", COMMENT_DELAY_SECONDS: "60",
  COMMENT_MODE: "youtube", COMMENT_TEMPLATE: "▶️ Full video on YouTube: {full_video_url}\n🔗 Link in bio",
};
const WORKFLOWS = { prepare: "prepare.yml", publish: "publish.yml", verify: "verify.yml" };
const BROWSER_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
// UI text is English: keep an English browser locale (en-US / en-GB…), otherwise use en-GB.
const UI_LOCALE = /^en\b/i.test(navigator.language || "") ? navigator.language : "en-GB";

/* ------------------------------------------------------------------ utils */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tz = () => S.cfg.tz || BROWSER_TZ;
const pubTime = () => S.cfg.time || DEFAULT_TIME;
const hhmmToMin = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const pubMinutes = () => hhmmToMin(pubTime());
const tzCity = (zone) => zone.split("/").pop().replace(/_/g, " ");
function zoneParts(date, zone) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date)) p[x.type] = x.value;
  return p;
}
const isoInTz = (date) => { const p = zoneParts(date, tz()); return `${p.year}-${p.month}-${p.day}`; };
const todayIso = () => isoInTz(new Date());
const minutesNow = () => { const p = zoneParts(new Date(), tz()); return (Number(p.hour) % 24) * 60 + Number(p.minute); };
const isoToUTC = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (iso, n) => { const d = isoToUTC(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diffDays = (a, b) => Math.round((isoToUTC(b) - isoToUTC(a)) / 86400000);

// Display formatting follows the browser's locale; data stays ISO (YYYY-MM-DD).
const fmtUTC = (iso, opts) => new Intl.DateTimeFormat(UI_LOCALE, { timeZone: "UTC", ...opts }).format(isoToUTC(iso));
const fmtDay = (iso) => fmtUTC(iso, { weekday: "short", day: "numeric", month: "short" });
const fmtDayLong = (iso) => fmtUTC(iso, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtDateTime = (s) => new Intl.DateTimeFormat(UI_LOCALE, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(s));
const fmtTime = (d = new Date()) => new Intl.DateTimeFormat(UI_LOCALE, { hour: "numeric", minute: "2-digit" }).format(d);
const fmtClock = (min) => new Intl.DateTimeFormat(UI_LOCALE, { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(Date.UTC(2000, 0, 1, 0, ((min % 1440) + 1440) % 1440)));
/** "17:00" – plus the time zone when it differs from this computer's. */
const pubLabel = () => fmtClock(pubMinutes()) + (tz() !== BROWSER_TZ ? ` (${tzCity(tz())} time)` : "");
const closeLabel = () => fmtClock(pubMinutes() - PREP_LEAD);
const WEEK_START = (() => {
  try {
    const loc = new Intl.Locale(navigator.language);
    const info = loc.getWeekInfo ? loc.getWeekInfo() : loc.weekInfo;
    return (info?.firstDay ?? 1) % 7; // 0 = Sunday
  } catch { return 1; }
})();

function parseDuration(iso) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "") || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
const fmtDuration = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function extractVideoId(s) {
  if (!s) return null;
  const m = /(?:shorts\/|v=|youtu\.be\/|embed\/)([\w-]{11})/.exec(s);
  if (m) return m[1];
  s = s.trim();
  return /^[\w-]{11}$/.test(s) ? s : null;
}
function normalizeDate(s, createdAt) {
  s = (s || "").trim().replace(/\s/g, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const rel = { today: 0, tomorrow: 1, dnes: 0, "zítra": 1, zitra: 1 }[s.toLowerCase()];
  return rel === undefined ? null : addDays(isoInTz(new Date(createdAt)), rel);
}
function parseRunTitle(run) {
  const m = /📅\s*(.+?)\s*·\s*(.+)$/u.exec(run?.display_title || "");
  return m ? { date: normalizeDate(m[1], run.created_at), videoId: extractVideoId(m[2]) } : null;
}
/** open = can be scheduled; closed = today, too late; past; far = beyond artifact retention. */
function dateStatus(iso) {
  const diff = diffDays(todayIso(), iso);
  if (diff > MAX_DAYS_AHEAD) return "far";
  if (diff * 1440 + pubMinutes() - PREP_LEAD - minutesNow() > 0) return "open";
  return diff < 0 ? "past" : "closed";
}

const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/* >>> schedule-math – pure functions (unit-tested in Node) */
const CRON_LEADS = [35, 15]; // publish cron runs 35 and 15 minutes before the publish time

/** Every UTC offset (minutes, local − UTC) the zone uses during the year. */
function zoneOffsets(zone, year) {
  const out = new Set();
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  for (let month = 0; month < 12; month++) {
    for (const day of [1, 15]) {
      const t = new Date(Date.UTC(year, month, day, 12));
      const p = {};
      for (const x of f.formatToParts(t)) p[x.type] = x.value;
      out.add(Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - t.getTime()) / 60000));
    }
  }
  return [...out];
}
/** UTC cron expressions that start the publish workflow before `time` in `zone`, in every offset of the year. */
function cronLines(time, zone, year = new Date().getUTCFullYear()) {
  const [h, m] = time.split(":").map(Number);
  const local = h * 60 + m;
  const mins = new Set();
  for (const off of zoneOffsets(zone, year)) {
    for (const lead of CRON_LEADS) mins.add((((local - lead - off) % 1440) + 1440) % 1440);
  }
  return [...mins].sort((a, b) => a - b).map((x) => `${x % 60} ${Math.floor(x / 60)} * * *`);
}
/** Rewrites the managed `# >>> publish-schedule … # <<< publish-schedule` block; null if the markers are missing. */
function applyCronBlock(yaml, time, zone) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => l.includes("# >>> publish-schedule"));
  const end = lines.findIndex((l, i) => i > start && l.includes("# <<< publish-schedule"));
  if (start < 0 || end < 0) return null;
  const indent = /^\s*/.exec(lines[start])[0];
  const eol = lines[start].endsWith("\r") ? "\r" : "";
  const block = [
    `${indent}# >>> publish-schedule (managed by Reels Studio: ${time} ${zone})${eol}`,
    ...cronLines(time, zone).map((c) => `${indent}- cron: "${c}"${eol}`),
    lines[end],
  ];
  lines.splice(start, end - start + 1, ...block);
  return lines.join("\n");
}
/* <<< schedule-math */

/* ------------------------------------------------------------------ state */
const S = {
  cfg: {},             // token, repo, ytKey, channel, channelInfo, tz, time
  remember: true,
  repo: null,
  shorts: [],
  shortsError: null,
  shortFilter: (() => { try { return localStorage.getItem(FILTER_KEY) || "todo"; } catch { return "todo"; } })(),
  videos: {},          // videoId → {id,title,thumb,publishedAt,duration}
  artifacts: [],
  prepRuns: [],
  pubRuns: [],
  verifyRuns: [],
  secrets: null,
  variables: null,
  workflows: null,
  days: new Map(),
  view: "planner",
  month: null,         // "YYYY-MM"
  selVideo: null,
  selDate: null,
  replace: false,
  pendingChannel: null,
  busy: false,
  lastSync: null,
  syncError: null,
  pollTimer: null,
};

function loadCfg() {
  for (const [store, remember] of [[() => localStorage, true], [() => sessionStorage, false]]) {
    try {
      const raw = store().getItem(STORE_KEY);
      if (raw) { S.remember = remember; return JSON.parse(raw); }
    } catch { /* storage unavailable */ }
  }
  return {};
}
function saveCfg() {
  try {
    localStorage.removeItem(STORE_KEY);
    sessionStorage.removeItem(STORE_KEY);
    (S.remember ? localStorage : sessionStorage).setItem(STORE_KEY, JSON.stringify(S.cfg));
  } catch { /* works without storage too */ }
}

/* ------------------------------------------------------------------ toasts */
function toast(msg, kind = "info", ms = 5000) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `<div>${{ ok: "✅", err: "⛔", info: "ℹ️" }[kind] || ""}</div><div>${msg}</div>`;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), ms);
}

/* ------------------------------------------------------------------ API */
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function gh(path, { method = "GET", body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${S.cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.message || res.statusText);
  return data;
}
const R = () => `/repos/${S.cfg.repo}`;
function ghErrorText(e) {
  if (e.status === 401) return "Your GitHub token is invalid or has expired. Create a new one and paste it in Settings.";
  if (e.status === 403) return `The token is missing a permission (${esc(e.message)}).`;
  if (e.status === 404) return "Repository or item not found. Check the repository name and the token's access.";
  return esc(e.message || String(e));
}

async function yt(endpoint, params) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries({ ...params, key: S.cfg.ytKey }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `YouTube API ${res.status}`);
  return data;
}
function toVideo(v) {
  const t = v.snippet.thumbnails || {};
  return {
    id: v.id,
    title: v.snippet.title,
    publishedAt: v.snippet.publishedAt,
    duration: parseDuration(v.contentDetails?.duration),
    thumb: (t.maxres || t.standard || t.high || t.medium || t.default || {}).url || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
  };
}
async function loadVideos(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !S.videos[id]);
  if (!missing.length || !S.cfg.ytKey) return;
  for (let i = 0; i < missing.length; i += 50) {
    const data = await yt("videos", { part: "snippet,contentDetails", id: missing.slice(i, i + 50).join(",") });
    data.items.forEach((v) => { S.videos[v.id] = toVideo(v); });
  }
}
async function loadShorts() {
  S.shortsError = null;
  if (!S.cfg.ytKey) { S.shortsError = "nokey"; return; }
  if (!S.cfg.channel) { S.shortsError = "nochannel"; return; }
  const suffix = S.cfg.channel.slice(2);
  try {
    let ids;
    try {
      ids = (await yt("playlistItems", { part: "contentDetails", playlistId: "UUSH" + suffix, maxResults: 30 })).items.map((i) => i.contentDetails.videoId);
    } catch {
      ids = (await yt("playlistItems", { part: "contentDetails", playlistId: "UU" + suffix, maxResults: 50 })).items.map((i) => i.contentDetails.videoId);
    }
    await loadVideos(ids);
    S.shorts = ids.map((id) => S.videos[id]).filter((v) => v && v.duration <= 180);
    if (!S.shorts.length) S.shortsError = "empty";
  } catch (e) {
    S.shortsError = e.message;
  }
}

/* --- YouTube channel lookup: @handle, channel link or UC… ID --- */
function parseChannelInput(s) {
  s = (s || "").trim();
  if (!s) return null;
  let m = /(UC[\w-]{22})/.exec(s);
  if (m) return { id: m[1] };
  m = /youtube\.com\/@([^/?#\s]+)/i.exec(s);
  if (m) return { handle: decodeURIComponent(m[1]) };
  m = /youtube\.com\/user\/([^/?#\s]+)/i.exec(s);
  if (m) return { username: m[1] };
  m = /youtube\.com\/c\/([^/?#\s]+)/i.exec(s);
  if (m) return { handle: m[1] };
  m = /^@?([\w.-]{3,30})$/.exec(s);
  return m ? { handle: m[1] } : null;
}
async function lookupChannel(input) {
  const q = parseChannelInput(input);
  if (!q) throw new Error("That doesn't look like a YouTube channel. Try @handle or a link to the channel.");
  const params = { part: "snippet", ...(q.id ? { id: q.id } : q.username ? { forUsername: q.username } : { forHandle: "@" + q.handle }) };
  const c = (await yt("channels", params)).items?.[0];
  if (!c) throw new Error("No channel found. Check the spelling of the handle or paste the channel link.");
  const t = c.snippet.thumbnails || {};
  return { id: c.id, title: c.snippet.title, handle: c.snippet.customUrl || "", thumb: (t.default || t.medium || {}).url || "" };
}
async function ensureChannelInfo() {
  if (!S.cfg.channel || !S.cfg.ytKey || S.cfg.channelInfo?.id === S.cfg.channel) return;
  try {
    S.cfg.channelInfo = await lookupChannel(S.cfg.channel);
    saveCfg();
    renderBrand();
  } catch { /* the panel works without it */ }
}

/* ------------------------------------------------------------------ data */
async function listArtifacts() {
  const all = [];
  for (let page = 1; page <= 4; page++) {
    const data = await gh(`${R()}/actions/artifacts?per_page=100&page=${page}`);
    all.push(...data.artifacts);
    if (data.artifacts.length < 100) break;
  }
  return all.filter((a) => !a.expired);
}
async function listRuns(file, n) {
  try {
    return (await gh(`${R()}/actions/workflows/${file}/runs?per_page=${n}`)).workflow_runs;
  } catch (e) {
    if (e.status === 404) return []; // workflow not uploaded yet
    throw e;
  }
}

/** history/published.json: the permanent never-publish-twice ledger written by the publish workflow. */
async function loadHistory() {
  try {
    const f = await gh(`${R()}/contents/history/published.json`);
    return JSON.parse(b64ToText(f.content));
  } catch {
    return []; // not created yet (nothing published) or unreadable
  }
}
/** Why a Short can't be scheduled on `iso` (already published / queued elsewhere), or null. */
function duplicateReason(videoId, iso) {
  if (!videoId) return null;
  const done = (S.history || []).find((h) => h.video_id === videoId);
  if (done) return `Already published on Instagram${done.published_on ? ` on ${fmtDayLong(done.published_on)}` : ""}. Each Short is published only once.`;
  const pub = videoDays(videoId).find((d) => d.kind === "published");
  if (pub) return `Already published on Instagram on ${fmtDayLong(pub.iso)}. Each Short is published only once.`;
  const queued = videoDays(videoId).find((d) => ["scheduled", "preparing"].includes(d.kind) && d.iso >= todayIso());
  if (queued) return queued.iso === iso ? "This Short is already scheduled for this day." : `Already scheduled for ${fmtDayLong(queued.iso)}. Cancel it in the Queue first if you want to move it.`;
  return null;
}

function buildDays() {
  const days = new Map();
  const get = (iso) => { if (!days.has(iso)) days.set(iso, {}); return days.get(iso); };
  const runs = new Map(S.prepRuns.map((r) => [r.id, r]));
  const runUrl = (id) => `https://github.com/${S.cfg.repo}/actions/runs/${id}`;

  for (const a of S.artifacts) {
    let m = /^reel-(\d{4}-\d{2}-\d{2})$/.exec(a.name);
    if (m) {
      const d = get(m[1]);
      const q = (d.queue ||= { artifactIds: [], createdAt: "" });
      q.artifactIds.push(a.id);
      if (a.created_at > q.createdAt) {
        const run = runs.get(a.workflow_run?.id);
        Object.assign(q, { createdAt: a.created_at, runId: a.workflow_run?.id, runUrl: runUrl(a.workflow_run?.id), videoId: parseRunTitle(run)?.videoId || null });
      }
      continue;
    }
    m = /^published-(\d{4}-\d{2}-\d{2})-([\w-]{11})$/.exec(a.name);
    if (m) get(m[1]).published = { videoId: m[2], runUrl: runUrl(a.workflow_run?.id), createdAt: a.created_at };
  }
  // The ledger outlives artifacts (90 days) and also lists posts found already on Instagram.
  for (const h of S.history || []) {
    if (!h.published_on || !h.video_id) continue;
    const d = get(h.published_on);
    if (!d.published) d.published = { videoId: h.video_id, runUrl: h.permalink || `https://github.com/${S.cfg.repo}/blob/HEAD/history/published.json`, createdAt: "" };
  }
  const recent = Date.now() - 5 * 86400000;
  for (const run of S.prepRuns) {
    const info = parseRunTitle(run);
    if (!info?.date) continue;
    const d = get(info.date);
    if (run.status !== "completed") {
      if (!d.preparing) d.preparing = { videoId: info.videoId, runId: run.id, runUrl: run.html_url };
    } else if (run.conclusion === "failure" && new Date(run.created_at) > recent && !d.failed) {
      if (!d.queue || d.queue.createdAt < run.created_at) d.failed = { videoId: info.videoId, runUrl: run.html_url, date: info.date };
    }
  }
  for (const run of S.pubRuns) {
    if (run.conclusion === "failure") {
      const d = get(isoInTz(new Date(run.created_at)));
      if (!d.pubFailed) d.pubFailed = { runUrl: run.html_url };
    }
  }
  S.days = days;
}

function dayState(iso) {
  const d = S.days.get(iso);
  if (!d) return null;
  if (d.published) return { kind: "published", label: "Published", videoId: d.published.videoId, url: d.published.runUrl };
  if (d.preparing) return { kind: "preparing", label: "Preparing…", videoId: d.preparing.videoId, url: d.preparing.runUrl };
  if (d.failed) return { kind: "failed", label: "Prep failed", videoId: d.failed.videoId, url: d.failed.runUrl };
  if (d.queue) {
    const past = dateStatus(iso) === "past";
    if (d.pubFailed && (past || iso === todayIso())) return { kind: "failed", label: "Publish failed", videoId: d.queue.videoId, url: d.pubFailed.runUrl };
    if (past) return { kind: "missed", label: "Not published", videoId: d.queue.videoId, url: d.queue.runUrl };
    return { kind: "scheduled", label: "Scheduled", videoId: d.queue.videoId, url: d.queue.runUrl };
  }
  if (d.pubFailed) return { kind: "failed", label: "Publish failed", videoId: null, url: d.pubFailed.runUrl };
  return null;
}
const isOccupied = (iso) => { const s = dayState(iso); return !!s && ["scheduled", "preparing"].includes(s.kind); };
function videoDays(videoId) {
  const out = [];
  for (const iso of S.days.keys()) {
    const st = dayState(iso);
    if (st && st.videoId === videoId) out.push({ iso, ...st });
  }
  return out.sort((a, b) => a.iso.localeCompare(b.iso));
}
const hasActiveRuns = () => [...S.prepRuns, ...S.pubRuns, ...S.verifyRuns].some((r) => r.status !== "completed");

async function refresh({ quiet = false } = {}) {
  if (!S.cfg.token || !S.cfg.repo || S.busy) return;
  S.busy = true;
  setSync("busy", "Syncing…");
  try {
    const [repo, artifacts, prepRuns, pubRuns, verifyRuns, history] = await Promise.all([
      S.repo ? Promise.resolve(S.repo) : gh(R()),
      listArtifacts(),
      listRuns(WORKFLOWS.prepare, 40),
      listRuns(WORKFLOWS.publish, 30),
      listRuns(WORKFLOWS.verify, 5),
      loadHistory(),
    ]);
    // Keep "just scheduled" placeholders until the real run shows up (max. 5 minutes).
    S.optimistic = (S.optimistic || []).filter((o) => Date.now() + o.id < 300000
      && !prepRuns.some((r) => r.display_title === o.display_title && Date.parse(r.created_at) >= -o.id - 120000));
    prepRuns.unshift(...S.optimistic);
    Object.assign(S, { repo, artifacts, prepRuns, pubRuns, verifyRuns, history, syncError: null, lastSync: new Date() });
    await updateVerifyOk();
    buildDays();
    const ids = [];
    S.days.forEach((d) => [d.queue, d.published, d.preparing, d.failed].forEach((x) => x?.videoId && ids.push(x.videoId)));
    await loadVideos(ids).catch(() => {});
    setSync("ok", `Updated ${fmtTime(S.lastSync)}`);
  } catch (e) {
    S.syncError = e;
    setSync("err", "Sync error");
    if (!quiet) toast(ghErrorText(e), "err", 8000);
  } finally {
    S.busy = false;
  }
  renderData();
  schedulePoll();
}
function schedulePoll() {
  clearTimeout(S.pollTimer);
  S.pollTimer = setTimeout(() => refresh({ quiet: true }), hasActiveRuns() ? 8000 : 60000);
}
function setSync(kind, text) {
  $("#sync-dot").className = `dot ${kind}`;
  $("#sync-text").textContent = text;
}

async function loadSettingsData() {
  const [secrets, variables, workflows] = await Promise.all([
    gh(`${R()}/actions/secrets?per_page=100`).then((d) => d.secrets).catch((e) => ({ error: e })),
    gh(`${R()}/actions/variables?per_page=100`).then((d) => d.variables).catch((e) => ({ error: e })),
    gh(`${R()}/actions/workflows`).then((d) => d.workflows).catch((e) => ({ error: e })),
  ]);
  Object.assign(S, { secrets, variables, workflows });
  syncScheduleFromVars();
}
const repoVar = (name) => (Array.isArray(S.variables) ? S.variables.find((v) => v.name === name)?.value?.trim() : undefined);
/** Repository variables are the source of truth for channel, time zone and publish time. */
function syncScheduleFromVars() {
  if (!Array.isArray(S.variables)) return;
  const next = { channel: repoVar("YOUTUBE_CHANNEL_ID") || "", tz: repoVar("TIMEZONE") || "", time: repoVar("PUBLISH_TIME") || "" };
  const channelChanged = next.channel !== (S.cfg.channel || "");
  if (!channelChanged && next.tz === (S.cfg.tz || "") && next.time === (S.cfg.time || "")) return;
  Object.assign(S.cfg, next);
  saveCfg();
  if (channelChanged) {
    S.shorts = [];
    loadShorts().then(renderData);
    ensureChannelInfo();
  }
  renderBrand();
  renderData();
}

/* --- setup checklist (onboarding) --- */
function setupSteps() {
  const wfNames = Array.isArray(S.workflows) ? S.workflows.map((w) => w.path.split("/").pop()) : null;
  const missingSecrets = Array.isArray(S.secrets) ? SECRETS.filter((s) => s.required && !S.secrets.some((x) => x.name === s.name)) : null;
  return [
    { key: "upload", label: "Upload the project", target: "card-project", known: !!wfNames, done: !!wfNames && Object.values(WORKFLOWS).every((f) => wfNames.includes(f)) },
    { key: "keys", label: "Add your API keys", target: "card-secrets", known: !!missingSecrets, done: !!missingSecrets && !missingSecrets.length, detail: missingSecrets?.map((s) => s.label).join(", ") },
    { key: "channel", label: "Pick channel & publish time", target: "card-schedule", known: Array.isArray(S.variables), done: !!repoVar("YOUTUBE_CHANNEL_ID") && !!repoVar("TIMEZONE") },
    { key: "test", label: "Run the access test", target: "card-verify", known: true, done: !!S.verifyOk || S.verifyRuns.some((r) => r.conclusion === "success") },
  ];
}

/* ------------------------------------------------------------------ render: shell */
function renderBrand() {
  $("#brand-sub").textContent = S.cfg.channelInfo?.title || "Shorts → Reels";
}
function showView(view, scrollTo) {
  S.view = view;
  const connected = !!(S.cfg.token && S.cfg.repo);
  $("#nav").hidden = $("#sync").hidden = $("#btn-refresh").hidden = !connected;
  $("#view-welcome").hidden = connected;
  for (const v of ["planner", "queue", "history", "settings"]) $(`#view-${v}`).hidden = !connected || v !== view;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (connected && view === "settings") renderSettings();
  renderData();
  if (scrollTo) setTimeout(() => scrollToCard(scrollTo), 60);
}
function scrollToCard(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}
function renderData() {
  if (!(S.cfg.token && S.cfg.repo)) return;
  const upcoming = upcomingItems();
  $("#queue-count").hidden = !upcoming.length;
  $("#queue-count").textContent = upcoming.length;
  document.querySelectorAll("[data-pubtime]").forEach((el) => { el.textContent = pubLabel(); });
  if (S.view === "planner") { renderSetupBanner(); renderCalendar(); renderShorts(); }
  if (S.view === "queue") renderQueue();
  if (S.view === "history") renderHistory();
  if (S.view === "settings") renderChecklist();
  renderActionBar();
}

const videoThumb = (id) => S.videos[id]?.thumb || (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "");
const videoTitle = (id) => S.videos[id]?.title || (id ? `Short ${id}` : "Latest Short (at prep time)");

/* ------------------------------------------------------------------ render: planner */
function renderSetupBanner() {
  const el = $("#setup-banner");
  const next = S.syncError ? null : setupSteps().find((s) => s.known && !s.done);
  el.innerHTML = next
    ? `<div class="setup-banner"><span class="pill">Setup</span><div class="t"><b>Almost there.</b> Next step: ${esc(next.label)}${next.detail ? ` <span class="muted">(${esc(next.detail)})</span>` : ""}.</div><button class="btn sm" data-goto="settings" data-scroll="${next.target}">Continue setup →</button></div>`
    : "";
}

function renderCalendar() {
  const today = todayIso();
  if (!S.month) S.month = today.slice(0, 7);
  const [y, m] = S.month.split("-").map(Number);
  $("#cal-title").textContent = fmtUTC(`${S.month}-01`, { month: "long", year: "numeric" });
  $("#cal-weekdays").innerHTML = Array.from({ length: 7 }, (_, i) => `<div>${fmtUTC(`2023-01-0${1 + ((WEEK_START + i) % 7)}`, { weekday: "short" })}</div>`).join("");
  const first = new Date(Date.UTC(y, m - 1, 1));
  const offset = (first.getUTCDay() - WEEK_START + 7) % 7;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(`<div class="day outside"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${S.month}-${String(day).padStart(2, "0")}`;
    const status = dateStatus(iso);
    const st = dayState(iso);
    const cls = ["day", status, iso === today ? "today" : "", iso === S.selDate ? "selected" : "", st ? "has-item" : ""].join(" ");
    const selectable = status === "open" || !!st;
    const title = st ? `${fmtDayLong(iso)}: ${st.label} – ${videoTitle(st.videoId)}` : status === "open" ? `${fmtDayLong(iso)} – click to select` : fmtDayLong(iso);
    cells.push(`
      <button class="${cls}" data-date="${iso}" ${selectable ? "" : "disabled"} title="${esc(title)}">
        ${st && st.videoId ? `<img class="day-thumb" src="${esc(videoThumb(st.videoId))}" alt="" loading="lazy">` : ""}
        <span class="day-num">${day}</span>
        ${st ? `<span class="day-status"><span class="chip ${st.kind}">${st.kind === "preparing" ? '<i class="spin"></i>' : ""}${esc(st.label)}</span></span>` : status === "open" ? `<span class="day-plus">+</span>` : ""}
      </button>`);
  }
  $("#cal-grid").innerHTML = cells.join("");
}

const SHORT_FILTERS = [["todo", "To do"], ["scheduled", "Scheduled"], ["published", "Published"], ["all", "All"]];
/** "published" | "scheduled" | "todo" (never used, or a failed/missed day). */
function shortStatus(videoId) {
  if ((S.history || []).some((h) => h.video_id === videoId)) return "published";
  const days = videoDays(videoId);
  if (days.some((d) => d.kind === "published")) return "published";
  if (days.some((d) => ["scheduled", "preparing"].includes(d.kind) && d.iso >= todayIso())) return "scheduled";
  return "todo";
}
function renderShortFilter(counts) {
  $("#short-filter").innerHTML = counts ? SHORT_FILTERS.map(([key, label]) =>
    `<button class="${key === S.shortFilter ? "active" : ""}" data-short-filter="${key}">${label}<span class="count">${counts[key]}</span></button>`).join("") : "";
}
function emptyShorts(icon, html) {
  return `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">${icon}</div>${html}</div>`;
}
function renderShorts() {
  const el = $("#shorts-list");
  const info = S.cfg.channelInfo;
  $("#shorts-channel").innerHTML = info && info.id === S.cfg.channel
    ? `${info.thumb ? `<img src="${esc(info.thumb)}" alt="">` : ""}<span>${esc(info.title)}</span>`
    : "";
  renderShortFilter(null);
  if (S.shortsError === "nokey") {
    el.innerHTML = emptyShorts("🔑", `Add your YouTube API key in <a href="#" data-goto="settings" data-scroll="card-connection">Settings</a> to see your Shorts here.<br><span class="small">You can also paste a Short link above.</span>`);
    return;
  }
  if (S.shortsError === "nochannel") {
    el.innerHTML = emptyShorts("📺", `Which channel are we posting from?<br><button class="btn primary sm" style="margin-top:12px" data-goto="settings" data-scroll="card-schedule">Pick your channel</button><br><span class="small">You can also paste a Short link above.</span>`);
    return;
  }
  if (S.shortsError === "empty") {
    el.innerHTML = emptyShorts("🫙", `No Shorts found on this channel yet.<br><span class="small">Paste a Short link above, or check the channel in Settings.</span>`);
    return;
  }
  if (S.shortsError) {
    el.innerHTML = emptyShorts("⚠️", `Couldn't load your Shorts:<br><span class="small">${esc(S.shortsError)}</span>`);
    return;
  }
  if (!S.shorts.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><span class="spin"></span> Loading Shorts…</div>`;
    return;
  }
  const status = new Map(S.shorts.map((v) => [v.id, shortStatus(v.id)]));
  const counts = { todo: 0, scheduled: 0, published: 0, all: S.shorts.length };
  for (const s of status.values()) counts[s]++;
  renderShortFilter(counts);
  // The selected Short always stays visible, whatever the filter.
  const list = S.shorts.filter((v) => S.shortFilter === "all" || status.get(v.id) === S.shortFilter || v.id === S.selVideo);
  if (S.selVideo && !list.some((v) => v.id === S.selVideo)) list.unshift(S.videos[S.selVideo] || { id: S.selVideo, title: `Short ${S.selVideo}`, duration: 0, thumb: videoThumb(S.selVideo) });
  if (!list.length) {
    el.innerHTML = emptyShorts(S.shortFilter === "todo" ? "🎉" : "🫙", {
      todo: "Every Short is scheduled or published.<br><span class=\"small\">New Shorts show up here after you post them on YouTube.</span>",
      scheduled: "Nothing scheduled right now.<br><span class=\"small\">Pick a Short under <b>To do</b> and a day in the calendar.</span>",
      published: "Nothing published to Instagram yet.",
    }[S.shortFilter]);
    return;
  }
  el.innerHTML = list.map((v) => {
    const badges = videoDays(v.id).filter((d) => d.kind !== "failed").map((d) => `<span class="chip">${d.kind === "published" ? "✓ " : ""}${esc(fmtDay(d.iso))}</span>`).join("")
      + (S.local?.[v.id] ? `<span class="chip" title="The video file is on this computer (Downloads\Shorts)">💾</span>` : "");
    return `
      <button class="short ${v.id === S.selVideo ? "selected" : ""}" data-video="${esc(v.id)}" title="${esc(v.title)}">
        <div class="short-thumb">
          <img src="${esc(v.thumb)}" alt="" loading="lazy">
          <div class="short-badges">${badges}</div>
          <div class="short-check">✓</div>
          ${v.duration ? `<span class="short-dur">${fmtDuration(v.duration)}</span>` : ""}
        </div>
        <div class="short-title">${esc(v.title)}</div>
        ${v.publishedAt ? `<div class="short-meta">${fmtDateTime(v.publishedAt)}</div>` : ""}
      </button>`;
  }).join("");
}

/* ---- Desktop app (tools/studio.py): download Shorts, attach their files, open the folder ---- */
const IN_APP = location.protocol.startsWith("http");
async function appApi(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Reels Studio app: HTTP ${res.status}`);
  return res.json();
}
/** One-time hand-over from the old file:// panel (panel/to-app.html → #import=…). */
function importHandoff() {
  if (!IN_APP || !location.hash.startsWith("#import=")) return;
  try {
    const data = JSON.parse(b64ToText(decodeURIComponent(location.hash.slice(8))));
    if (data?.cfg?.token && !S.cfg.token) { S.cfg = data.cfg; S.remember = data.remember !== false; saveCfg(); }
  } catch { /* ignore a broken hand-over */ }
  history.replaceState(null, "", location.pathname);
}
async function initLocalApp() {
  if (!IN_APP) return;
  try { S.app = await appApi("/api/ping"); } catch { S.app = null; return; }
  $("#btn-dl-shorts").hidden = false;
  await refreshLocal();
  // Fetch new Shorts in the background on every start (needs the channel from Settings).
  for (let i = 0; i < 20 && !appChannel(); i++) await new Promise((r) => setTimeout(r, 500));
  if (appChannel()) downloadShorts({ quiet: true });
}
const appChannel = () => repoVar("YOUTUBE_CHANNEL_ID") || S.cfg.channel || "";
async function refreshLocal() {
  try { S.local = await appApi("/api/shorts"); } catch { S.local = {}; }
  renderShorts();
  renderActionBar();
}
async function downloadShorts({ quiet = false } = {}) {
  const channel = appChannel();
  if (!channel) { if (!quiet) toast("Pick your channel in Settings first.", "info"); return; }
  try { await appApi("/api/download", { channel }); } catch (e) { toast(esc(e.message), "err"); return; }
  pollDownload(quiet);
}
async function pollDownload(quiet) {
  const st = await appApi("/api/download").catch(() => null);
  const el = $("#dl-status"), btn = $("#btn-dl-shorts");
  if (st?.running) {
    el.hidden = false;
    el.textContent = st.log?.at(-1) || "Downloading your Shorts…";
    btn.disabled = true;
    setTimeout(() => pollDownload(quiet), 1500);
    return;
  }
  btn.disabled = false;
  el.hidden = true;
  if (st?.error) toast(`Downloading your Shorts failed: ${esc(st.error)}`, "err", 9000);
  else if (st?.downloaded?.length) toast(`Downloaded ${st.downloaded.length} new Short${st.downloaded.length > 1 ? "s" : ""} to your Shorts folder.`, "ok");
  else if (!quiet) toast("All your Shorts are already downloaded.", "ok");
  await refreshLocal();
  if (S.selVideo && !S.videoFile) attachLocal(S.selVideo);
}
async function attachLocal(videoId) {
  if (!videoId || !S.local?.[videoId]) return false;
  const res = await fetch(`/api/shorts/${encodeURIComponent(videoId)}`).catch(() => null);
  if (!res?.ok) return false;
  const blob = await res.blob();
  if (S.selVideo !== videoId) return false;
  S.videoFile = new File([blob], S.local[videoId].name, { type: blob.type || "video/mp4" });
  renderActionBar();
  return true;
}
const openInFolder = (videoId) => appApi("/api/open-folder", { id: videoId || "" }).catch((e) => toast(esc(e.message), "err"));

/* ---- Shorts folder: the panel remembers it and finds "…[videoId].mp4" by itself ---- */
const FS_OK = "showDirectoryPicker" in window;
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("reels-studio", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const req = fn(tx.objectStore("handles"));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const getShortsDir = () => idb("readonly", (st) => st.get("shortsDir")).catch(() => null);
const saveShortsDir = (h) => idb("readwrite", (st) => st.put(h, "shortsDir")).catch(() => {});
async function findInShortsDir(dir, videoId) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === "file" && name.includes(`[${videoId}]`) && /\.(mp4|mov|m4v)$/i.test(name)) return h.getFile();
  }
  return null;
}
/** Silent attempt when a Short is selected: only if the folder is known and already allowed. */
async function autoAttach(videoId) {
  if (S.app) { await attachLocal(videoId); return; }
  if (!FS_OK || !videoId) return;
  const dir = await getShortsDir();
  if (!dir || (await dir.queryPermission({ mode: "read" })) !== "granted") return;
  const file = await findInShortsDir(dir, videoId).catch(() => null);
  if (file && S.selVideo === videoId && !S.videoFile) { S.videoFile = file; renderActionBar(); }
}
/** "📂 From Shorts folder" button: pick/allow the folder once, then attach the Short's file. */
async function attachFromFolder() {
  const videoId = S.selVideo;
  try {
    let dir = await getShortsDir();
    if (dir && (await dir.requestPermission({ mode: "read" })) !== "granted") dir = null;
    if (!dir) {
      toast("Pick your <b>Shorts</b> folder (Downloads → Shorts). The panel remembers it.", "info", 6000);
      dir = await window.showDirectoryPicker({ id: "shorts", startIn: "downloads", mode: "read" });
      await saveShortsDir(dir);
    }
    const file = await findInShortsDir(dir, videoId);
    if (file) {
      S.videoFile = file;
      renderActionBar();
      return;
    }
    toast(`This Short isn't in the <b>${esc(dir.name)}</b> folder yet. Double-click <b>Download Shorts</b> on your desktop, or pick the file.`, "info", 8000);
    const [h] = await window.showOpenFilePicker({ id: "shorts", startIn: dir, types: [{ description: "Video", accept: { "video/*": [".mp4", ".mov", ".m4v"] } }] });
    S.videoFile = await h.getFile();
    renderActionBar();
  } catch (e) {
    if (e?.name !== "AbortError") toast(ghErrorText(e), "err", 8000);
  }
}

function renderActionBar() {
  const bar = $("#action-bar");
  const show = S.view === "planner" && (S.selVideo || S.selDate);
  bar.classList.toggle("show", !!show);
  if (!show) return;
  const st = S.selDate ? dayState(S.selDate) : null;
  const occupied = S.selDate && isOccupied(S.selDate);
  const status = S.selDate ? dateStatus(S.selDate) : null;
  const dup = duplicateReason(S.selVideo, S.selDate);
  const canSchedule = S.selVideo && S.selDate && status === "open" && (!occupied || S.replace) && st?.kind !== "preparing" && !dup;

  let sub;
  if (!S.selVideo) sub = "Now pick a <b>Short</b> from the list.";
  else if (!S.selDate) sub = "Now pick a <b>day</b> in the calendar.";
  else sub = `Goes live <b>${esc(fmtDayLong(S.selDate))} at ${esc(pubLabel())}</b>`;

  let warn = "";
  if (dup) warn = esc(dup);
  else if (S.selDate && st && st.kind === "published") warn = `“${esc(videoTitle(st.videoId))}” was already published on this day.`;
  else if (S.selDate && st?.kind === "preparing") warn = "Another Reel is being prepared for this day – wait until it's done.";
  else if (S.selDate && status !== "open" && !st) warn = status === "closed" ? `Too late for this day (scheduling closes at ${esc(closeLabel())}).` : "This day can't be selected.";

  bar.innerHTML = `
    ${S.selVideo ? `<img class="ab-thumb" src="${esc(videoThumb(S.selVideo))}" alt="">` : `<div class="ab-thumb"></div>`}
    <div class="ab-text">
      <div class="ab-title">${S.selVideo ? esc(videoTitle(S.selVideo)) : "No Short selected"}</div>
      <div class="ab-sub">${sub}</div>
      ${warn ? `<div class="ab-warn">${warn}</div>` : ""}
      ${S.selVideo && S.selDate && !dup ? `<div class="ab-opts">
        ${S.app
          ? (S.local?.[S.selVideo] ? `<button class="btn sm" id="ab-show">📂 Show in folder</button>` : `<button class="btn sm primary" id="ab-dl">⬇️ Download my Shorts</button>`)
          : (FS_OK && !S.videoFile ? `<button class="btn sm primary" id="ab-folder">📂 From Shorts folder</button>` : "")}
        <label class="btn sm ab-file ${S.videoFile ? "primary" : ""}">📎 ${S.videoFile ? `${esc(S.videoFile.name)} · ${(S.videoFile.size / 1048576).toFixed(1)} MB` : "Other file…"}<input type="file" id="ab-file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" hidden></label>
        <label class="check"><input type="checkbox" id="ab-ai" ${aiLabelOn() ? "checked" : ""}> Instagram “AI info” label</label>
      </div>
      ${S.videoFile ? "" : `<div class="ab-hint">${S.app && !S.local?.[S.selVideo] ? "This Short isn't on your computer yet: click Download my Shorts." : "Attach the video file: YouTube blocks downloads from GitHub's servers, so without a file scheduling may fail."}</div>`}` : ""}
      ${occupied && st?.kind === "scheduled" && status === "open" ? `<label class="check ab-warn"><input type="checkbox" id="ab-replace" ${S.replace ? "checked" : ""}> Replace “${esc(videoTitle(st.videoId))}”, which is already scheduled for this day</label>` : ""}
    </div>
    ${S.selVideo && !(S.history || []).some((h) => h.video_id === S.selVideo) ? `<button class="btn ghost sm" id="ab-mark" title="Posted this Short to Instagram yourself? Mark it so it's never scheduled.">Already on Instagram?</button>` : ""}
    <button class="btn ghost sm" id="ab-clear">Clear</button>
    <button class="btn primary lg" id="ab-schedule" ${canSchedule ? "" : "disabled"}>${occupied ? "Replace & schedule" : `Schedule for ${esc(fmtClock(pubMinutes()))}`}</button>`;
}

/** Adds a Short posted by hand to history/published.json, so it is never scheduled or published. */
async function markPublished(videoId) {
  if (!videoId || !confirm(`Mark “${videoTitle(videoId)}” as already posted on Instagram?\nIt can't be scheduled after that.`)) return;
  const path = `${R()}/contents/history/published.json`;
  let sha, list = [];
  try {
    const f = await gh(path);
    sha = f.sha;
    list = JSON.parse(b64ToText(f.content));
  } catch (e) {
    if (e.status !== 404) { toast(ghErrorText(e), "err", 8000); return; }
  }
  if (!list.some((h) => h.video_id === videoId)) {
    list.push({ video_id: videoId, title: videoTitle(videoId), published_on: todayIso(), note: "marked in Reels Studio (posted manually)" });
    try {
      await gh(path, { method: "PUT", body: { message: `Mark ${videoId} as published (Reels Studio)`, content: textToB64(JSON.stringify(list, null, 2) + "\n"), ...(sha ? { sha } : {}) } });
    } catch (e) { toast(ghErrorText(e), "err", 8000); return; }
  }
  S.history = list;
  S.selDate = S.selVideo = null;
  buildDays();
  renderData();
  toast(`Marked as published. “${esc(videoTitle(videoId))}” will never be scheduled.`, "ok", 6000);
}

/** AI label for the Reel being scheduled: the per-Reel choice, else the AI_LABEL default from Settings. */
const aiLabelOn = () => (S.aiLabel ?? (repoVar("AI_LABEL") || VARIABLES.AI_LABEL)) === "on";

const MAX_UPLOAD_BYTES = 95 * 1048576; // GitHub's blob API limit is 100 MB
const fileToB64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1]);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});
/** Puts the attached video on a temporary branch (one file, no history); the prepare workflow takes it from there and deletes the branch. */
async function uploadVideoBranch(file, date, video) {
  const blob = await gh(`${R()}/git/blobs`, { method: "POST", body: { content: await fileToB64(file), encoding: "base64" } });
  const ext = (/\.(mp4|mov|m4v)$/i.exec(file.name)?.[1] || "mp4").toLowerCase();
  const tree = await gh(`${R()}/git/trees`, { method: "POST", body: { tree: [{ path: `video.${ext}`, mode: "100644", type: "blob", sha: blob.sha }] } });
  const commit = await gh(`${R()}/git/commits`, { method: "POST", body: { message: `Video for ${date} (${video})`, tree: tree.sha, parents: [] } });
  const branch = `upload/${date}-${video}-${Date.now()}`;
  await gh(`${R()}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  return branch;
}

async function schedule() {
  const date = S.selDate, video = S.selVideo, replace = S.replace, ai = aiLabelOn() ? "on" : "off", file = S.videoFile;
  const btn = $("#ab-schedule");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${file ? "Uploading video…" : "Sending…"}`;
  try {
    const upload = file ? await uploadVideoBranch(file, date, video) : "";
    btn.innerHTML = `<span class="spin"></span> Sending…`;
    await gh(`${R()}/actions/workflows/${WORKFLOWS.prepare}/dispatches`, {
      method: "POST",
      body: { ref: S.repo?.default_branch || "main", inputs: { publish_date: date, video_id: video, replace: replace ? "true" : "false", ai_label: ai, video_upload: upload } },
    });
    toast(`Scheduled for <b>${esc(fmtDayLong(date))} at ${esc(pubLabel())}</b>. Preparing the video in the cloud takes about 1–3 minutes.`, "ok", 7000);
    S.selDate = null; S.selVideo = null; S.replace = false; S.aiLabel = null; S.videoFile = null;
    // Instant feedback in the calendar; kept until GitHub lists the real run (that can take a while).
    const pending = { id: -Date.now(), status: "queued", display_title: `📅 ${date} · ${video}`, created_at: new Date().toISOString(), html_url: `https://github.com/${S.cfg.repo}/actions` };
    S.optimistic = [...(S.optimistic || []), pending];
    S.prepRuns.unshift(pending);
    buildDays();
    renderData();
    setTimeout(() => refresh({ quiet: true }), 4000);
  } catch (e) {
    toast(e.status === 404 ? "The scheduling workflow wasn't found. Upload the project in Settings first." : ghErrorText(e), "err", 9000);
    renderActionBar();
  }
}

/* ------------------------------------------------------------------ render: queue */
function upcomingItems() {
  const today = todayIso();
  return [...S.days.keys()]
    .filter((iso) => iso >= today)
    .map((iso) => ({ iso, st: dayState(iso) }))
    .filter((x) => x.st && x.st.kind !== "published")
    .sort((a, b) => a.iso.localeCompare(b.iso));
}
function dateBadge(iso) {
  return `<div class="row-date"><div class="wd">${esc(fmtUTC(iso, { weekday: "short" }))}</div><div class="d">${isoToUTC(iso).getUTCDate()}</div><div class="m">${esc(fmtUTC(iso, { month: "short" }))}</div></div>`;
}
function renderQueue() {
  const items = upcomingItems();
  if (!items.length) {
    $("#queue-list").innerHTML = `<div class="card empty"><div class="empty-icon">🗓️</div>The queue is empty.<br><button class="btn primary" style="margin-top:14px" data-goto="planner">Schedule a Reel</button></div>`;
    return;
  }
  const rtf = new Intl.RelativeTimeFormat(UI_LOCALE, { numeric: "auto" });
  $("#queue-list").innerHTML = items.map(({ iso, st }) => {
    const when = rtf.format(diffDays(todayIso(), iso), "day");
    const ytLink = st.videoId ? `<a href="https://www.youtube.com/shorts/${esc(st.videoId)}" target="_blank" rel="noopener">YouTube ↗</a>` : "";
    const canCancel = ["scheduled", "preparing", "failed"].includes(st.kind);
    return `
      <div class="row">
        ${dateBadge(iso)}
        ${st.videoId ? `<img class="row-thumb" src="${esc(videoThumb(st.videoId))}" alt="">` : `<div class="row-thumb"></div>`}
        <div class="row-main">
          <div class="row-title">${esc(videoTitle(st.videoId))}</div>
          <div class="row-meta">
            <span class="chip ${st.kind}">${st.kind === "preparing" ? '<i class="spin"></i>' : ""}${esc(st.label)}</span>
            <span>${esc(fmtDayLong(iso))} at ${esc(pubLabel())} · ${esc(when)}</span>
            ${ytLink}
            <a href="${esc(st.url)}" target="_blank" rel="noopener">Details ↗</a>
          </div>
        </div>
        <div class="row-actions">
          ${st.kind === "failed" && st.videoId && dateStatus(iso) === "open" ? `<button class="btn sm" data-retry="${iso}" data-video="${esc(st.videoId)}">Try again</button>` : ""}
          ${canCancel ? `<button class="btn sm danger" data-cancel="${iso}">Cancel</button>` : ""}
        </div>
      </div>`;
  }).join("");
}

async function cancelDay(iso) {
  if (!confirm(`Cancel the Reel scheduled for ${fmtDayLong(iso)}?`)) return;
  const d = S.days.get(iso) || {};
  try {
    for (const id of d.queue?.artifactIds || []) await gh(`${R()}/actions/artifacts/${id}`, { method: "DELETE" });
    for (const run of S.prepRuns) {
      if (run.id > 0 && run.status !== "completed" && parseRunTitle(run)?.date === iso) {
        await gh(`${R()}/actions/runs/${run.id}/cancel`, { method: "POST" }).catch(() => {});
      }
    }
    toast(`The Reel for ${esc(fmtDayLong(iso))} was cancelled.`, "ok");
    S.artifacts = S.artifacts.filter((a) => a.name !== `reel-${iso}`);
    buildDays();
    renderData();
    setTimeout(() => refresh({ quiet: true }), 3000);
  } catch (e) {
    toast(ghErrorText(e), "err", 8000);
  }
}

/* ------------------------------------------------------------------ render: history */
function renderHistory() {
  const published = [...S.days.entries()].filter(([, d]) => d.published).sort((a, b) => b[0].localeCompare(a[0]));
  $("#history-list").innerHTML = published.length
    ? published.map(([iso, d]) => `
        <div class="row">
          ${dateBadge(iso)}
          <img class="row-thumb" src="${esc(videoThumb(d.published.videoId))}" alt="">
          <div class="row-main">
            <div class="row-title">${esc(videoTitle(d.published.videoId))}</div>
            <div class="row-meta">
              <span class="chip published">✓ Published</span>
              <span>${esc(fmtDayLong(iso))}</span>
              <a href="https://www.youtube.com/shorts/${esc(d.published.videoId)}" target="_blank" rel="noopener">YouTube ↗</a>
              <a href="${esc(d.published.runUrl)}" target="_blank" rel="noopener">Reel link & details ↗</a>
            </div>
          </div>
        </div>`).join("")
    : `<div class="card empty"><div class="empty-icon">📭</div>Nothing published yet.</div>`;

  const publishedRunIds = new Set(S.artifacts.filter((a) => a.name.startsWith("published-")).map((a) => a.workflow_run?.id));
  const rows = [
    ...S.prepRuns.filter((r) => r.id > 0).map((r) => ({ r, what: "Prep", title: describePrep(r) })),
    ...S.pubRuns.filter((r) => publishedRunIds.has(r.id) || r.conclusion === "failure" || r.status !== "completed").map((r) => ({ r, what: "Publish", title: publishedRunIds.has(r.id) ? "Reel published" : "Queue check / publish" })),
    ...S.verifyRuns.map((r) => ({ r, what: "Access test", title: "Setup check" })),
  ].sort((a, b) => b.r.created_at.localeCompare(a.r.created_at)).slice(0, 25);

  $("#runs-table").innerHTML = rows.length
    ? `<thead><tr><th>When</th><th>Type</th><th>Description</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(({ r, what, title }) => `
        <tr>
          <td class="muted">${fmtDateTime(r.created_at)}</td>
          <td>${what}</td>
          <td>${esc(title)}</td>
          <td>${runChip(r)}</td>
          <td><a href="${esc(r.html_url)}" target="_blank" rel="noopener">Log ↗</a></td>
        </tr>`).join("")}</tbody>`
    : `<tbody><tr><td class="empty">No runs yet.</td></tr></tbody>`;
}
function describePrep(run) {
  const info = parseRunTitle(run);
  if (!info) return run.display_title;
  return `${info.date ? fmtDay(info.date) : "?"} · ${videoTitle(info.videoId)}`;
}
function runChip(r) {
  if (r.status !== "completed") return `<span class="chip info"><i class="spin"></i>Running</span>`;
  return { success: `<span class="chip ok">Done</span>`, failure: `<span class="chip err">Failed</span>`, cancelled: `<span class="chip">Cancelled</span>` }[r.conclusion] || `<span class="chip">${esc(r.conclusion)}</span>`;
}

/* ------------------------------------------------------------------ render: settings */
async function renderSettings() {
  $("#s-token").value = S.cfg.token || "";
  $("#s-repo").value = S.cfg.repo || "";
  $("#s-yt").value = S.cfg.ytKey || "";
  $("#s-remember").checked = S.remember;
  $("#project-status").innerHTML = `<span class="spin"></span> Loading…`;
  $("#secrets-list").innerHTML = `<span class="spin"></span>`;
  renderSchedule();
  await loadSettingsData();
  renderChecklist();
  renderProjectStatus();
  renderSecrets();
  renderVariables();
  renderSchedule();
  renderVerify();
}
function renderChecklist() {
  const el = $("#checklist");
  if (!el) return;
  const steps = setupSteps();
  const done = steps.filter((s) => s.done).length;
  const nextKey = steps.find((s) => !s.done)?.key;
  el.innerHTML = `
    <div class="checklist-head">
      <h3>${done === steps.length ? "You're all set ✓" : "Setup checklist"}</h3>
      <span class="chip mono-chip">${done} / ${steps.length}</span>
    </div>
    <div class="progress"><i style="width:${(done / steps.length) * 100}%"></i></div>
    <ol class="checklist">${steps.map((s, i) => `
      <li class="${s.done ? "done" : ""} ${s.key === nextKey ? "next" : ""}">
        <button ${s.target ? `data-scroll="${s.target}"` : "disabled"}>
          <span class="ck">${s.done ? "✓" : i + 1}</span><span>${esc(s.label)}</span>
        </button>
      </li>`).join("")}
    </ol>`;
}
function renderProjectStatus() {
  const bundle = window.PROJECT_BUNDLE;
  let html = `Repository: <a href="https://github.com/${esc(S.cfg.repo)}" target="_blank" rel="noopener">${esc(S.cfg.repo)} ↗</a>`;
  if (S.workflows?.error) html += `<br><span class="chip err">${ghErrorText(S.workflows.error)}</span>`;
  else {
    const names = (S.workflows || []).map((w) => w.path.split("/").pop());
    const present = Object.values(WORKFLOWS).filter((f) => names.includes(f)).length;
    html += `<br>Automations: ${present === 3 ? `<span class="chip ok">✓ uploaded (3/3)</span>` : `<span class="chip warn">${present}/3 – upload the project</span>`}`;
  }
  if (bundle) html += `<br>Version in this panel: <span class="mono">${esc(bundle.built)}</span> (${bundle.files.length} files)`;
  $("#project-status").innerHTML = html;
}
function renderSecrets() {
  const el = $("#secrets-list");
  if (S.secrets?.error) { el.innerHTML = `<p class="hint">${ghErrorText(S.secrets.error)}</p>`; return; }
  el.innerHTML = SECRETS.map((s) => {
    const existing = (S.secrets || []).find((x) => x.name === s.name);
    const chip = existing
      ? `<span class="chip ok">✓ set ${fmtDateTime(existing.updated_at)}</span>`
      : s.required ? `<span class="chip err">missing</span>` : `<span class="chip">optional</span>`;
    const input = s.multiline
      ? `<textarea id="sec-${s.name}" placeholder="${existing ? "Paste a new value to replace it…" : "# Netscape HTTP Cookie File…"}"></textarea>`
      : `<input type="password" id="sec-${s.name}" autocomplete="off" placeholder="${existing ? "Paste a new value to replace it…" : "Paste the value…"}">`;
    return `
      <div class="secret-row">
        <div class="secret-head"><b>${esc(s.label)}</b><span class="name muted">${s.name}</span>${chip}</div>
        <p class="hint">${esc(s.hint)}</p>
        <div class="input-row">
          ${input}
          ${s.name === "YOUTUBE_API_KEY" && S.cfg.ytKey ? `<button class="btn sm" data-fill-yt>Use the panel's key</button>` : ""}
          <button class="btn" data-save-secret="${s.name}">Save</button>
          ${existing && !s.required ? `<button class="btn ghost danger" data-del-secret="${s.name}">Delete</button>` : ""}
        </div>
      </div>`;
  }).join("");
}
function renderVariables() {
  for (const [name, def] of Object.entries(VARIABLES)) $(`#var-${name}`).value = repoVar(name) || def;
}

let tzOptionsReady = false;
function renderSchedule() {
  const sel = $("#sch-tz");
  const zone = S.cfg.tz || BROWSER_TZ;
  if (!tzOptionsReady) {
    let zones = [];
    try { zones = Intl.supportedValuesOf("timeZone"); } catch { /* older browser */ }
    zones = [...new Set([...zones, "UTC", BROWSER_TZ, zone])].sort();
    sel.innerHTML = zones.map((z) => `<option value="${esc(z)}">${esc(z.replace(/_/g, " "))}</option>`).join("");
    tzOptionsReady = true;
  }
  if (![...sel.options].some((o) => o.value === zone)) sel.add(new Option(zone, zone));
  sel.value = zone;
  $("#sch-time").value = pubTime();
  const info = S.pendingChannel || (S.cfg.channelInfo?.id === S.cfg.channel ? S.cfg.channelInfo : null);
  if (!$("#ch-input").value || !S.pendingChannel) $("#ch-input").value = info?.handle || S.cfg.channel || "";
  renderChannelPreview(info);
  renderScheduleHint();
}
function renderChannelPreview(info) {
  const el = $("#ch-preview");
  if (!info && !S.cfg.channel) { el.innerHTML = `<p class="hint">Type your channel's @handle (or paste its link) and click <b>Find</b>.</p>`; return; }
  if (!info) { el.innerHTML = `<div class="channel-card"><div class="channel-avatar"></div><div><b>Channel</b><div class="mono">${esc(S.cfg.channel)}</div></div></div>`; return; }
  const pending = S.pendingChannel && S.pendingChannel.id !== S.cfg.channel;
  el.innerHTML = `
    <div class="channel-card ${pending ? "pending" : ""}">
      ${info.thumb ? `<img class="channel-avatar" src="${esc(info.thumb)}" alt="">` : `<div class="channel-avatar"></div>`}
      <div class="channel-text"><b>${esc(info.title)}</b><div class="muted small">${esc(info.handle || "")} <span class="mono">${esc(info.id)}</span></div></div>
      <span class="chip ${pending ? "warn" : "ok"}">${pending ? "not saved yet" : "✓ in use"}</span>
    </div>`;
}
function renderScheduleHint() {
  const time = $("#sch-time").value || DEFAULT_TIME;
  const zone = $("#sch-tz").value || BROWSER_TZ;
  let crons = [];
  try { crons = cronLines(time, zone); } catch { /* invalid zone */ }
  const min = hhmmToMin(time);
  const readme = S.cfg.repo ? `https://github.com/${S.cfg.repo}#7--optional-on-time-publishing-with-cron-joborg` : "";
  $("#sch-hint").innerHTML = `Reels go live at <b>${esc(fmtClock(min))}</b> ${esc(zone.replace(/_/g, " "))} time on the day you pick. Same-day scheduling closes at ${esc(fmtClock(min - PREP_LEAD))}. <span class="muted">(${crons.length} cloud checks a day)</span>`
    + `<br>GitHub sometimes runs its schedule late or skips it. For on-time Reels, add a free <b>cron-job.org</b> trigger at <b>${esc(fmtClock(min - CRON_LEADS[0]))}</b> and <b>${esc(fmtClock(min - CRON_LEADS[1]))}</b>${readme ? ` (<a href="${esc(readme)}" target="_blank" rel="noopener">how ↗</a>)` : ""}.`;
}

async function findChannel() {
  if (!S.cfg.ytKey) { toast("Add your YouTube API key under <b>Panel connection</b> first – the panel uses it to look up the channel.", "info", 7000); scrollToCard("card-connection"); return; }
  const btn = $("#btn-ch-find");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span>`;
  try {
    S.pendingChannel = await lookupChannel($("#ch-input").value);
    renderChannelPreview(S.pendingChannel);
  } catch (e) {
    toast(esc(e.message), "err", 7000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Find";
  }
}
async function setVariables(values) {
  for (const [name, value] of Object.entries(values)) {
    try {
      await gh(`${R()}/actions/variables/${name}`, { method: "PATCH", body: { name, value } });
    } catch (e) {
      if (e.status !== 404) throw e;
      await gh(`${R()}/actions/variables`, { method: "POST", body: { name, value } });
    }
  }
}
/** Rewrites the cron block in publish.yml on GitHub. Returns "updated" | "unchanged" | "missing" | "nomarkers". */
async function updatePublishSchedule(time, zone) {
  let file;
  try {
    file = await gh(`${R()}/contents/${PUBLISH_WORKFLOW_PATH}`);
  } catch (e) {
    if (e.status === 404) return "missing";
    throw e;
  }
  const text = b64ToText(file.content);
  const next = applyCronBlock(text, time, zone);
  if (next === null) return "nomarkers";
  if (next === text) return "unchanged";
  await gh(`${R()}/contents/${PUBLISH_WORKFLOW_PATH}`, {
    method: "PUT",
    body: { message: `Publish schedule: ${time} ${zone} (Reels Studio)`, content: textToB64(next), sha: file.sha, ...(S.repo?.default_branch ? { branch: S.repo.default_branch } : {}) },
  });
  return "updated";
}
async function saveSchedule() {
  const ch = S.pendingChannel || (S.cfg.channel ? S.cfg.channelInfo?.id === S.cfg.channel ? S.cfg.channelInfo : { id: S.cfg.channel } : null);
  if (!ch) { toast("Find your channel first: type its @handle and click <b>Find</b>.", "info", 7000); return; }
  const time = $("#sch-time").value;
  const zone = $("#sch-tz").value;
  if (!/^\d{2}:\d{2}$/.test(time)) { toast("Pick a publish time.", "err"); return; }
  try { new Intl.DateTimeFormat("en", { timeZone: zone }); } catch { toast("Unknown time zone.", "err"); return; }
  const btn = $("#btn-save-schedule");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> Saving…`;
  try {
    await setVariables({ YOUTUBE_CHANNEL_ID: ch.id, TIMEZONE: zone, PUBLISH_TIME: time });
    const cron = await updatePublishSchedule(time, zone);
    const channelChanged = ch.id !== S.cfg.channel;
    const timeChanged = !!S.cfg.time && (time !== S.cfg.time || zone !== S.cfg.tz);
    Object.assign(S.cfg, { channel: ch.id, tz: zone, time });
    if (ch.title) S.cfg.channelInfo = ch;
    S.pendingChannel = null;
    saveCfg();
    const note = {
      updated: " The daily cloud schedule was updated too.",
      unchanged: "",
      missing: " The cloud schedule will be set when you upload the project.",
      nomarkers: " ⚠️ Couldn't update the schedule in publish.yml – click <b>Upload / update project</b> to fix it.",
    }[cron];
    const m = hhmmToMin(time);
    const cronJob = timeChanged ? ` Using cron-job.org? Change its times to <b>${esc(fmtClock(m - CRON_LEADS[0]))}</b> and <b>${esc(fmtClock(m - CRON_LEADS[1]))}</b>.` : "";
    toast(`Saved: <b>${esc(ch.title || ch.id)}</b>, Reels at <b>${esc(fmtClock(m))}</b> ${esc(zone)}.${note}${cronJob}`, cron === "nomarkers" || timeChanged ? "info" : "ok", timeChanged ? 15000 : 9000);
    if (channelChanged) { S.shorts = []; loadShorts().then(renderData); }
    renderBrand();
    await loadSettingsData();
    renderSchedule();
    renderChecklist();
    renderData();
  } catch (e) {
    toast(ghErrorText(e) + ([403, 404].includes(e.status) ? " The token needs <b>Variables</b>, <b>Contents</b> and <b>Workflows</b> (Read and write)." : ""), "err", 10000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Save channel & schedule";
  }
}

async function saveSecret(name) {
  const input = $(`#sec-${name}`);
  const value = input.value.trim();
  if (!value) { toast("Paste a value first.", "info"); return; }
  if (!window.nacl) { toast("The encryption library didn't load – check your internet connection.", "err"); return; }
  try {
    const key = await gh(`${R()}/actions/secrets/public-key`);
    const encrypted_value = window.PodCrypto.sealSecret(window.nacl, key.key, value);
    await gh(`${R()}/actions/secrets/${name}`, { method: "PUT", body: { encrypted_value, key_id: key.key_id } });
    input.value = "";
    toast(`${name} saved.`, "ok");
    await loadSettingsData();
    renderSecrets();
    renderChecklist();
  } catch (e) {
    toast(ghErrorText(e), "err", 8000);
  }
}
async function deleteSecret(name) {
  if (!confirm(`Delete ${name}?`)) return;
  try {
    await gh(`${R()}/actions/secrets/${name}`, { method: "DELETE" });
    toast(`${name} deleted.`, "ok");
    await loadSettingsData();
    renderSecrets();
  } catch (e) { toast(ghErrorText(e), "err"); }
}
async function saveVariables() {
  try {
    // GitHub refuses empty variables, so an emptied field falls back to its default.
    await setVariables(Object.fromEntries(Object.entries(VARIABLES).map(([name, def]) => [name, String($(`#var-${name}`).value).trim() || def])));
    toast("Options saved.", "ok");
    await loadSettingsData();
    renderVariables();
  } catch (e) { toast(ghErrorText(e), "err", 8000); }
}

/* --- upload the project into the repository (Git Data API, one commit) --- */
async function uploadProject() {
  const bundle = window.PROJECT_BUNDLE;
  if (!bundle) { toast("project-bundle.js is missing from the panel folder.", "err"); return; }
  const btn = $("#btn-upload");
  btn.disabled = true;
  const status = (t) => { btn.innerHTML = `<span class="spin"></span> ${t}`; };
  try {
    status("Checking repository…");
    S.repo = await gh(R());
    const branch = S.repo.default_branch || "main";
    let head = await gh(`${R()}/git/ref/heads/${branch}`).catch((e) => { if ([404, 409].includes(e.status)) return null; throw e; });
    if (!head) {
      // Empty repository: the first file via the Contents API creates the branch.
      status("Initialising repository…");
      const readme = bundle.files.find((f) => f.path === "README.md") || bundle.files[0];
      await gh(`${R()}/contents/${readme.path}`, { method: "PUT", body: { message: "Initial commit", content: readme.b64, branch } });
      head = await gh(`${R()}/git/ref/heads/${branch}`);
    }
    const baseCommit = await gh(`${R()}/git/commits/${head.object.sha}`);
    const tree = [];
    for (const [i, f] of bundle.files.entries()) {
      status(`Uploading ${i + 1}/${bundle.files.length}…`);
      let content = f.b64;
      // Keep the user's publish time: never let an update reset the cron schedule.
      if (f.path === PUBLISH_WORKFLOW_PATH && S.cfg.tz) {
        const patched = applyCronBlock(b64ToText(f.b64), pubTime(), S.cfg.tz);
        if (patched !== null) content = textToB64(patched);
      }
      const blob = await gh(`${R()}/git/blobs`, { method: "POST", body: { content, encoding: "base64" } });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    status("Saving…");
    const newTree = await gh(`${R()}/git/trees`, { method: "POST", body: { base_tree: baseCommit.tree.sha, tree } });
    if (newTree.sha === baseCommit.tree.sha) {
      toast("The project on GitHub is already up to date.", "ok");
    } else {
      const commit = await gh(`${R()}/git/commits`, { method: "POST", body: { message: `Update from Reels Studio (${bundle.built})`, tree: newTree.sha, parents: [head.object.sha] } });
      await gh(`${R()}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: commit.sha } });
      toast("Project uploaded to GitHub. ✨", "ok");
    }
    await loadSettingsData();
    renderProjectStatus();
    renderChecklist();
    refresh({ quiet: true });
  } catch (e) {
    const hint = [403, 404].includes(e.status) ? " Make sure the token has <b>Contents</b> and <b>Workflows</b> (Read and write)." : "";
    toast(ghErrorText(e) + hint, "err", 10000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Upload / update project";
  }
}

/* --- access test --- */
async function runVerify() {
  const btn = $("#btn-verify");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> Starting…`;
  const started = new Date(Date.now() - 5000).toISOString();
  try {
    await gh(`${R()}/actions/workflows/${WORKFLOWS.verify}/dispatches`, { method: "POST", body: { ref: S.repo?.default_branch || "main" } });
    $("#verify-result").innerHTML = `<div class="results"><div class="result"><span class="spin"></span><div>The test is running in the cloud (about a minute)…</div></div></div>`;
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      S.verifyRuns = await listRuns(WORKFLOWS.verify, 5);
      const run = S.verifyRuns.find((r) => r.created_at >= started);
      if (run && run.status === "completed") break;
    }
    await updateVerifyOk();
    await renderVerify();
    renderChecklist();
  } catch (e) {
    toast(e.status === 404 ? "The test workflow wasn't found. Upload the project first." : ghErrorText(e), "err", 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ Run access test";
  }
}
/** "Check: …" steps of a finished access-test run (cached per run). */
async function verifySteps(run) {
  if (!run || run.status !== "completed") return null;
  if (S.verifyCache?.id === run.id) return S.verifyCache;
  const jobs = await gh(`${R()}/actions/runs/${run.id}/jobs`);
  const steps = [];
  for (const job of jobs.jobs) {
    for (const s of job.steps || []) if (/^Check: /.test(s.name)) steps.push({ ...s, url: `${job.html_url}#step:${s.number}:1` });
  }
  S.verifyCache = { id: run.id, jobs: jobs.jobs, steps };
  return S.verifyCache;
}
// "(optional)" checks (YouTube download) may fail without blocking anything: videos can be attached instead.
const isOptionalCheck = (name) => /\(optional\)/i.test(name);
const verifyPassed = (run, steps) => (steps?.length ? steps.every((s) => s.conclusion === "success" || isOptionalCheck(s.name)) : run?.conclusion === "success");
async function updateVerifyOk() {
  const run = (S.verifyRuns || []).find((r) => r.status === "completed");
  try { S.verifyOk = verifyPassed(run, (await verifySteps(run))?.steps); } catch { S.verifyOk = run?.conclusion === "success"; }
}

async function renderVerify() {
  const el = $("#verify-result");
  const run = (S.verifyRuns || [])[0];
  if (!run) { el.innerHTML = ""; return; }
  if (run.status !== "completed") {
    el.innerHTML = `<div class="results"><div class="result"><span class="spin"></span><div>Test running…</div></div></div>`;
    return;
  }
  let annotations = [];
  let steps = [];
  try {
    const v = await verifySteps(run);
    steps = v.steps;
    // Detailed annotations need the "Checks" permission, which fine-grained tokens don't offer;
    // without it we fall back to one ✅/❌ row per "Check: …" step.
    try {
      for (const job of v.jobs) annotations.push(...(await gh(`${R()}/check-runs/${job.id}/annotations`)));
    } catch { annotations = null; }
  } catch { annotations = null; }
  const icon = { notice: "✅", warning: "⚠️", failure: "❌" };
  const order = ["failure", "warning", "notice"];
  let items = (annotations || [])
    .filter((a) => !/Node\.js|deprecated|ubuntu-latest/i.test(a.message))
    .sort((a, b) => order.indexOf(a.annotation_level) - order.indexOf(b.annotation_level))
    .map((a) => `<div class="result ${a.annotation_level}"><div>${icon[a.annotation_level] || "•"}</div><div><b>${esc(a.title || "")}</b>${esc(a.message)}</div></div>`);
  if (annotations === null && steps.length) {
    const tips = [
      [/download/i, "YouTube blocks downloads from GitHub's servers. No problem: attach the video file (📎) when scheduling. YouTube cookies help only sometimes."],
      [/instagram/i, "Add the Instagram access token and account ID in card 2."],
      [/youtube/i, "Check the YouTube API key (card 2) and the channel (card 3)."],
    ];
    items = steps.map((s) => {
      const ok = s.conclusion === "success";
      const level = ok ? "notice" : s.conclusion === "failure" && !isOptionalCheck(s.name) ? "failure" : "warning";
      const name = s.name.replace(/^Check: /, "");
      const tip = ok ? "OK" : s.conclusion === "failure" ? (tips.find(([re]) => re.test(name)) || [, "See the log."])[1] : "Didn't run.";
      return `<div class="result ${level}"><div>${ok ? "✅" : level === "failure" ? "❌" : s.conclusion === "failure" ? "⚠️" : "⏭️"}</div><div><b>${esc(name)}</b>${esc(tip)} <a class="small" href="${esc(s.url)}" target="_blank" rel="noopener">Log ↗</a></div></div>`;
    });
  }
  const head = verifyPassed(run, steps)
    ? `<span class="chip ok">✓ All good</span>`
    : `<span class="chip err">Problems found</span>`;
  el.innerHTML = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:4px">${head}<span class="muted small">${fmtDateTime(run.created_at)}</span><a class="small" href="${esc(run.html_url)}" target="_blank" rel="noopener">Full log ↗</a></div>
    <div class="results">${items.join("") || (annotations === null ? `<p class="hint">Open the full log for the details of each check.</p>` : "")}</div>`;
}

async function publishNow() {
  const today = todayIso();
  const st = dayState(today);
  if (!st || st.kind !== "scheduled") { toast("Nothing is scheduled for today.", "info"); return; }
  if (!confirm(`Publish “${videoTitle(st.videoId)}” to Instagram RIGHT NOW?`)) return;
  try {
    await gh(`${R()}/actions/workflows/${WORKFLOWS.publish}/dispatches`, { method: "POST", body: { ref: S.repo?.default_branch || "main", inputs: { now: "true" } } });
    toast("Publishing started. The result shows up in History within a few minutes.", "ok", 7000);
    setTimeout(() => refresh({ quiet: true }), 4000);
  } catch (e) { toast(ghErrorText(e), "err", 8000); }
}

/* ------------------------------------------------------------------ connection */
function normalizeRepo(s) {
  s = (s || "").trim().replace(/\.git$/, "");
  const m = /github\.com\/([^/]+\/[^/?#]+)/.exec(s);
  return m ? m[1] : s;
}
async function connect(token, repo, ytKey, remember) {
  const prev = S.cfg;
  S.cfg = { ...prev, token: token.trim(), repo: normalizeRepo(repo), ytKey: (ytKey || "").trim() };
  S.remember = remember;
  if (!S.cfg.token || !/^[^/\s]+\/[^/\s]+$/.test(S.cfg.repo)) { toast("Fill in both the token and the repository as owner/name.", "err"); S.cfg = prev; return false; }
  if (prev.repo && prev.repo !== S.cfg.repo) Object.assign(S.cfg, { channel: "", channelInfo: null, tz: "", time: "" });
  try {
    S.repo = await gh(R());
  } catch (e) {
    toast(ghErrorText(e), "err", 9000);
    S.cfg = prev;
    return false;
  }
  saveCfg();
  S.shorts = []; S.videos = {};
  toast(`Connected to <b>${esc(S.cfg.repo)}</b>${S.repo.private ? " (private)" : ""}.`, "ok");
  return true;
}

async function startApp() {
  renderBrand();
  showView(S.view);
  if (!(S.cfg.token && S.cfg.repo)) return;
  loadShorts().then(renderData);
  ensureChannelInfo();
  const settings = loadSettingsData().then(renderData).catch(() => {});
  await refresh();
  await settings;
}

/* ------------------------------------------------------------------ events */
document.addEventListener("click", (ev) => {
  const t = ev.target.closest("button, a");
  if (!t) return;
  if (t.dataset.goto) { ev.preventDefault(); showView(t.dataset.goto, t.dataset.scroll); return; }
  if (t.dataset.scroll) { ev.preventDefault(); scrollToCard(t.dataset.scroll); return; }
  if (t.dataset.view) { showView(t.dataset.view); return; }
  if (t.dataset.date) {
    const iso = t.dataset.date;
    const st = dayState(iso);
    if (st && dateStatus(iso) !== "open") { showView(st.kind === "published" || dateStatus(iso) === "past" ? "history" : "queue"); return; }
    S.selDate = S.selDate === iso ? null : iso;
    S.replace = false;
    renderCalendar(); renderActionBar();
    return;
  }
  if (t.dataset.video && t.classList.contains("short")) {
    S.selVideo = S.selVideo === t.dataset.video ? null : t.dataset.video;
    S.videoFile = null;
    renderShorts(); renderActionBar();
    autoAttach(S.selVideo);
    return;
  }
  if (t.dataset.shortFilter) {
    S.shortFilter = t.dataset.shortFilter;
    try { localStorage.setItem(FILTER_KEY, S.shortFilter); } catch { /* works without storage too */ }
    renderShorts();
    return;
  }
  if (t.dataset.cancel) { cancelDay(t.dataset.cancel); return; }
  if (t.dataset.retry) { S.selDate = t.dataset.retry; S.selVideo = t.dataset.video; S.replace = true; S.videoFile = null; showView("planner"); autoAttach(S.selVideo); return; }
  if (t.dataset.saveSecret) { saveSecret(t.dataset.saveSecret); return; }
  if (t.dataset.delSecret) { deleteSecret(t.dataset.delSecret); return; }
  if ("fillYt" in t.dataset) { $("#sec-YOUTUBE_API_KEY").value = S.cfg.ytKey; return; }

  switch (t.id) {
    case "ab-clear": S.selDate = S.selVideo = null; S.replace = false; S.videoFile = null; renderData(); break;
    case "ab-schedule": schedule(); break;
    case "ab-mark": markPublished(S.selVideo); break;
    case "ab-folder": attachFromFolder(); break;
    case "ab-show": openInFolder(S.selVideo); break;
    case "ab-dl": case "btn-dl-shorts": downloadShorts(); break;
    case "cal-prev": case "cal-next": {
      const [y, m] = S.month.split("-").map(Number);
      const d = new Date(Date.UTC(y, m - 1 + (t.id === "cal-next" ? 1 : -1), 1));
      S.month = d.toISOString().slice(0, 7);
      renderCalendar();
      break;
    }
    case "cal-today": S.month = todayIso().slice(0, 7); renderCalendar(); break;
    case "shorts-reload": S.shorts = []; S.shortsError = null; renderShorts(); loadShorts().then(renderData); break;
    case "manual-video-btn": {
      const id = extractVideoId($("#manual-video").value);
      if (!id) { toast("That doesn't look like a YouTube Short link.", "err"); break; }
      S.selVideo = id;
      $("#manual-video").value = "";
      loadVideos([id]).catch(() => {}).finally(renderData);
      break;
    }
    case "btn-refresh": refresh(); if (S.view === "settings") renderSettings(); break;
    case "btn-theme": toggleTheme(); break;
    case "w-connect":
      connect($("#w-token").value, $("#w-repo").value, $("#w-yt").value, $("#w-remember").checked)
        .then((ok) => { if (ok) { S.view = "settings"; startApp(); } });
      break;
    case "btn-save-conn":
      connect($("#s-token").value, $("#s-repo").value, $("#s-yt").value, $("#s-remember").checked)
        .then((ok) => { if (ok) startApp(); });
      break;
    case "btn-logout":
      if (confirm("Disconnect the panel and remove the saved token from this computer?")) {
        S.cfg = {}; saveCfg();
        try { localStorage.removeItem(STORE_KEY); sessionStorage.removeItem(STORE_KEY); } catch { /* nothing */ }
        location.reload();
      }
      break;
    case "btn-upload": uploadProject(); break;
    case "btn-verify": runVerify(); break;
    case "btn-save-vars": saveVariables(); break;
    case "btn-ch-find": findChannel(); break;
    case "btn-save-schedule": saveSchedule(); break;
    case "btn-publish-now": publishNow(); break;
  }
});
document.addEventListener("change", (ev) => {
  if (ev.target.id === "ab-replace") { S.replace = ev.target.checked; renderActionBar(); }
  if (ev.target.id === "ab-ai") { S.aiLabel = ev.target.checked ? "on" : "off"; }
  if (ev.target.id === "ab-file") {
    const f = ev.target.files?.[0] || null;
    if (f && f.size > MAX_UPLOAD_BYTES) toast(`That file is ${(f.size / 1048576).toFixed(0)} MB; GitHub accepts up to 95 MB. Export a smaller file (1080×1920 H.264 is plenty).`, "err", 9000);
    else S.videoFile = f;
    renderActionBar();
  }
  if (ev.target.id === "sch-tz" || ev.target.id === "sch-time") renderScheduleHint();
});
document.addEventListener("input", (ev) => {
  if (ev.target.id === "sch-time") renderScheduleHint();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.id === "manual-video") $("#manual-video-btn").click();
  if (ev.key === "Enter" && ev.target.id === "ch-input") findChannel();
  if (ev.key === "Escape" && (S.selDate || S.selVideo)) { S.selDate = S.selVideo = null; renderData(); }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh({ quiet: true }); });

/* ------------------------------------------------------------------ theme (dark by default) */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* nothing */ }
}

/* ------------------------------------------------------------------ start */
try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { applyTheme("dark"); }
S.cfg = loadCfg();
importHandoff();
startApp();
initLocalApp();
