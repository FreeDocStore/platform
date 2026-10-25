import { expect, it } from "vitest";
import { MCP_ACCESS_TOKEN_TTL_SECONDS } from "./oauth-config.js";

it("defaults MCP access tokens to 30 days", () => {
  expect(MCP_ACCESS_TOKEN_TTL_SECONDS).toBe(30 * 86_400);
});
