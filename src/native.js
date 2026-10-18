// Request/reply calls to the native helper (native/foxkit_host.py) over one
// long-lived port, so Python and yt-dlp are loaded once rather than per call.

let port = null;
let nextId = 0;
const pending = new Map();

function connect() {
  port = browser.runtime.connectNative("foxkit");
  port.onMessage.addListener(({ id, ...reply }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (reply.error) request.reject(new Error(reply.error));
    else request.resolve(reply);
  });
  port.onDisconnect.addListener((p) => {
    const error = new Error(p.error?.message ?? "native helper disconnected");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    port = null;
  });
}

export function call(type, payload = {}) {
  if (!port) connect();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    port.postMessage({ id, type, ...payload });
  });
}
