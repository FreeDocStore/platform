// GitHub device-flow tests. Mocks global fetch so no real GitHub traffic
// leaves the test runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const {
  startDeviceFlow,
  pollForToken,
  refreshAccessToken,
  fetchAuthenticatedUser,
} = await import(await bundle("src/auth/github-device.ts"));

const CLIENT_ID = "Iv23li-test";

function installFetchMock(responses) {
  const calls = [];
  const queue = [...responses];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = queue.shift();
    if (!next) throw new Error(`No mock response queued for ${url}`);
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status ?? 200 });
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("startDeviceFlow parses the device_code response", async () => {
  const { calls, restore } = installFetchMock([
    {
      body: {
        device_code: "devicecode",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      },
    },
  ]);
  try {
    const start = await startDeviceFlow(CLIENT_ID);
    assert.equal(start.deviceCode, "devicecode");
    assert.equal(start.userCode, "ABCD-1234");
    assert.equal(start.verificationUri, "https://github.com/login/device");
    assert.equal(start.interval, 5);
    assert.ok(start.expiresAt > Date.now());
    assert.equal(calls[0].url, "https://github.com/login/device/code");
    assert.equal(calls[0].init.method, "POST");
    assert.ok(calls[0].init.body.includes(CLIENT_ID));
  } finally {
    restore();
  }
});

test("startDeviceFlow throws without a client ID", async () => {
  await assert.rejects(() => startDeviceFlow(""), /client ID/i);
});

test("pollForToken returns the token after authorization", async () => {
  const { restore } = installFetchMock([
    { body: { error: "authorization_pending" } },
    { body: { error: "authorization_pending" } },
    {
      body: {
        access_token: "gho_abc",
        refresh_token: "ghr_def",
        expires_in: 28800,
        scope: "repo",
      },
    },
  ]);
  try {
    const token = await pollForToken(CLIENT_ID, "devcode", 0); // interval 0s for speed
    assert.equal(token.accessToken, "gho_abc");
    assert.equal(token.refreshToken, "ghr_def");
    assert.equal(token.scope, "repo");
    assert.ok(token.expiresAt > Date.now());
  } finally {
    restore();
  }
});

test("pollForToken honors slow_down and backs off", async () => {
  const { calls, restore } = installFetchMock([
    { body: { error: "slow_down" } },
    {
      body: {
        access_token: "gho_abc",
        expires_in: 28800,
      },
    },
  ]);
  try {
    const t0 = Date.now();
    await pollForToken(CLIENT_ID, "devcode", 0);
    // slow_down adds 5s; with interval=0 the second poll should be ~5s later.
    // We assert >=4500ms to avoid flakes.
    assert.ok(Date.now() - t0 >= 4500);
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test("pollForToken surfaces expired_token as a clear message", async () => {
  const { restore } = installFetchMock([{ body: { error: "expired_token" } }]);
  try {
    await assert.rejects(() => pollForToken(CLIENT_ID, "devcode", 0), /expired/i);
  } finally {
    restore();
  }
});

test("pollForToken surfaces access_denied", async () => {
  const { restore } = installFetchMock([{ body: { error: "access_denied" } }]);
  try {
    await assert.rejects(() => pollForToken(CLIENT_ID, "devcode", 0), /denied/i);
  } finally {
    restore();
  }
});

test("pollForToken can be aborted mid-flight", async () => {
  const { restore } = installFetchMock([
    { body: { error: "authorization_pending" } },
    { body: { error: "authorization_pending" } },
  ]);
  try {
    const ac = new AbortController();
    const p = pollForToken(CLIENT_ID, "devcode", 10, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(() => p, /cancel|abort/i);
  } finally {
    restore();
  }
});

test("refreshAccessToken trades a refresh token for a new access token", async () => {
  const { calls, restore } = installFetchMock([
    {
      body: {
        access_token: "gho_new",
        refresh_token: "ghr_new",
        expires_in: 28800,
      },
    },
  ]);
  try {
    const t = await refreshAccessToken(CLIENT_ID, "ghr_old");
    assert.equal(t.accessToken, "gho_new");
    assert.equal(t.refreshToken, "ghr_new");
    assert.ok(calls[0].init.body.includes("refresh_token"));
    assert.ok(calls[0].init.body.includes("ghr_old"));
  } finally {
    restore();
  }
});

test("fetchAuthenticatedUser pulls the login from GET /user", async () => {
  const { calls, restore } = installFetchMock([
    { body: { login: "serge-ivo", name: "Sergey Ivochkin" } },
  ]);
  try {
    const login = await fetchAuthenticatedUser("gho_abc");
    assert.equal(login, "serge-ivo");
    assert.equal(calls[0].url, "https://api.github.com/user");
    assert.equal(calls[0].init.headers.Authorization, "Bearer gho_abc");
  } finally {
    restore();
  }
});

test("fetchAuthenticatedUser throws on non-2xx", async () => {
  const { restore } = installFetchMock([{ body: {}, status: 401 }]);
  try {
    await assert.rejects(() => fetchAuthenticatedUser("bad"), /401/);
  } finally {
    restore();
  }
});
