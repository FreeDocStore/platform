
// ── shared memory (Phase 2A: read MEMORY.md) ────────────────────────

test("formatMemoryBlock: empty / null content -> empty string", () => {
  assert.equal(formatMemoryBlock(null), "");
  assert.equal(formatMemoryBlock(""), "");
  assert.equal(formatMemoryBlock("   \n\n  "), "");
});

test("formatMemoryBlock: small content rendered with header", () => {
  const out = formatMemoryBlock("## Style\n- Use sentence case in headings.");
  assert.match(out, /Shared team memory.*\.docs-chat\/MEMORY\.md/);
  assert.match(out, /## Style/);
  assert.match(out, /sentence case/);
});

test("formatMemoryBlock: caps at 200 lines", () => {
  // 300 lines of "x" - the cap should drop to first 200.
  const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const out = formatMemoryBlock(big);
  assert.ok(out.includes("line 0"));
  assert.ok(out.includes("line 199"));
  assert.ok(!out.includes("line 200"), "line 200 must be cut by the line cap");
});

test("formatMemoryBlock: caps at 25KB", () => {
  // One huge line so the line cap doesn't help.
  const huge = "x".repeat(40_000);
  const out = formatMemoryBlock(huge);
  assert.ok(out.includes("[...memory truncated at 25KB...]"));
  assert.ok(out.length < huge.length, "output must be smaller than input");
});

test("openai adapter: memory.md is fetched and injected before the activity log", async () => {
  let capturedSystem = null;
  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        capturedSystem = JSON.parse(init.body).messages[0].content;
        return { body: { choices: [{ message: { content: "ok" } }] } };
      },
    ],
    // Memory file at .docs-chat/MEMORY.md
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      () => ({
        body: {
          content: b64("## Style\n- always use sentence case"),
          sha: "memsha",
          path: MEMORY_PATH,
          encoding: "base64",
        },
      }),
    ],
    // Activity log
    [
      /\/repos\/[^/]+\/[^/]+\/commits/,
      () => ({
        body: [
          {
            sha: "x1",
            commit: { author: { name: "Sergey", date: "2026-04-17T10:00:00Z" }, message: "fix typo" },
            author: { login: "sergey-ivochkin" },
          },
        ],
      }),
    ],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const settings = {
      adapter: "openai",
      mode: "read",
      openai: { apiKey: "sk-test", model: "gpt-5.4" },
      claude: { apiKey: "", model: "claude-sonnet-4-6", githubToken: "ghp_test" },
    };
    await openaiAdapter.chat("hi", CONTEXT, [], settings);
    assert.ok(capturedSystem);
    // Memory must appear, AND it must come before the activity log so
    // the model anchors on durable facts first.
    const memIdx = capturedSystem.indexOf("Shared team memory");
    const actIdx = capturedSystem.indexOf("Recent docs activity");
    assert.ok(memIdx >= 0, `expected memory block, got: ${capturedSystem.slice(0, 200)}`);
    assert.ok(actIdx >= 0, "expected activity block");
    assert.ok(memIdx < actIdx, "memory must appear before activity log");
    assert.match(capturedSystem, /always use sentence case/);
  } finally {
    restore();
  }
});

test("openai adapter: missing MEMORY.md is treated as empty (no header injected)", async () => {
  let capturedSystem = null;
  const handlers = [
    [
      "openai.com",
      ({ init }) => {
        capturedSystem = JSON.parse(init.body).messages[0].content;
        return { body: { choices: [{ message: { content: "ok" } }] } };
      },
    ],
    // GitHub returns 404 for the memory file
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      () => ({ status: 404, body: { message: "Not Found" } }),
    ],
    [/\/repos\/[^/]+\/[^/]+\/commits/, () => ({ body: [] })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const settings = {
      adapter: "openai",
      mode: "read",
      openai: { apiKey: "sk-test", model: "gpt-5.4" },
      claude: { apiKey: "", model: "claude-sonnet-4-6", githubToken: "ghp_test" },
    };
    await openaiAdapter.chat("hi", CONTEXT, [], settings);
    assert.ok(capturedSystem);
    assert.ok(!/Shared team memory/.test(capturedSystem),
      "no memory header when MEMORY.md is missing");
  } finally {
    restore();
  }
});

// ── mergeMemoryEntry: pure-function unit tests ─────────────────────

test("mergeMemoryEntry: empty input creates a fresh skeleton with the entry", () => {
  const out = mergeMemoryEntry("", "Headings use sentence case.", "Style");
  assert.match(out, /^# Shared docs-chat memory/);
  assert.match(out, /## Style\n- Headings use sentence case\./);
});

test("mergeMemoryEntry: empty section name falls back to 'Notes'", () => {
  // "" / undefined / "   " all defaulted to Notes.
  for (const section of ["", undefined, "   "]) {
    const out = mergeMemoryEntry("", "fact", section);
    assert.match(out, /## Notes\n- fact/, `failed for section=${JSON.stringify(section)}`);
  }
});

test("mergeMemoryEntry: appends to an existing section's bullet list", () => {
  const current = "# Memory\n\n## Style\n- old bullet\n";
  const out = mergeMemoryEntry(current, "new bullet", "Style");
  assert.match(out, /- old bullet\n- new bullet/);
  // Old bullet must still be there.
  assert.ok(out.includes("- old bullet"));
});

test("mergeMemoryEntry: new entry inserts before the next section, not at file end", () => {
  // Regression: a naive "append at end" would put the new bullet under
  // the wrong section. mergeMemoryEntry must insert just after the last
  // bullet of the target section, before the next ## header.
  const current = [
    "# Memory",
    "",
    "## Style",
    "- A",
    "- B",
    "",
    "## Voice",
    "- voice rule",
    "",
  ].join("\n");
  const out = mergeMemoryEntry(current, "C", "Style");
  // C must appear inside the Style section, not the Voice section.
  const styleIdx = out.indexOf("## Style");
  const voiceIdx = out.indexOf("## Voice");
  const cIdx = out.indexOf("- C");
  assert.ok(cIdx > styleIdx && cIdx < voiceIdx,
    `expected '- C' between Style and Voice, got: ${out}`);
});

test("mergeMemoryEntry: missing section is created at end of file", () => {
  const current = "# Memory\n\n## Style\n- A\n";
  const out = mergeMemoryEntry(current, "ops fact", "Ops");
  // Style section unchanged
  assert.match(out, /## Style\n- A/);
  // Ops appended after
  assert.match(out, /## Ops\n- ops fact/);
  assert.ok(out.indexOf("## Ops") > out.indexOf("## Style"));
});

test("mergeMemoryEntry: empty section header (just '##') is created cleanly", () => {
  // Empty bullet list: section exists but no bullets yet. Must insert
  // right after the header, not at end of file.
  const current = "# Memory\n\n## Style\n\n## Voice\n- v\n";
  const out = mergeMemoryEntry(current, "first style fact", "Style");
  const styleIdx = out.indexOf("## Style");
  const voiceIdx = out.indexOf("## Voice");
  const factIdx = out.indexOf("- first style fact");
  assert.ok(factIdx > styleIdx && factIdx < voiceIdx);
});

test("mergeMemoryEntry: trims surrounding whitespace from the entry", () => {
  const out = mergeMemoryEntry("", "   leading + trailing\n  ", "Notes");
  assert.match(out, /- leading \+ trailing\n/);
  assert.ok(!out.includes("-    leading"), "leading whitespace must be stripped");
});

// ── cache invalidation after Apply (regression) ─────────────────────

test("openai adapter: applying a memory entry invalidates memoryCache", async () => {
  // Real bug: after applying a memory entry, the next chat turn would
  // load the cached pre-apply MEMORY.md for up to 5 min, so the model
  // wouldn't know the entry it just added existed. invalidateCachesAfterApply
  // drops the cache key on success.
  let memoryFetches = 0;
  const handlers = [
    [
      "openai.com",
      () => ({
        body: {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    function: {
                      name: "remember",
                      arguments: JSON.stringify({ entry: "fact A", section: "Notes" }),
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    ],
    [/repos\/[^/]+\/[^/]+$/, () => ({ body: { default_branch: "main" } })],
    [
      /\/contents\/docs\/index\.html/,
      () => ({ body: { content: b64(HTML), sha: "filesha", path: SOURCE_PATH, encoding: "base64" } }),
    ],
    [
      /\/contents\/\.docs-chat\/MEMORY\.md/,
      ({ init }) => {
        if (!init || init.method === "GET" || init.method === undefined) {
          memoryFetches++;
          return { status: 404, body: { message: "Not Found" } };
        }
        return { body: { commit: { sha: "memcommit", html_url: "https://github.com/x/y/commit/memcommit" } } };
      },
    ],
    [/git\/refs$/, () => ({ body: { ref: "refs/heads/feature" } })],
    [/\/pulls$/, () => ({ body: { number: 1, url: "api", html_url: "https://github.com/x/y/pull/1" } })],
    [/\/git\/ref\/heads\//, () => ({ body: { object: { sha: "basesha" } } })],
    [/\/repos\/[^/]+\/[^/]+\/commits/, () => ({ body: [] })],
  ];
  const { restore } = installFetchMock(handlers);
  try {
    const ctx = { ...CONTEXT, repo: { owner: "Other", name: "memcache-invalidate" } };
    const settings = baseSettings("pr");

    // Turn 1: chat triggers a memory preview. memoryFetches goes up by 1
    // (the system-context load) plus 1 (the buildMemoryProposalPreview fetch).
    const reply = await openaiAdapter.chat("remember fact A", ctx, [], settings);
    const before = memoryFetches;
    assert.ok(before >= 1, "expected at least one memory fetch from chat");

    // Turn 2: apply. Should clear the cache.
    const stored = await loadPendingProposal(reply.attachment.data.proposalId);
    const { GitHubClient } = await import(await bundle("src/lib/github.ts"));
    const gh = await GitHubClient.fromSettings(settings);
    await applyPendingProposal(stored, gh);

    // Turn 3: chat again. Without invalidation, getRepoMemory would
    // return the cached null and skip the GET. With invalidation, it
    // refetches - we should see at least one new fetch.
    await openaiAdapter.chat("hi", ctx, [], settings);
    assert.ok(memoryFetches > before,
      `expected memoryFetches to grow after apply (was ${before}, now ${memoryFetches})`);
  } finally {
    restore();
  }
});
