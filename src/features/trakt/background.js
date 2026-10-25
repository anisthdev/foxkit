// Trakt scrobbler. Content scripts (netflix.js) report start/pause/stop with
// the title and progress; this matches the title on Trakt and forwards the
// event to /scrobble, where a stop at 80% or more marks it watched.
//
// A match fixed by hand in the popup is stored per show or movie in
// storage.local and sticks. What is playing now is kept in
// storage.session for the popup to show.

import * as api from "./api.js";

const ENABLED = "trakt.enabled";
const MATCHES = "trakt.matches";
const NOW_PLAYING = "trakt.nowPlaying";
const USER = "trakt.user";

export function init() {
  browser.runtime.onMessage.addListener(onMessage);
  // Trakt's redirect after sign-in goes to an address that does not resolve;
  // take the code from it and close the tab instead.
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      api.finishLogin(details.url).then(
        () => notify("Signed in to Trakt", "Netflix playback will now be scrobbled."),
        (error) => notify("Trakt sign-in failed", error.message),
      );
      if (details.tabId >= 0) browser.tabs.remove(details.tabId);
      return { cancel: true };
    },
    { urls: [api.redirectPattern()], types: ["main_frame"] },
    ["blocking"],
  );
  // Closing a tab does not always let its content script report the stop.
  browser.tabs.onRemoved.addListener((tabId) =>
    enqueue(async () => {
      const { nowPlaying } = await status();
      if (nowPlaying?.tabId === tabId) await save(null);
    }),
  );
}

export function createMenus() {}

function onMessage(message, sender) {
  switch (message?.type) {
    case "trakt:scrobble":
      return enqueue(() => scrobble(message, sender.tab?.id));
    case "trakt:status":
      return status();
    case "trakt:login":
      return api.login();
    case "trakt:logout":
      return Promise.all([api.logout(), browser.storage.local.remove(USER)]);
    case "trakt:set-enabled":
      return browser.storage.local.set({ [ENABLED]: message.enabled });
    case "trakt:search":
      return search(message.kind, message.query);
    case "trakt:pick":
      return enqueue(() => pick(message.match));
  }
}

// Scrobble events are handled one at a time and in order, so a pause cannot
// overtake the start it follows while the start is still being matched.
let queue = Promise.resolve();

function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}

async function status() {
  const stored = await browser.storage.local.get([ENABLED, USER]);
  const loggedIn = await api.isLoggedIn();
  return {
    loggedIn,
    user: loggedIn ? (stored[USER] ?? (await user())) : null,
    enabled: stored[ENABLED] ?? true,
    nowPlaying: (await browser.storage.session.get(NOW_PLAYING))[NOW_PLAYING] ?? null,
  };
}

// The signed-in account, for the popup: { username, name }.
async function user() {
  try {
    const { user } = await api.request("GET", "/users/settings");
    const profile = { username: user.username, name: user.name };
    await browser.storage.local.set({ [USER]: profile });
    return profile;
  } catch {
    return null;
  }
}

const sameItem = (a, b) => a?.key === b?.key && a?.season === b?.season && a?.number === b?.number;

const kindOf = (item) => (item.type === "movie" ? "movie" : "show");

function label(item) {
  if (item.type === "movie") return item.year ? `${item.title} (${item.year})` : item.title;
  const pad = (n) => String(n).padStart(2, "0");
  return `${item.title} S${pad(item.season)}E${pad(item.number)}`;
}

async function scrobble({ action, item, progress }, tabId) {
  const { loggedIn, enabled, nowPlaying } = await status();
  const fresh = !sameItem(nowPlaying?.item, item);
  const playing = {
    ...(fresh ? {} : nowPlaying),
    item,
    tabId,
    action,
    progress,
    error: null,
  };

  if (!loggedIn || !enabled) {
    await save(action === "stop" ? null : { ...playing, match: null, skipped: true });
    return;
  }

  try {
    playing.match = await resolve(item);
    if (!playing.match) throw new Error(`No Trakt match for "${item.title}"`);
    await send(action, item, playing.match, progress);
    if (fresh && action === "start") notify("Scrobbling", `${label(item)} → ${playing.match.title}`);
  } catch (error) {
    playing.error = error.message;
    if (fresh || !nowPlaying?.error) notify("Trakt scrobble failed", `${label(item)}: ${error.message}`);
  }
  await save(action === "stop" && !playing.error ? null : playing);
}

async function send(action, item, match, progress) {
  const body = { progress: Math.min(100, Math.max(0, progress)) };
  if (item.type === "movie") body.movie = { ids: match.ids };
  else Object.assign(body, { show: { ids: match.ids }, episode: { season: item.season, number: item.number } });
  try {
    await api.request("POST", `/scrobble/${action}`, { body });
  } catch (error) {
    // 409: this item was already scrobbled as watched within the last hour.
    if (error.status !== 409) throw error;
  }
}

async function save(nowPlaying) {
  if (nowPlaying) await browser.storage.session.set({ [NOW_PLAYING]: nowPlaying });
  else await browser.storage.session.remove(NOW_PLAYING);
  badge(nowPlaying);
}

// A dot on the toolbar button while scrobbling, red when it failed.
function badge(nowPlaying) {
  const watching = nowPlaying?.action === "start" && !nowPlaying.skipped;
  const failed = Boolean(nowPlaying?.error);
  browser.action.setBadgeText({ text: failed ? "!" : watching ? "●" : "" });
  browser.action.setBadgeBackgroundColor({ color: failed ? "#d93025" : "#1d9a56" });
  browser.action.setBadgeTextColor({ color: "#fff" });
}

async function matches() {
  return (await browser.storage.local.get(MATCHES))[MATCHES] ?? {};
}

// Trakt's search trips over punctuation ("House, M.D." finds nothing like
// House, "House MD" finds it), so queries and comparisons drop it.
const plain = (title) =>
  title
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Automatic matches, by item key. Kept for the session only, so better
// matching applies to titles already seen; picks made by hand are stored.
const autoMatches = new Map();

async function resolve(item) {
  // Earlier versions stored automatic matches too; only trust picked ones.
  const stored = (await matches())[item.key];
  const known = stored?.manual ? stored : autoMatches.get(item.key);
  if (known) return known;

  const results = await search(kindOf(item), item.title);
  const title = plain(item.title);
  const exact = (r) => plain(r.title) === title;
  const year = (r, slack) => item.year && r.year && Math.abs(r.year - item.year) <= slack;
  const match =
    results.find((r) => exact(r) && year(r, 0)) ??
    results.find((r) => exact(r) && year(r, 1)) ??
    results.find(exact) ??
    results[0];
  if (match) autoMatches.set(item.key, match);
  return match ?? null;
}

async function remember(key, match) {
  await browser.storage.local.set({ [MATCHES]: { ...(await matches()), [key]: match } });
}

// Resolves to [{ kind, title, year, ids, poster }], best first.
async function search(kind, query) {
  const results = await api.request(
    "GET",
    `/search/${kind}?${new URLSearchParams({ query: plain(query), fields: "title,aliases", extended: "images", limit: 10 })}`,
    { auth: false },
  );
  return results.map((r) => {
    const { title, year, ids, images } = r[kind];
    const poster = images?.poster?.[0];
    return { kind, title, year, ids, poster: poster && `https://${poster}` };
  });
}

// Replaces the match for what is playing now and restarts its scrobble.
async function pick(match) {
  const { nowPlaying } = await status();
  if (!nowPlaying) return;
  await remember(nowPlaying.item.key, { ...match, manual: true });
  const action = nowPlaying.action === "start" ? "start" : "pause";
  await scrobble({ action, item: nowPlaying.item, progress: nowPlaying.progress }, nowPlaying.tabId);
}

function notify(title, message) {
  browser.notifications.create({ type: "basic", title, message });
}
