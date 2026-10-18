// Pinterest lays transparent overlays over most images, so the right-click
// target is rarely the <img>. Remember the pinimg image under the pointer
// instead, and hand it to the background script when the menu opens.

const PINIMG = /^https:\/\/i\.pinimg\.com\//;

let lastImage = null;

function imageUrl(img) {
  // srcset lists every size; any of them carries the image's path.
  const src = img.currentSrc || img.src;
  return PINIMG.test(src) ? src : null;
}

document.addEventListener(
  "contextmenu",
  (event) => {
    lastImage = null;
    for (const el of document.elementsFromPoint(event.clientX, event.clientY)) {
      const img = el instanceof HTMLImageElement ? el : el.querySelector?.(":scope > img");
      const url = img && imageUrl(img);
      if (url) {
        lastImage = url;
        break;
      }
    }
  },
  true,
);

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "pinterest:get-image") {
    return Promise.resolve(lastImage);
  }
});
