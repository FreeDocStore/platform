// GitHub Apps device-flow helpers.
//
// Flow (no server, no client secret, no redirect URL):
//   1. POST https://github.com/login/device/code with { client_id }
//      -> {device_code, user_code, verification_uri, interval, expires_in}
//   2. Show user_code + verification_uri to the user; they paste the code
//      at github.com/login/device and authorize the App.
//   3. Poll POST https://github.com/login/oauth/access_token every `interval`
//      seconds with the device_code until we get an access_token.
//   4. Optionally refresh via grant_type=refresh_token when the token
//      expires.
//
// All three endpoints accept `Accept: application/json`; without that header
// GitHub returns form-urlencoded bodies.
//
// Docs:
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /**
   * Same URI with user_code pre-filled as a query param. Opening this in
   * a new tab skips the "paste the code" step - GitHub jumps straight to
   * the authorize screen.
   */
  verificationUriComplete?: string;
  /** Suggested poll interval in seconds. Server may increase via slow_down. */
  interval: number;
  expiresAt: number;
}

export interface GitHubToken {
  accessToken: string;
  refreshToken?: string;
  /** ms since epoch. Access tokens default to 8h from GitHub. */
  expiresAt: number;
  scope: string;
}

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** Start the device flow. Returns the user-facing code + URI. */
export async function startDeviceFlow(clientId: string): Promise<DeviceFlowStart> {
  if (!clientId) throw new Error("Missing GitHub App client ID");
  // Use form-urlencoded rather than JSON - it's what GitHub's own docs
  // show and their login endpoints are pickier about input format than
  // their REST API.
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  // Always try to parse the body - GitHub uses 200 OK with an error field
  // on some failures and 4xx on others, and the body always has the
  // useful info.
  const rawBody = await res.text();
  let body: Record<string, string | number | undefined> = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    // Fall back to parsing as form-urlencoded, in case the Accept header
    // was ignored.
    const params = new URLSearchParams(rawBody);
    body = {};
    params.forEach((v, k) => {
      body[k] = v;
    });
  }
  if (!res.ok || body.error) {
    const msg = String(body.error_description ?? body.error ?? rawBody ?? `HTTP ${res.status}`);
    throw new Error(`Device flow start failed: ${msg}`);
  }
  // GitHub doesn't always include verification_uri_complete, so build it
  // ourselves as a fallback. Pre-filling via ?user_code is supported.
  const userCode = String(body.user_code ?? "");
  const verificationUri = String(body.verification_uri ?? "");
  const complete = body.verification_uri_complete
    ? String(body.verification_uri_complete)
    : `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri),
    verificationUriComplete: complete,
    interval: Number(body.interval ?? 5),
    expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000,
  };
}

/**
 * Poll until the user authorizes, the code expires, or the caller aborts.
 * Honors GitHub's `slow_down` response by increasing the interval.
 */
export async function pollForToken(
  clientId: string,
  deviceCode: string,
  intervalSeconds: number,
  signal?: AbortSignal
): Promise<GitHubToken> {
  let currentInterval = intervalSeconds;
  while (true) {
    await sleep(currentInterval * 1000, signal);
    if (signal?.aborted) throw abortError();

    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    });
    const body = await readJsonOrThrow(res, "POST /login/oauth/access_token");

    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      // GitHub asks us to back off a bit. Add 5s per their guidance.
      currentInterval += 5;
      continue;
    }
    if (body.error === "expired_token") {
      throw new Error("Device code expired - start the sign-in flow again");
    }
    if (body.error === "access_denied") {
      throw new Error("You denied the authorization request");
    }
    if (body.error) {
      throw new Error(`${body.error}${body.error_description ? ": " + body.error_description : ""}`);
    }

    return normaliseTokenResponse(body);
  }
}

/**
 * Exchange a refresh token for a new access token. Use when a stored
 * access_token has expired (or when an API call returns 401).
 */
export async function refreshAccessToken(
  clientId: string,
  refreshToken: string
): Promise<GitHubToken> {
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const body = await readJsonOrThrow(res, "POST /login/oauth/access_token (refresh)");
  if (body.error) {
    throw new Error(`${body.error}${body.error_description ? ": " + body.error_description : ""}`);
  }
  return normaliseTokenResponse(body);
}

/** Fetch the authenticated user's login (username) for display. */
export async function fetchAuthenticatedUser(accessToken: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GET /user failed: HTTP ${res.status}`);
  const body = (await res.json()) as { login: string };
  return body.login;
}

function normaliseTokenResponse(body: Record<string, string | number | undefined>): GitHubToken {
  // Guard against malformed responses: without this check, an undefined
  // access_token coerces to the literal string "undefined" and gets
  // cached as the user's token, then every API call returns a 401 with
  // no hint that the cause is a bogus token.
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error(
      `GitHub OAuth response missing access_token (got: ${JSON.stringify(body).slice(0, 200)})`,
    );
  }
  const expiresInSec = typeof body.expires_in === "number" ? body.expires_in : 28800;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ? String(body.refresh_token) : undefined,
    expiresAt: Date.now() + expiresInSec * 1000,
    scope: typeof body.scope === "string" ? body.scope : "",
  };
}

/** Read body once, parse as JSON if the response was OK, else throw a clear error. */
async function readJsonOrThrow(
  res: Response,
  what: string,
): Promise<Record<string, string | number | undefined>> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${what} failed: HTTP ${res.status}${text ? " " + text.slice(0, 200) : ""}`);
  }
  return (await res.json()) as Record<string, string | number | undefined>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true }
    );
  });
}

function abortError(): Error {
  const err = new Error("Sign-in cancelled");
  err.name = "AbortError";
  return err;
}
