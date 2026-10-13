import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { mapAnthropicFinish } from "../response/finish.js";

describe("Anthropic finish source ownership", () => {
  it.each([
    ["messages.ts", "claudeStopReason"],
    ["bedrock.ts", "bedrockStopReason"],
    ["bedrock-converse.ts", "converseStopReason"],
  ])("%s retains its falsy default and delegates the mapping", (name, wrapper) => {
    const path = fileURLToPath(new URL(`../${name}`, import.meta.url));
    const file = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const bindings = file.statements.flatMap((statement) => {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        resolve(dirname(path), statement.moduleSpecifier.text) !==
          resolve(dirname(path), "response/finish.js")
      )
        return [];
      const named = statement.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) return [];
      return named.elements
        .filter((binding) => (binding.propertyName ?? binding.name).text === "mapAnthropicFinish")
        .map((binding) => binding.name.text);
    });
    const declaration = file.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === wrapper,
    );
    expect(declaration?.body?.statements).toHaveLength(2);
    const returned = declaration?.body?.statements[1];
    expect(returned && ts.isReturnStatement(returned)).toBe(true);
    if (
      !returned ||
      !ts.isReturnStatement(returned) ||
      !returned.expression ||
      !ts.isCallExpression(returned.expression) ||
      !ts.isIdentifier(returned.expression.expression)
    )
      throw new Error("finish wrapper must return the imported mapping call");
    expect(bindings).toContain(returned.expression.expression.text);
    expect(returned.expression.arguments).toHaveLength(1);
  });
});

describe("Anthropic finish owner", () => {
  it.each([
    ["stop", "end_turn"],
    ["tool_calls", "tool_use"],
    ["length", "max_tokens"],
    ["future_reason", "future_reason"],
    ["", ""],
    ["end_turn", "end_turn"],
  ])("maps %j to %j without choosing a caller default", (reason, expected) => {
    expect(mapAnthropicFinish(reason)).toBe(expected);
  });
});
