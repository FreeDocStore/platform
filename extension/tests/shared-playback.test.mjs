import { test } from "node:test";
import assert from "node:assert/strict";
import { bundle } from "./_bundle.mjs";

const { registerPlaybackStop, stopSharedPlayback } = await import(await bundle("src/sidepanel/shared-playback.ts"));

test("thread-switch interruption stops the shared narration source and restores its action", () => {
  let stopped = 0;
  let action = "Stop";
  registerPlaybackStop(() => { stopped++; action = "Listen"; });
  stopSharedPlayback();
  assert.equal(stopped, 1);
  assert.equal(action, "Listen");
});
