// Reports Netflix playback to the Trakt scrobbler. Netflix is a single-page
// app that moves between titles (and on to the next episode) without a
// reload, so the /watch/<id> URL is polled rather than read once.
//
// Title details come from Netflix's own metadata endpoint, fetched through
// the page's own fetch so it goes out as Netflix's request, with its cookies.

const WATCH = /^\/watch\/(\d+)/;

// The page's window, past the content script's Xray view of it.
const page = window.wrappedJSObject;

// The title being watched: { id, item, state, progress }, where item is the
// parsed metadata once loaded and state is "playing", "paused" or null.
let current = null;

const watchId = () => WATCH.exec(location.pathname)?.[1] ?? null;

async function metadata(id) {
  const build = page.netflix?.reactContext?.models?.serverDefs?.data?.BUILD_IDENTIFIER;
  const urls = [`/nq/website/memberapi/release/metadata?movieid=${id}`];
  if (build) urls.push(`/api/shakti/${build}/metadata?movieid=${id}`);

  for (const url of urls) {
    try {
      const response = await page.fetch(url, cloneInto({ credentials: "include" }, window));
      if (!response.ok) {
        console.warn("foxkit: Netflix metadata request failed:", url, response.status);
        continue;
      }
      // Parsed here rather than with response.json(), which would hand back
      // a page object behind an Xray wrapper.
      const json = JSON.parse(await response.text());
      const item = parse(id, json);
      if (!item) console.warn("foxkit: unrecognised Netflix metadata:", json);
      return item;
    } catch (error) {
      console.warn("foxkit: Netflix metadata request failed:", url, error);
    }
  }
  return null;
}

function parse(id, { video }) {
  if (!video) return null;
  if (video.type === "movie") {
    return { key: `netflix:${video.id}`, type: "movie", title: video.title, year: video.year };
  }
  for (const season of video.seasons ?? []) {
    const episode = season.episodes?.find((e) => String(e.id ?? e.episodeId) === id);
    if (episode) {
      return {
        key: `netflix:${video.id}`,
        type: "episode",
        title: video.title,
        year: video.seasons[0]?.year,
        season: season.seq,
        number: episode.seq,
        episodeTitle: episode.title,
      };
    }
  }
  return null;
}

function progress() {
  const video = document.querySelector("video");
  if (!video || !(video.duration > 0) || !Number.isFinite(video.duration)) return null;
  return (video.currentTime / video.duration) * 100;
}

function send(action) {
  if (!current?.item) return;
  console.info("foxkit: scrobble", action, Math.round(current.progress ?? 0));
  browser.runtime
    .sendMessage({ type: "trakt:scrobble", action, item: current.item, progress: current.progress ?? 0 })
    .catch((error) => console.warn("foxkit: scrobble message failed:", error));
}

function setState(state) {
  if (!current || current.state === state) return;
  current.state = state;
  send(state === "playing" ? "start" : "pause");
}

function end() {
  if (current?.state) send("stop");
  current = null;
}

async function begin(id) {
  console.info("foxkit: Netflix title", id);
  current = { id, item: null, state: null, progress: progress() };
  const watching = current;
  const item = await metadata(id);
  if (current !== watching) return;
  if (!item) {
    console.warn("foxkit: no Netflix metadata for", id);
    return;
  }
  console.info("foxkit: playing", item);
  current.item = item;
  const video = document.querySelector("video");
  if (video && !video.paused) setState("playing");
}

function check() {
  const id = watchId();
  if (id === current?.id) return;
  end();
  if (id) begin(id);
}

// Media events do not bubble, so listen in the capture phase.
const onMedia = (handler) => (event) => {
  if (!(event.target instanceof HTMLVideoElement) || watchId() !== current?.id) return;
  handler(event.target);
};

document.addEventListener("timeupdate", onMedia(() => {
  const value = progress();
  if (value !== null && current) current.progress = value;
}), true);
document.addEventListener("playing", onMedia(() => setState("playing")), true);
document.addEventListener("pause", onMedia((video) => {
  if (!video.ended) setState("paused");
}), true);
document.addEventListener("ended", onMedia(() => end()), true);
window.addEventListener("pagehide", () => end());

// The popup polls this while open, since scrobble events only carry the
// progress at the moment playback started or paused.
browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "trakt:progress" && current?.item) {
    return Promise.resolve(progress() ?? current.progress);
  }
});

console.info("foxkit: Trakt scrobbler loaded");
setInterval(check, 1000);
check();
