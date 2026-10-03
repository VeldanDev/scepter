import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectMcp } from "../src/mcp-detect.js";

describe("detectMcp", () => {
  it("matches 'mcp' in the name", () => {
    assert.equal(detectMcp("some-mcp-server", null), true);
  });

  it("is case-insensitive", () => {
    assert.equal(detectMcp("MCP-Server", null), true);
    assert.equal(detectMcp("Weather", "Model Context Protocol server"), true);
    assert.equal(detectMcp("Weather", "MODEL-CONTEXT-PROTOCOL"), true);
  });

  it("matches 'model context', 'model-context' and 'modelcontextprotocol'", () => {
    assert.equal(detectMcp("weather", "A Model Context server"), true);
    assert.equal(detectMcp("weather", "A model-context server"), true);
    assert.equal(detectMcp("modelcontextprotocol-something", null), true);
  });

  it("matches in tags", () => {
    assert.equal(detectMcp("weather", null, ["forecast", "mcp-server"]), true);
  });

  it("matches the description when the name is unrelated", () => {
    assert.equal(detectMcp("weather-api", "Query live forecasts via MCP"), true);
  });

  it("returns false when nothing matches", () => {
    assert.equal(detectMcp("weather-api", "Live weather forecasts", ["forecast", "weather"]), false);
  });

  it("handles a null description", () => {
    assert.equal(detectMcp("weather-api", null), false);
  });

  it("handles empty tags", () => {
    assert.equal(detectMcp("weather-api", null, []), false);
  });

  it("matches on substrings (documented heuristic behavior)", () => {
    assert.equal(detectMcp("mcphost", null), true);
  });
});
