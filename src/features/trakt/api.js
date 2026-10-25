// Trakt API client. The app is a public PKCE client, so there is no secret:
// sign-in is an authorization-code flow in a tab, and the tokens live in
// storage.local under "trakt.tokens".

const CLIENT_ID = "43PVheKWaU5QodQQWZ9IQPr09xW2wjhMKZE3kc0aELs";
const API = "https://api.trakt.tv";
const AUTHORIZE = "https://trakt.tv/oauth/authorize";
const TOKENS = "trakt.tokens";
const PENDING = "trakt.pendingLogin";

// Refresh this long before the access token expires.
const REFRESH_MARGIN = 60 * 60 * 1000;

export class TraktError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const redirectUri = () => browser.identity.getRedirectURL();

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const randomString = (length) => base64url(crypto.getRandomValues(new Uint8Array(length)));

// Opens Trakt's sign-in in a tab. The background script can be suspended
// while the user types, which would lose an identity.launchWebAuthFlow in
// flight, so the PKCE verifier waits in storage.session and finishLogin()
// picks up the redirect, caught by a webRequest listener that wakes it.
export async function login() {
  const verifier = randomString(48);
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = randomString(16);
  await browser.storage.session.set({ [PENDING]: { verifier, state } });

  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  await browser.tabs.create({ url: url.href });
}

// The URL pattern of Trakt's redirect back after sign-in.
export const redirectPattern = () => `${redirectUri()}*`;

export async function finishLogin(redirect) {
  const pending = (await browser.storage.session.get(PENDING))[PENDING];
  await browser.storage.session.remove(PENDING);
  const params = new URL(redirect).searchParams;
  if (!pending || params.get("state") !== pending.state) throw new Error("sign-in expired, try again");
  const code = params.get("code");
  if (!code) throw new Error(params.get("error_description") ?? params.get("error") ?? "no code returned");

  await saveTokens(
    await token({ grant_type: "authorization_code", code, code_verifier: pending.verifier }),
  );
}

export async function logout() {
  const tokens = await loadTokens();
  await browser.storage.local.remove(TOKENS);
  if (tokens) {
    fetch(`${API}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokens.access_token, client_id: CLIENT_ID }),
    }).catch(() => {});
  }
}

export async function isLoggedIn() {
  return Boolean(await loadTokens());
}

async function loadTokens() {
  return (await browser.storage.local.get(TOKENS))[TOKENS] ?? null;
}

async function saveTokens(reply) {
  await browser.storage.local.set({
    [TOKENS]: {
      access_token: reply.access_token,
      refresh_token: reply.refresh_token,
      expires_at: (reply.created_at + reply.expires_in) * 1000,
    },
  });
}

async function token(params) {
  const response = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, redirect_uri: redirectUri(), ...params }),
  });
  if (!response.ok) throw new TraktError(response.status, `Trakt token request failed (${response.status})`);
  return response.json();
}

// Concurrent requests share one refresh, since a refresh token works once.
let refreshing = null;

function refresh(tokens) {
  refreshing ??= token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })
    .then(saveTokens)
    .catch(async (error) => {
      // A rejected refresh token means signing in again.
      if (error.status === 400 || error.status === 401) await browser.storage.local.remove(TOKENS);
      throw error;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function accessToken({ force = false } = {}) {
  let tokens = await loadTokens();
  if (!tokens) throw new TraktError(401, "Not signed in to Trakt");
  if (force || Date.now() > tokens.expires_at - REFRESH_MARGIN) {
    await refresh(tokens);
    tokens = await loadTokens();
  }
  return tokens.access_token;
}

// Calls the API, signed in when `auth` is set. Resolves to the parsed body,
// or null for an empty one.
export async function request(method, path, { body, auth = true } = {}) {
  for (let attempt = 0; ; attempt++) {
    const headers = {
      "Content-Type": "application/json",
      "trakt-api-version": "2",
      "trakt-api-key": CLIENT_ID,
    };
    if (auth) headers.Authorization = `Bearer ${await accessToken({ force: attempt > 0 })}`;

    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body && JSON.stringify(body),
    });
    if (response.status === 401 && auth && attempt === 0) continue;
    if (!response.ok) throw new TraktError(response.status, `Trakt ${method} ${path} failed (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}
