// "Play with MPV" context menu, shown where yt-dlp has an extractor for the
// link, embedded player or page under the pointer, and on direct media files.

import { call } from "../../native.js";

const ITEM = "mpv";

// Bumped whenever a menu opens or closes, so a slow check can tell it is stale.
let menuInstance = 0;
// The URL the open menu would play.
let target = null;

export function init() {
  browser.menus.onShown.addListener(onShown);
  browser.menus.onHidden.addListener(() => {
    menuInstance++;
  });
  browser.menus.onClicked.addListener(onClicked);
}

export function createMenus() {
  browser.menus.create({
    id: ITEM,
    title: "Play with MPV",
    contexts: ["link", "video", "audio", "page", "frame"],
    documentUrlPatterns: ["http://*/*", "https://*/*"],
    visible: false,
  });
}

const isWeb = (url) => /^https?:\/\//.test(url ?? "");

// Candidates for what the user means, most specific first. A media element's
// own src is playable as is; a blob: src (YouTube and most streaming players)
// is not, so fall back to the embedding frame or page.
function candidates(info) {
  const urls = [];
  if (isWeb(info.linkUrl)) urls.push({ url: info.linkUrl });
  if (["video", "audio"].includes(info.mediaType) && isWeb(info.srcUrl)) {
    urls.push({ url: info.srcUrl, direct: true });
  }
  if (isWeb(info.frameUrl)) urls.push({ url: info.frameUrl });
  if (isWeb(info.pageUrl)) urls.push({ url: info.pageUrl });
  return urls;
}

// Not cached: the helper answers in milliseconds, and asking every time lets
// edits to ~/.config/foxkit/mpv-sites apply on the next right-click.
function isSupported(url) {
  return call("supported", { url })
    .then((reply) => reply.supported)
    .catch((error) => {
      console.error("foxkit: native helper unavailable:", error.message);
      return false;
    });
}

async function onShown(info) {
  const instance = ++menuInstance;
  target = null;

  for (const { url, direct } of candidates(info)) {
    if (direct || (await isSupported(url))) {
      target = url;
      break;
    }
    // Only a link the user clicked should hide the page behind it.
    if (url === info.linkUrl) break;
  }
  if (instance !== menuInstance) return;

  await browser.menus.update(ITEM, { visible: Boolean(target) });
  browser.menus.refresh();
}

async function onClicked(info) {
  if (info.menuItemId !== ITEM || !target) return;
  try {
    await call("play", { url: target });
  } catch (error) {
    browser.notifications.create({ type: "basic", title: "Could not start MPV", message: error.message });
  }
}
