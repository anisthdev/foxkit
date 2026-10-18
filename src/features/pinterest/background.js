// "Download image" context menu on Pinterest, offering the largest resized
// copy and the original upload of the image under the pointer.
//
// i.pinimg.com serves one image at /<size>/<aa>/<bb>/<cc>/<hash>.<ext>.
// Resized copies are always JPEG; "originals" keeps the uploaded format, so
// its extension has to be probed. Missing variants answer 403.

const PAGES = [
  "https://*.pinterest.com/*",
  "https://*.pinterest.co.uk/*",
  "https://*.pinterest.ca/*",
  "https://*.pinterest.com.au/*",
  "https://*.pinterest.de/*",
  "https://*.pinterest.fr/*",
  "https://*.pinterest.es/*",
  "https://*.pinterest.it/*",
  "https://*.pinterest.jp/*",
  "https://*.pinterest.com.mx/*",
];

// Resized widths the CDN keeps, largest first.
const WIDTHS = ["1200x", "736x", "564x", "474x", "236x"];

const PARENT = "pinterest";
const LARGEST = "pinterest:largest";
const ORIGINAL = "pinterest:original";
const PINIMG = /^https:\/\/i\.pinimg\.com\/[^/]+\/((?:[0-9a-f]{2}\/){3}([0-9a-f]+))\.(\w+)$/;

// The image the open menu is about: { hash, variants: Promise<{ largest, original }> }.
let current = null;
// Bumped whenever a menu opens or closes, so a slow probe can tell it is stale.
let menuInstance = 0;

const probeCache = new Map();

export function init() {
  browser.menus.onShown.addListener(onShown);
  browser.menus.onHidden.addListener(() => {
    menuInstance++;
  });
  browser.menus.onClicked.addListener(onClicked);
}

export function createMenus() {
  browser.menus.create({
    id: PARENT,
    title: "Download image",
    contexts: ["all"],
    documentUrlPatterns: PAGES,
    visible: false,
  });
  browser.menus.create({ id: LARGEST, parentId: PARENT, title: "Largest", contexts: ["all"] });
  browser.menus.create({ id: ORIGINAL, parentId: PARENT, title: "Original", contexts: ["all"] });
}

function parse(url) {
  const match = PINIMG.exec(url);
  return match && { path: match[1], hash: match[2], ext: match[3] };
}

async function onShown(info, tab) {
  const instance = ++menuInstance;
  current = null;

  let image = null;
  if (tab && /^https:\/\/([^/]+\.)?pinterest\.[^/]+\//.test(info.pageUrl ?? "")) {
    try {
      const url = await browser.tabs.sendMessage(tab.id, { type: "pinterest:get-image" }, { frameId: info.frameId });
      image = url && parse(url);
    } catch {
      // Content script not injected (tab opened before install); leave hidden.
    }
  }
  if (instance !== menuInstance) return;

  if (!image) {
    await browser.menus.update(PARENT, { visible: false });
    browser.menus.refresh();
    return;
  }

  current = { hash: image.hash, variants: probe(image) };
  await Promise.all([
    browser.menus.update(PARENT, { visible: true }),
    browser.menus.update(LARGEST, { visible: true, enabled: false, title: "Largest" }),
    browser.menus.update(ORIGINAL, { visible: true, enabled: false, title: "Original" }),
  ]);
  browser.menus.refresh();

  const { largest, original } = await current.variants;
  if (instance !== menuInstance) return;
  await Promise.all([
    browser.menus.update(
      LARGEST,
      largest ? { enabled: true, title: `${parseInt(largest.size)} px` } : { visible: false },
    ),
    browser.menus.update(
      ORIGINAL,
      original ? { enabled: true, title: `Original (${original.ext.toUpperCase()})` } : { visible: false },
    ),
  ]);
  browser.menus.refresh();
}

// Resolves to { largest, original }, each { size, ext, url } or null when the
// CDN has no such copy.
function probe({ path, ext }) {
  if (!probeCache.has(path)) {
    probeCache.set(
      path,
      Promise.all([
        first(WIDTHS.map((size) => variant(size, path, "jpg"))),
        first([...new Set([ext, "jpg", "png", "webp", "gif"])].map((e) => variant("originals", path, e))),
      ]).then(([largest, original]) => ({ largest, original })),
    );
  }
  return probeCache.get(path);
}

function variant(size, path, ext) {
  return { size, ext, url: `https://i.pinimg.com/${size}/${path}.${ext}` };
}

// The first candidate that exists, checked in order.
async function first(candidates) {
  for (const candidate of candidates) {
    if (await exists(candidate.url)) return candidate;
  }
  return null;
}

async function exists(url) {
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "manual" });
    return response.ok;
  } catch {
    return false;
  }
}

async function onClicked(info) {
  if (![LARGEST, ORIGINAL].includes(info.menuItemId) || !current) return;
  const { hash } = current;
  const { largest, original } = await current.variants;
  const chosen = info.menuItemId === LARGEST ? largest : original;
  if (!chosen) return;

  const name = chosen === original ? "original" : chosen.size;
  try {
    await browser.downloads.download({ url: chosen.url, filename: `Pinterest/${hash}_${name}.${chosen.ext}` });
  } catch (error) {
    browser.notifications.create({ type: "basic", title: "Download failed", message: error.message });
  }
}
