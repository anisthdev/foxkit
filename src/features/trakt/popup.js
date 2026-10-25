// Toolbar popup for the Trakt scrobbler: sign-in, the on/off switch, what is
// playing and what it matched, and a search to fix a wrong match.

const $ = (id) => document.getElementById(id);
const ask = (type, payload = {}) => browser.runtime.sendMessage({ type, ...payload });

const pad = (n) => String(n).padStart(2, "0");
const withYear = ({ title, year }) => (year ? `${title} (${year})` : title);

// Trakt marks a title watched when its scrobble stops at this progress.
const WATCHED_AT = 80;

let nowPlaying = null;

async function render() {
  const status = await ask("trakt:status");
  nowPlaying = status.nowPlaying;

  $("signed-out").hidden = status.loggedIn;
  $("toggle").hidden = !status.loggedIn;
  $("enabled").checked = status.enabled;
  $("account").hidden = !status.loggedIn || !status.user;
  if (status.user) {
    $("username").textContent = status.user.name || status.user.username;
    $("username").href = `https://trakt.tv/users/${status.user.username}`;
  }

  $("idle").hidden = !status.loggedIn || Boolean(nowPlaying);
  $("playing").hidden = !status.loggedIn || !nowPlaying;
  if (status.loggedIn && nowPlaying) renderPlaying(nowPlaying);
}

function renderPlaying({ item, match, action, progress, error, skipped }) {
  const show = $("show");
  if (match) {
    show.textContent = withYear(match);
    show.href = `https://trakt.tv/${match.kind === "movie" ? "movies" : "shows"}/${match.ids.slug}`;
  } else {
    show.textContent = withYear(item);
    show.removeAttribute("href");
  }

  $("episode").hidden = item.type === "movie";
  $("episode").textContent =
    item.type === "movie" ? "" : `S${pad(item.season)}E${pad(item.number)}${item.episodeTitle ? ` · ${item.episodeTitle}` : ""}`;
  $("source").textContent = match && match.title !== item.title ? `Netflix: ${item.title}` : "On Netflix";

  const poster = match?.poster;
  $("poster").hidden = !poster;
  $("poster-blank").hidden = Boolean(poster);
  if (poster) $("poster").src = poster;

  const [state, text] = skipped
    ? ["off", "Scrobbling off"]
    : error
      ? ["error", "Not scrobbling"]
      : { start: ["watching", "Scrobbling"], pause: ["paused", "Paused"], stop: ["stopped", "Stopped"] }[action];
  $("status").className = `status ${state}`;
  $("status").textContent = text;

  showProgress(progress);
  $("error").hidden = !error;
  $("error").textContent = error ?? "";
  $("fix").parentElement.hidden = skipped;
  if (!$("query").value) $("query").value = item.title;
}

function showProgress(progress) {
  const value = Math.max(0, Math.min(100, progress ?? 0));
  $("bar-fill").style.width = `${value}%`;
  $("bar").classList.toggle("done", value >= WATCHED_AT);
  $("percent").textContent = `${Math.round(value)}% watched`;
  $("hint").textContent = value >= WATCHED_AT ? "Counts as watched" : `Counts as watched at ${WATCHED_AT}%`;
}

// Scrobble events only carry the progress of the last start or pause, so ask
// the playing tab for the current position while the popup is open.
async function pollProgress() {
  if (!nowPlaying?.tabId) return;
  try {
    const progress = await browser.tabs.sendMessage(nowPlaying.tabId, { type: "trakt:progress" });
    if (typeof progress === "number") showProgress(progress);
  } catch {
    // Tab gone or not on a title any more.
  }
}

function note(className, text) {
  return Object.assign(document.createElement("li"), { className, textContent: text });
}

function result(match) {
  const art = match.poster
    ? Object.assign(document.createElement("img"), { src: match.poster, alt: "" })
    : Object.assign(document.createElement("span"), { className: "thumb" });
  const year = Object.assign(document.createElement("span"), { className: "year", textContent: match.year ?? "" });
  const name = document.createElement("span");
  name.append(match.title, " ", year);

  const button = document.createElement("button");
  button.append(art, name);
  button.addEventListener("click", async () => {
    $("picker").hidden = true;
    $("results").replaceChildren();
    await ask("trakt:pick", { match });
    render();
  });
  const li = document.createElement("li");
  li.append(button);
  return li;
}

async function search(event) {
  event.preventDefault();
  if (!nowPlaying) return;
  const list = $("results");
  list.replaceChildren(note("note", "Searching…"));
  try {
    const kind = nowPlaying.item.type === "movie" ? "movie" : "show";
    const results = await ask("trakt:search", { kind, query: $("query").value.trim() });
    list.replaceChildren(...(results.length ? results.map(result) : [note("note", "No results.")]));
  } catch (error) {
    list.replaceChildren(note("note", error.message));
  }
}

$("login").addEventListener("click", () => ask("trakt:login").then(() => window.close()));
$("logout").addEventListener("click", () => ask("trakt:logout").then(render));
$("enabled").addEventListener("change", (e) => ask("trakt:set-enabled", { enabled: e.target.checked }));
$("fix").addEventListener("click", () => {
  $("picker").hidden = !$("picker").hidden;
  if (!$("picker").hidden) $("query").select();
});
$("search").addEventListener("submit", search);
browser.storage.onChanged.addListener(render);

render().then(pollProgress);
setInterval(pollProgress, 1000);
