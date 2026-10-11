/**
 * Unit tests for the Cohere live-leg model selection + infra classification.
 *
 * These exercise the exact logic that fixes the drift-live-pr quarantine: the
 * live leg was hardcoded to `command-r-plus`, which Cohere retired 2026-04-04,
 * so the real `/v2/chat` call returned 404 (model not found) and quarantined
 * as exit 5. The selector must skip deprecated models and pick a live one.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  cohereNoGenerationError,
  isCohereNoGenerationStreamEnd,
  isInfraStatus,
  selectCohereChatModel,
  type CohereModelEntry,
} from "./cohere-model.js";

describe("selectCohereChatModel", () => {
  it("never selects a deprecated model (the command-r-plus 404 regression)", () => {
    const models: CohereModelEntry[] = [
      { name: "command-r-plus", is_deprecated: true, endpoints: ["chat"] },
      { name: "command-a-03-2025", is_deprecated: false, endpoints: ["chat"] },
    ];
    const chosen = selectCohereChatModel(models);
    expect(chosen).not.toBe("command-r-plus");
    expect(chosen).toBe("command-a-03-2025");
  });

  it("prefers a stable default when present", () => {
    const models: CohereModelEntry[] = [
      { name: "some-experimental-model", is_deprecated: false, endpoints: ["chat"] },
      { name: "command-a-03-2025", is_deprecated: false, endpoints: ["chat"] },
    ];
    expect(selectCohereChatModel(models)).toBe("command-a-03-2025");
  });

  it("falls back to the first non-deprecated model when no preferred present", () => {
    const models: CohereModelEntry[] = [
      { name: "command-r-plus", is_deprecated: true, endpoints: ["chat"] },
      { name: "north-mini-code-1-0", is_deprecated: false, endpoints: ["chat"] },
    ];
    expect(selectCohereChatModel(models)).toBe("north-mini-code-1-0");
  });

  it("returns null when no usable chat model exists", () => {
    const models: CohereModelEntry[] = [
      { name: "command-r-plus", is_deprecated: true, endpoints: ["chat"] },
    ];
    expect(selectCohereChatModel(models)).toBeNull();
    expect(selectCohereChatModel([])).toBeNull();
  });
});

describe("isInfraStatus", () => {
  it("classifies auth/credit/rate-limit/5xx as infra (honest-skip conditions)", () => {
    for (const s of [401, 402, 403, 429, 500, 502, 503, 529]) {
      expect(isInfraStatus(s)).toBe(true);
    }
  });

  it("does NOT classify success or a genuine drift/probe error as infra", () => {
    for (const s of [200, 400, 404, 422]) {
      expect(isInfraStatus(s)).toBe(false);
    }
  });
});

describe("cohereNoGenerationError", () => {
  // Genuine live 422 body for the `Say hello` shape-leg request (2026-10-11).
  const captured = readFileSync(
    new URL("./fixtures/cohere-chat-no-valid-response.raw", import.meta.url),
    "utf8",
  );
  const body = JSON.parse(captured) as Record<string, unknown>;

  it("recognizes the genuine captured 422 no-generation envelope", () => {
    expect(cohereNoGenerationError(422, captured)).toBe("NO_VALID_RESPONSE_GENERATED");
    expect(
      cohereNoGenerationError(
        422,
        JSON.stringify({ ...body, error_type: "NO_TOOL_CALL_OR_RESPONSE_GENERATED" }),
      ),
    ).toBe("NO_TOOL_CALL_OR_RESPONSE_GENERATED");
  });

  it("rejects every other status, shape or error type", () => {
    expect(cohereNoGenerationError(200, captured)).toBeNull();
    expect(cohereNoGenerationError(400, captured)).toBeNull();
    expect(cohereNoGenerationError(422, "not json")).toBeNull();
    expect(cohereNoGenerationError(422, "[]")).toBeNull();
    expect(
      cohereNoGenerationError(422, JSON.stringify({ ...body, error_type: "OTHER" })),
    ).toBeNull();
    expect(cohereNoGenerationError(422, JSON.stringify({ ...body, id: "" }))).toBeNull();
    expect(cohereNoGenerationError(422, JSON.stringify({ ...body, message: "" }))).toBeNull();
    expect(cohereNoGenerationError(422, JSON.stringify({ ...body, extra: 1 }))).toBeNull();
    const missing = { ...body };
    delete missing.id;
    expect(cohereNoGenerationError(422, JSON.stringify(missing))).toBeNull();
  });
});

describe("isCohereNoGenerationStreamEnd", () => {
  const end = {
    finish_reason: "ERROR",
    usage: {},
    error: "No tool calls or response was generated. Try updating messages or tool definitions",
    error_type: "NO_TOOL_CALL_OR_RESPONSE_GENERATED",
  };

  it("recognizes the exact observed mid-stream terminal", () => {
    expect(isCohereNoGenerationStreamEnd(end)).toBe(true);
  });

  it("rejects any deviation", () => {
    for (const mutant of [
      { ...end, finish_reason: "COMPLETE" },
      { ...end, usage: { tokens: {} } },
      { ...end, usage: [] },
      { ...end, usage: null },
      { ...end, error: "" },
      { ...end, error_type: "NO_VALID_RESPONSE_GENERATED" },
      { ...end, extra: 1 },
      { finish_reason: "ERROR", usage: {}, error_type: end.error_type },
    ])
      expect(isCohereNoGenerationStreamEnd(mutant), JSON.stringify(mutant)).toBe(false);
  });
});
