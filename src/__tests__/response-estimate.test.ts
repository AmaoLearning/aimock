import { existsSync, readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { estimatePromptTokens, estimateTokens } from "../helpers.js";
import type { ChatCompletionRequest } from "../types.js";

describe("token estimation leaf ownership", () => {
  it("helpers delegate both estimators to a type-only dependency leaf", () => {
    const helperSource = ts.createSourceFile(
      "helpers.ts",
      readFileSync(new URL("../helpers.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const [name, owner] of [
      ["estimateTokens", "estimateUsageTokens"],
      ["estimatePromptTokens", "estimateUsagePromptTokens"],
    ]) {
      const fn = helperSource.statements.find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
      expect(fn?.body?.statements).toHaveLength(1);
      const statement = fn?.body?.statements[0];
      expect(
        statement &&
          ts.isReturnStatement(statement) &&
          statement.expression &&
          ts.isCallExpression(statement.expression) &&
          ts.isIdentifier(statement.expression.expression) &&
          statement.expression.expression.text === owner,
      ).toBe(true);
    }
    const leafPath = new URL("../response/usage/estimate.ts", import.meta.url);
    expect(existsSync(leafPath)).toBe(true);
    const leaf = ts.createSourceFile(
      "estimate.ts",
      readFileSync(leafPath, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = leaf.statements.filter(ts.isImportDeclaration);
    expect(imports).toHaveLength(1);
    expect(imports[0]?.importClause?.isTypeOnly).toBe(true);
    expect(imports[0]?.moduleSpecifier.getText(leaf)).toBe('"../../types.js"');
  });
});

describe("existing token estimates", () => {
  it.each([
    ["", 1],
    ["abcd", 1],
    ["abcde", 2],
    ["abcdefgh", 2],
    ["😀😀😀", 2],
  ])("preserves character estimation for %j", (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens);
  });

  it.each<{ name: string; messages: ChatCompletionRequest["messages"]; tokens: number }>([
    { name: "empty", messages: [], tokens: 1 },
    {
      name: "strings",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
      tokens: 3,
    },
    {
      name: "multimodal",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "abcdefghi" },
            { type: "image_url", image_url: { url: "https://example.invalid/image" } },
          ],
        },
      ],
      tokens: 3,
    },
  ])("preserves $name prompt estimation", ({ messages, tokens }) => {
    expect(estimatePromptTokens(messages)).toBe(tokens);
  });
});
