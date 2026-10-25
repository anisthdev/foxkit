// Each feature registers its own listeners; add new ones here.
import * as mpv from "./features/mpv/background.js";
import * as pinterest from "./features/pinterest/background.js";
import * as trakt from "./features/trakt/background.js";

const features = [pinterest, mpv, trakt];

for (const feature of features) feature.init();

// Firefox persists menu items of event-page extensions across restarts and
// reloads, so stale entries from an older version would linger beside the
// new ones. Rebuild them from scratch on every start.
browser.menus.removeAll().then(() => {
  for (const feature of features) feature.createMenus();
});
