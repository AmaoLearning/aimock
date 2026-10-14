import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SURFACE_REGISTRY } from "./drift/surface-registry.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configPath = resolve(root, "tsconfig.test.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

function relativeSource(node: ts.Node): string {
  return relative(root, node.getSourceFile().fileName).split("\\").join("/");
}

function source(path: string): ts.SourceFile {
  const file = program.getSourceFile(resolve(root, path));
  if (!file) throw new Error(`Missing adoption source: ${path}`);
  return file;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

function unalias(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function exported(path: string, name: string): ts.Symbol {
  const module = checker.getSymbolAtLocation(source(path));
  const symbol = module && checker.getExportsOfModule(module).find((entry) => entry.name === name);
  const target = unalias(symbol);
  if (!target) throw new Error(`Missing shared export: ${path}#${name}`);
  expect(
    target.declarations?.some(
      (declaration) => resolve(declaration.getSourceFile().fileName) === resolve(root, path),
    ),
    `${path}#${name} must be declared by its allocated owner`,
  ).toBe(true);
  return target;
}

function calls(node: ts.Node, target: ts.Symbol): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  walk(node, (child) => {
    if (
      ts.isCallExpression(child) &&
      unalias(checker.getSymbolAtLocation(child.expression)) === target
    )
      found.push(child);
  });
  return found;
}

function named(path: string, name: string): ts.Node {
  const found: ts.Node[] = [];
  walk(source(path), (node) => {
    if (
      ((ts.isFunctionDeclaration(node) && node.body) || ts.isVariableDeclaration(node)) &&
      node.name?.getText() === name
    )
      found.push(node);
  });
  expect(found, `${path}#${name} declaration`).toHaveLength(1);
  return found[0];
}

function declaredSymbol(node: ts.Node): ts.Symbol {
  if (!ts.isFunctionDeclaration(node) && !ts.isVariableDeclaration(node))
    throw new Error("Expected a named adoption scope");
  const symbol = node.name && checker.getSymbolAtLocation(node.name);
  if (!symbol) throw new Error(`Missing declaration symbol: ${node.getText().slice(0, 80)}`);
  return symbol;
}

function literal(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function objectFields(node: ts.Node): Map<string, ts.Expression> {
  const fields = new Map<string, ts.Expression>();
  if (!ts.isObjectLiteralExpression(node)) return fields;
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property))
      fields.set(property.name.getText().replace(/^['"]|['"]$/g, ""), property.initializer);
  }
  return fields;
}

const ownerRows = [
  ["openai-chat", "openai", ["resolve", "render"]],
  ["openrouter-chat", "openrouter", ["resolve", "render"]],
  ["openai-responses", "responses", ["render"]],
  ["openai-responses-ws", "responses", ["render"]],
  ["anthropic", "anthropic", ["resolve", "render"]],
  ["bedrock-invoke", "anthropic", ["resolve", "render"]],
  ["bedrock-invoke-stream", "anthropic", ["resolve", "render"]],
  ["gemini", "gemini", ["render"]],
  ["vertex-ai", "gemini", ["render"]],
  ["gemini-interactions", "interactions", ["render"]],
  ["cohere-chat", "cohere", ["render"]],
  ["ollama", "ollama", ["render"]],
  ["openai-realtime", "realtime", ["render"]],
  ["bedrock-converse", "converse", ["render"]],
  ["bedrock-converse-stream", "converse", ["render"]],
] as const;

// Independently frozen from the complete pre-edit registry. Only the fifteen
// allocated builderFile/builderFunctions pairs are removed from this control.
const frozenRegistryCoverage = {
  "openai-chat": {
    provider: "OpenAI Chat",
    liveCoverage: "live",
    typesFile: "src/types.ts",
  },
  "openai-responses": {
    provider: "OpenAI Responses",
    liveCoverage: "live",
    typesFile: null,
  },
  anthropic: {
    provider: "Anthropic Claude",
    liveCoverage: "live",
    typesFile: null,
  },
  "anthropic-catalog": {
    provider: "Anthropic native catalog",
    liveCoverage: "live",
    coverageNote:
      "Local catalog validation/cursor/lifecycle contracts run always. Bounded vendor comparisons require AIMOCK_NATIVE_PROVIDER_DRIFT=1 and ANTHROPIC_API_KEY; skipped comparisons establish no vendor conformance. Exact unknown-cursor behavior is undocumented.",
    builderFile: "src/response/catalog/anthropic-page.ts",
    builderFunctions: ["anthropicPage", "renderAnthropicModels"],
    typesFile: null,
  },
  "gemini-catalog": {
    provider: "Gemini native catalog",
    liveCoverage: "live",
    coverageNote:
      "Local page validation contracts run always. Bounded vendor comparisons require AIMOCK_NATIVE_PROVIDER_DRIFT=1 and GOOGLE_API_KEY; skipped comparisons establish no vendor conformance. Mock offset tokens are an implementation contract, not documented vendor tokens.",
    builderFile: "src/response/catalog/gemini-page.ts",
    builderFunctions: ["geminiPage", "renderGeminiModels"],
    typesFile: null,
  },
  "anthropic-native-errors": {
    provider: "Anthropic native authentication and version",
    liveCoverage: "live",
    coverageNote:
      "Local auth and permissive missing-version behavior run always. Bounded vendor auth/version observations require AIMOCK_NATIVE_PROVIDER_DRIFT=1; missing-version also requires ANTHROPIC_API_KEY. This records intentional default-policy divergence; it does not enforce headers.",
    builderFile: "src/response/errors.ts",
    builderFunctions: ["renderError", "writeUnauthorizedResponse"],
    typesFile: null,
  },
  "gemini-native-auth": {
    provider: "Gemini native authentication",
    liveCoverage: "live",
    coverageNote:
      "Local mock HTTP auth401 runs always. Bounded unauthenticated Developer API observations require AIMOCK_NATIVE_PROVIDER_DRIFT=1. Google API-key rejection may differ from the mock's configured inbound auth; no 401 vendor equivalence is assumed.",
    builderFile: "src/response/errors.ts",
    builderFunctions: ["renderError", "writeUnauthorizedResponse"],
    typesFile: null,
  },
  gemini: {
    provider: "Google Gemini",
    liveCoverage: "live",
    typesFile: null,
  },
  "openai-live": {
    provider: "OpenAI Live",
    liveCoverage: "live",
    coverageNote:
      "Both delegation modes exercise the primary provider WebSocket and actual aimock replay. Shapes use reviewed raw-wire descriptors; the installed OpenAI SDK has no Live types. Missing OPENAI_API_KEY skips the live legs.",
    builderFile: "src/ws-live.ts",
    builderFunctions: ["handleLiveSession"],
    typesFile: "src/live-types.ts",
    sdkShapesFile: "src/__tests__/drift/live-scenarios.ts",
  },
  "openai-realtime": {
    provider: "OpenAI Realtime",
    liveCoverage: "live",
    typesFile: null,
  },
  "openai-responses-ws": {
    provider: "OpenAI Responses WS",
    liveCoverage: "live",
    typesFile: null,
  },
  "gemini-live": {
    provider: "Gemini Live",
    liveCoverage: "live",
    builderFile: "src/ws-gemini-live.ts",
    builderFunctions: ["handleWebSocketGeminiLive"],
    typesFile: null,
  },
  "openai-embeddings": {
    provider: "OpenAI Embeddings",
    liveCoverage: "live",
    builderFile: "src/helpers.ts",
    builderFunctions: ["buildEmbeddingResponse", "generateDeterministicEmbedding"],
    typesFile: null,
    sdkShapesFile: "src/__tests__/drift/sdk-shapes.ts",
  },
  "gemini-interactions": {
    provider: "Gemini Interactions",
    liveCoverage: "live",
    typesFile: null,
  },
  "cohere-chat": {
    provider: "Cohere Chat",
    liveCoverage: "live",
    typesFile: null,
  },
  rerank: {
    provider: "Cohere Rerank",
    liveCoverage: "live",
    builderFile: "src/rerank.ts",
    builderFunctions: ["handleRerank"],
    typesFile: null,
  },
  "bedrock-invoke": {
    provider: "Bedrock Invoke",
    liveCoverage: "none",
    coverageNote:
      "No live AWS leg: nothing in this repo implements SigV4 request signing (no @aws-sdk dependency, no HMAC signer), so the Bedrock legs only drive the local mock. Offline conformance only.",
    typesFile: null,
  },
  "bedrock-invoke-stream": {
    provider: "Bedrock InvokeStream",
    liveCoverage: "none",
    coverageNote:
      "No live AWS leg — see `bedrock-invoke`. The binary event-stream frames are graded against a hand-written fixture, never against Bedrock.",
    typesFile: null,
  },
  "bedrock-converse": {
    provider: "Bedrock Converse",
    liveCoverage: "none",
    coverageNote: "No live AWS leg — see `bedrock-invoke`. Offline conformance only.",
    typesFile: null,
  },
  "bedrock-converse-stream": {
    provider: "Bedrock ConverseStream",
    liveCoverage: "none",
    coverageNote: "No live AWS leg — see `bedrock-invoke`. Offline conformance only.",
    typesFile: null,
  },
  ollama: {
    provider: "Ollama",
    liveCoverage: "live",
    typesFile: null,
  },
  "fal-sync": {
    provider: "fal.ai sync-run",
    liveCoverage: "none",
    coverageNote:
      "No live fal.ai leg: `fal.drift.ts` only drives the local mock's sync-run passthrough. The QUEUE surface (`fal-queue`) does have a live canary; this one does not.",
    builderFile: "src/fal.ts",
    builderFunctions: ["handleFal", "imageResponseToFalJson", "videoResponseToFalJson"],
    typesFile: null,
  },
  "fal-queue": {
    provider: "fal.ai queue",
    liveCoverage: "live",
    builderFile: "src/fal.ts",
    builderFunctions: ["handleFal", "walkFalQueue", "resolveProgression"],
    typesFile: null,
  },
  elevenlabs: {
    provider: "ElevenLabs",
    liveCoverage: "live",
    coverageNote:
      "Live credit rests on ONE block: the `/v1/sound-generation` case fetches `api.elevenlabs.io` and grades aimock's response envelope (status, Content-Type, body presence) against the vendor's. The body is opaque audio, so no vendor-observed JSON shape exists for any route here. `/v1/music`, `/v1/music/stream` and the 400 cases are offline conformance; `/v1/music/plan` is passthrough conformance against a test-authored fixture graded against the SDK's `MusicPrompt.Raw`, with no vendor observation.",
    builderFile: "src/elevenlabs-audio.ts",
    builderFunctions: ["handleElevenLabsTTS", "handleElevenLabsAudio"],
    typesFile: null,
  },
  "elevenlabs-voice": {
    provider: "ElevenLabs Voice Design",
    liveCoverage: "none",
    coverageNote:
      "No live ElevenLabs Voice Design leg: `elevenlabs-voice.drift.ts` only drives the local mock. A key is provided in CI (test-drift.yml and fix-drift.yml pass `secrets.ELEVENLABS_API_KEY`), but no case in that file fetches the vendor with it — these routes have no vendor leg and are offline-only — so no SUCCESSFUL response from any of these routes has ever been observed here — the shapes come from `@elevenlabs/elevenlabs-js@2.68.0` serialization types, a secondary source. Offline conformance only: it reds when aimock's own serializer changes shape, never when the vendor does. Retiring this needs a funded key and one recorded design + create round-trip; the `elevenlabs` surface's live `/v1/sound-generation` leg does NOT cover these routes.",
    builderFile: "src/elevenlabs-voice.ts",
    builderFunctions: [
      "voiceDesignToJson",
      "handleElevenLabsVoiceDesign",
      "handleElevenLabsVoiceCreate",
      "buildSyntheticVoice",
    ],
    typesFile: "src/types.ts",
  },
  images: {
    provider: "OpenAI Images",
    liveCoverage: "none",
    coverageNote:
      "No live OpenAI Images leg: `images.drift.ts` only drives the local mock. Offline conformance only. `/v1/images/variations` is out of scope entirely — the endpoint is REMOVED upstream (404, zero-byte body, observed 2026-09-15) and `handleImageVariations` now replays that removal, so it is not a response builder and must not be steered at as one; it is pinned by `image-edits.test.ts`.",
    builderFile: "src/images.ts",
    builderFunctions: ["handleImages", "handleImageEdit"],
    typesFile: null,
  },
  video: {
    provider: "OpenAI Video",
    liveCoverage: "none",
    coverageNote:
      "No live OpenAI Video leg: `video.drift.ts` only drives the local mock. Offline conformance only.",
    builderFile: "src/video.ts",
    builderFunctions: ["handleVideoCreate", "handleVideoStatus"],
    typesFile: null,
  },
  moderation: {
    provider: "OpenAI Moderations",
    liveCoverage: "none",
    coverageNote:
      "No live OpenAI Moderations leg: `moderation.drift.ts` only drives the local mock. Offline conformance only.",
    builderFile: "src/moderation.ts",
    builderFunctions: ["handleModeration"],
    typesFile: null,
  },
  transcription: {
    provider: "Transcription",
    liveCoverage: "live",
    builderFile: "src/transcription.ts",
    builderFunctions: ["handleTranscription", "extractFormField", "extractBoundary"],
    typesFile: null,
  },
  "vertex-ai": {
    provider: "Vertex AI",
    liveCoverage: "none",
    coverageNote:
      "No live Vertex leg: `vertex-ai.drift.ts` only drives the local mock's Vertex-style path. A live leg needs a GCP service account and an OAuth2 token exchange, neither of which this repo does.",
    typesFile: null,
  },
  "byteplus-video": {
    provider: "BytePlus Video",
    liveCoverage: "live",
    builderFile: "src/byteplus-video.ts",
    builderFunctions: [
      "handleBytePlusVideoCreate",
      "handleBytePlusVideoStatus",
      "proxyBytePlusVideoSubmit",
      "serializeBytePlusVideoTask",
    ],
    typesFile: null,
    sdkShapesFile: "src/__tests__/drift/byteplus-video.drift.ts",
  },
  "openrouter-video": {
    provider: "OpenRouter Video",
    liveCoverage: "live",
    builderFile: "src/openrouter-video.ts",
    builderFunctions: [
      "handleOpenRouterVideoCreate",
      "handleOpenRouterVideoStatus",
      "handleOpenRouterVideoModels",
      "handleOpenRouterVideoContent",
    ],
    typesFile: null,
  },
  "openrouter-chat": {
    provider: "OpenRouter Chat",
    liveCoverage: "live",
    typesFile: "src/types.ts",
  },
};

describe("W7 attribution", () => {
  it.each(ownerRows)("%s names its actual shared primary owner", (slug, codec, functions) => {
    const mapping = SURFACE_REGISTRY[slug];
    expect(mapping.builderFile).toBe(`src/response/usage/codecs/${codec}.ts`);
    expect(mapping.builderFunctions).toEqual(functions);
  });

  it.each(ownerRows)(
    "%s shared functions resolve to real exported declarations",
    (_slug, codec, functions) => {
      for (const name of functions) exported(`src/response/usage/codecs/${codec}.ts`, name);
    },
  );

  it("preserves every registry entry and all nonallocated coverage fields", () => {
    const allocated = new Set<string>(ownerRows.map(([slug]) => slug));
    const coverage = Object.fromEntries(
      Object.entries(SURFACE_REGISTRY).map(([slug, mapping]) => {
        const { builderFile, builderFunctions, ...other } = mapping;
        return [slug, allocated.has(slug) ? other : { builderFile, builderFunctions, ...other }];
      }),
    );
    expect(coverage).toEqual(frozenRegistryCoverage);
  });
});

const codecCallInventory = [
  ["helpers.ts", "openai", "resolve", 1],
  ["helpers.ts", "openai", "render", 1],
  ["openrouter-chat.ts", "openrouter", "resolve", 1],
  ["openrouter-chat.ts", "openrouter", "render", 1],
  ["responses.ts", "responses", "render", 5],
  ["messages.ts", "anthropic", "resolve", 11],
  ["messages.ts", "anthropic", "render", 13],
  ["bedrock.ts", "anthropic", "resolve", 5],
  ["bedrock.ts", "anthropic", "render", 5],
  ["bedrock-converse.ts", "converse", "render", 2],
  ["gemini.ts", "gemini", "render", 4],
  ["gemini-interactions.ts", "interactions", "render", 2],
  ["cohere.ts", "cohere", "render", 1],
  ["ollama.ts", "ollama", "render", 3],
  ["ws-realtime.ts", "realtime", "render", 8],
] as const;

describe("W7 aggregate usage adoption", () => {
  it.each(codecCallInventory)(
    "%s resolves all %s.%s calls to the shared declaration",
    (file, codec, name, count) => {
      expect(
        calls(source(`src/${file}`), exported(`src/response/usage/codecs/${codec}.ts`, name)),
      ).toHaveLength(count);
    },
  );

  it.each([
    ["helpers.ts", "resolveUsage", "openai", "render"],
    ["openrouter-chat.ts", "augmentUsage", "openrouter", "render"],
    ["bedrock-converse.ts", "converseUsage", "converse", "render"],
    ["gemini.ts", "geminiUsageMetadata", "gemini", "render"],
    ["gemini-interactions.ts", "interactionsUsage", "interactions", "render"],
    ["cohere.ts", "cohereUsage", "cohere", "render"],
    ["ollama.ts", "DURATION_FIELDS", "ollama", "render"],
  ])(
    "%s %s delegates its projection without rebuilding native counts",
    (file, name, codec, operation) => {
      const scope = named(`src/${file}`, name);
      const nativeCountKeys = new Set([
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "input_tokens",
        "output_tokens",
        "promptTokenCount",
        "candidatesTokenCount",
        "totalTokenCount",
        "total_input_tokens",
        "total_output_tokens",
        "prompt_eval_count",
        "eval_count",
        "billed_units",
        "tokens",
        "inputTokens",
        "outputTokens",
        "totalTokens",
      ]);
      const duplicates: string[] = [];
      walk(scope, (node) => {
        let sharedContext = false;
        for (let parent = node.parent; parent && parent !== scope; parent = parent.parent) {
          if (!ts.isCallExpression(parent)) continue;
          const declaration = unalias(checker.getSymbolAtLocation(parent.expression))
            ?.declarations?.[0];
          if (declaration && relativeSource(declaration).startsWith("src/response/usage/"))
            sharedContext = true;
        }
        if (
          !sharedContext &&
          ts.isPropertyAssignment(node) &&
          nativeCountKeys.has(node.name.getText().replace(/^['"]|['"]$/g, ""))
        )
          duplicates.push(node.getText());
      });
      expect(duplicates).toEqual([]);
      expect(
        calls(scope, exported(`src/response/usage/codecs/${codec}.ts`, operation)).length,
      ).toBeGreaterThan(0);
    },
  );

  it("covers OpenAI ordinary completions, full applied estimation and all four streaming callers", () => {
    const usage = declaredSymbol(named("src/helpers.ts", "resolveUsage"));
    for (const name of [
      "buildTextCompletion",
      "buildToolCallCompletion",
      "buildContentWithToolCallsCompletion",
      "resolveOpenAIChatMisbehaviorUsage",
    ])
      expect(calls(named("src/helpers.ts", name), usage), name).toHaveLength(1);
    const server = source("src/server.ts");
    expect(calls(server, usage)).toHaveLength(1);
    const wrapper = declaredSymbol(named("src/server.ts", "resolveStreamingUsageTokens"));
    expect(calls(server, wrapper)).toHaveLength(4);
    expect(calls(named("src/helpers.ts", "buildUsageChunk"), usage)).toEqual([]);
  });

  it("retains OpenRouter ordinary/applied augmentation callers", () => {
    const wrapper = declaredSymbol(named("src/openrouter-chat.ts", "augmentUsage"));
    expect(calls(source("src/openrouter-chat.ts"), wrapper)).toHaveLength(2);
  });

  it("covers ten ordinary Messages positions and all applied final/delta positions", () => {
    const renders = calls(
      source("src/messages.ts"),
      exported("src/response/usage/codecs/anthropic.ts", "render"),
    );
    expect(
      renders.filter((call) => literal(call.arguments[2]) === "applied-misbehavior"),
    ).toHaveLength(3);
    expect(
      renders.filter((call) => literal(call.arguments[2]) !== "applied-misbehavior"),
    ).toHaveLength(10);
    expect(
      renders
        .filter((call) => literal(call.arguments[2]) === "applied-misbehavior")
        .map((call) => literal(call.arguments[1])),
    ).toEqual(["messages-final", "messages-delta", "messages-delta"]);
  });

  it("covers Bedrock final, start and delta projections and every helper caller", () => {
    const renders = calls(
      source("src/bedrock.ts"),
      exported("src/response/usage/codecs/anthropic.ts", "render"),
    );
    expect(renders.map((call) => literal(call.arguments[1]))).toEqual([
      "bedrock-final",
      "bedrock-final",
      "bedrock-final",
      "bedrock-start",
      "bedrock-delta",
    ]);
    for (const [name, count] of [
      ["buildBedrockInvokeMessageStart", 3],
      ["buildBedrockInvokeMessageDelta", 4],
    ] as const)
      expect(
        calls(source("src/bedrock.ts"), declaredSymbol(named("src/bedrock.ts", name))),
        name,
      ).toHaveLength(count);
  });

  it.each([
    ["bedrock-converse.ts", "converseUsage", 7],
    ["gemini.ts", "geminiUsageMetadata", 9],
    ["gemini-interactions.ts", "interactionsUsage", 6],
    ["cohere.ts", "cohereUsage", 7],
  ] as const)("%s retains every ordinary %s caller", (file, name, count) => {
    expect(calls(source(`src/${file}`), declaredSymbol(named(`src/${file}`, name)))).toHaveLength(
      Number(count),
    );
  });

  it("retains the Converse prepared usage type dependency separately from its seven calls", () => {
    const wrapper = declaredSymbol(named("src/bedrock-converse.ts", "converseUsage"));
    const queries: ts.TypeQueryNode[] = [];
    walk(source("src/bedrock-converse.ts"), (node) => {
      if (ts.isTypeQueryNode(node) && checker.getSymbolAtLocation(node.exprName) === wrapper)
        queries.push(node);
    });
    expect(queries).toHaveLength(1);
  });

  it("retains all Ollama final spreads while leaving durations with transport", () => {
    const duration = declaredSymbol(named("src/ollama.ts", "DURATION_FIELDS"));
    const spreads: ts.SpreadAssignment[] = [];
    walk(source("src/ollama.ts"), (node) => {
      if (ts.isSpreadAssignment(node) && checker.getSymbolAtLocation(node.expression) === duration)
        spreads.push(node);
    });
    expect(spreads).toHaveLength(11);
    const fields = objectFields(
      (named("src/ollama.ts", "DURATION_FIELDS") as ts.VariableDeclaration).initializer!,
    );
    expect([...fields.keys()]).toEqual([
      "done_reason",
      "total_duration",
      "load_duration",
      "prompt_eval_duration",
      "eval_duration",
    ]);
  });

  it("keeps Responses HTTP and websocket ordinary/applied builders connected", () => {
    const ws = source("src/ws-responses.ts");
    for (const name of [
      "prepareResponsesMisbehavior",
      "buildResponsesMisbehavior",
      "buildTextStreamEvents",
      "toolCallStreamEvents",
      "contentWithToolCallsStreamEvents",
    ])
      expect(calls(ws, exported("src/responses.ts", name)).length, name).toBeGreaterThan(0);
    expect(calls(ws, exported("src/response/usage/codecs/responses.ts", "render"))).toEqual([]);
  });

  it("preserves all eight Realtime chat variants without taking transcription/null ownership", () => {
    const renders = calls(
      source("src/ws-realtime.ts"),
      exported("src/response/usage/codecs/realtime.ts", "render"),
    );
    expect(renders).toHaveLength(8);
    expect(
      calls(
        named("src/ws-realtime.ts", "defaultTranscriptionUsage"),
        exported("src/response/usage/codecs/realtime.ts", "render"),
      ),
    ).toEqual([]);
    const nullUsage: ts.PropertyAssignment[] = [];
    walk(source("src/ws-realtime.ts"), (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === "usage" &&
        node.initializer.kind === ts.SyntaxKind.NullKeyword
      )
        nullUsage.push(node);
    });
    expect(nullUsage.length).toBeGreaterThan(0);
  });
});

describe("W7 shared classification and finish removal", () => {
  it("keeps validator definitions and final sanitizer distinct and shared", () => {
    const definition = exported("src/response/usage/fields.ts", "getUsageFieldDefinition");
    expect(calls(source("src/fixture-loader.ts"), definition)).toHaveLength(1);
    expect(calls(named("src/response/usage/fields.ts", "sanitizeUsage"), definition)).toHaveLength(
      1,
    );
    expect(
      calls(
        source("src/response/usage/recording.ts"),
        exported("src/response/usage/fields.ts", "sanitizeUsage"),
      ),
    ).toHaveLength(1);
    expect(
      calls(
        named("src/recorder.ts", "sanitizeRecordedUsage"),
        exported("src/response/usage/recording.ts", "captureUsage"),
      ),
    ).toHaveLength(1);
  });

  it("rejects duplicated local usage classifiers and numeric-member lists", () => {
    const duplicates: string[] = [];
    for (const file of ["src/fixture-loader.ts", "src/recorder.ts", "src/stream-collapse.ts"]) {
      walk(source(file), (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          /^(USAGE_(OBJECT|BOOLEAN|FIELD)|CACHE_CREATION_|COST_DETAILS_|PROMPT_TOKENS_DETAILS_|COMPLETION_TOKENS_DETAILS_)/.test(
            node.name.getText(),
          )
        )
          duplicates.push(`${file}:${node.name.getText()}`);
        if (
          ts.isPropertyAssignment(node) &&
          ["numericMembers", "number-or-object"].includes(
            node.name.getText().replace(/^['"]|['"]$/g, ""),
          )
        )
          duplicates.push(`${file}:${node.getText()}`);
        if (
          ts.isArrayLiteralExpression(node) &&
          node.elements.filter(
            (entry) =>
              literal(entry) === "ephemeral_5m_input_tokens" ||
              literal(entry) === "ephemeral_1h_input_tokens",
          ).length === 2
        )
          duplicates.push(`${file}:${node.getText()}`);
      });
    }
    expect(duplicates).toEqual([]);
  });

  it.each([
    ["messages.ts", "claudeStopReason", "mapAnthropicFinish"],
    ["bedrock.ts", "bedrockStopReason", "mapAnthropicFinish"],
    ["bedrock-converse.ts", "converseStopReason", "mapAnthropicFinish"],
    ["responses.ts", "responsesStatus", "mapResponsesFinish"],
    ["gemini.ts", "geminiFinishReason", "mapGeminiFinish"],
    ["cohere.ts", "cohereFinishReason", "mapCohereFinish"],
  ])("%s %s delegates the finish map without retaining a local table", (file, name, shared) => {
    const scope = named(`src/${file}`, name);
    const tables: string[] = [];
    walk(scope, (node) => {
      if (
        ts.isSwitchStatement(node) ||
        ts.isObjectLiteralExpression(node) ||
        ts.isArrayLiteralExpression(node)
      )
        tables.push(node.getText());
      if (
        ts.isBinaryExpression(node) &&
        [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(
          node.operatorToken.kind,
        ) &&
        [literal(node.left), literal(node.right)].some(
          (value) => value && ["stop", "tool_calls", "length", "content_filter"].includes(value),
        )
      )
        tables.push(node.getText());
    });
    expect(tables).toEqual([]);
    expect(calls(scope, exported("src/response/finish.ts", shared))).toHaveLength(1);
  });
});

describe("W7 recording adoption", () => {
  const capture = () => exported("src/response/usage/recording.ts", "captureUsage");

  it.each([
    ["collapseOpenAISSE", "collapseOpenAISSEWithResponsesTools"],
    ["collapseStreamingResponse", "collapseStreamingResponseWithResponsesTools"],
  ])("%s preserves the public delegation through %s", (wrapper, implementation) => {
    const scope = named("src/stream-collapse.ts", wrapper);
    expect(
      calls(scope, declaredSymbol(named("src/stream-collapse.ts", implementation))),
    ).toHaveLength(1);
    expect(
      calls(scope, declaredSymbol(named("src/stream-collapse.ts", "withoutResponsesToolFields"))),
    ).toHaveLength(1);
    expect(calls(scope, capture())).toHaveLength(0);
  });

  it("rejects local capture merging and final sanitation loops in the named readers", () => {
    const duplicates: string[] = [];
    for (const name of [
      "collapseOpenAISSEWithResponsesTools",
      "collapseAnthropicSSE",
      "collapseGeminiSSE",
      "collapseOllamaNDJSON",
      "collapseCohereSSE",
      "collapseBedrockEventStream",
      "collapseGeminiInteractionsSSE",
    ]) {
      const scope = named("src/stream-collapse.ts", name);
      walk(scope, (node) => {
        if (
          !ts.isBinaryExpression(node) ||
          node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
          !ts.isIdentifier(node.left)
        )
          return;
        const binding = checker.getSymbolAtLocation(node.left);
        if (
          !binding?.declarations?.some(
            (declaration) =>
              ts.isVariableDeclaration(declaration) && declaration.name.getText() === "usage",
          )
        )
          return;
        const target = ts.isCallExpression(node.right)
          ? unalias(checker.getSymbolAtLocation(node.right.expression))
          : undefined;
        if (
          !target?.declarations?.some(
            (declaration) => relativeSource(declaration) === "src/response/usage/recording.ts",
          )
        )
          duplicates.push(`${name}:${node.getText()}`);
      });
    }
    walk(named("src/recorder.ts", "sanitizeRecordedUsage"), (node) => {
      if (ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node))
        duplicates.push(node.getText());
    });
    expect(duplicates).toEqual([]);
  });

  it.each([
    ["recorder.ts", 11],
    ["stream-collapse.ts", 9],
  ] as const)("%s retains every capture call", (file, count) => {
    expect(calls(source(`src/${file}`), capture())).toHaveLength(count);
  });

  it("retains all recognized nonstream families and final sanitation contexts", () => {
    const contexts = calls(source("src/recorder.ts"), capture()).map((call) =>
      objectFields(call.arguments[0]),
    );
    expect(
      contexts.map(
        (context) => `${literal(context.get("family"))}:${literal(context.get("stage"))}`,
      ),
    ).toEqual([
      "final:final",
      "final:final",
      "transcription:nonstream",
      "interactions:nonstream",
      "openai:nonstream",
      "anthropic:nonstream",
      "gemini:nonstream",
      "bedrock-converse:nonstream",
      "cohere:nonstream",
      "ollama:nonstream",
      "ollama:nonstream",
    ]);
  });

  it.each([
    ["collapseOpenAISSEWithResponsesTools", 2],
    ["collapseAnthropicSSE", 1],
    ["collapseGeminiSSE", 1],
    ["collapseOllamaNDJSON", 1],
    ["collapseCohereSSE", 1],
    ["collapseBedrockEventStream", 1],
    ["collapseGeminiInteractionsSSE", 1],
    ["collapseStreamingResponseWithResponsesTools", 1],
  ] as const)("%s delegates every stream/collapsed usage reader", (name, count) => {
    expect(calls(named("src/stream-collapse.ts", name), capture())).toHaveLength(Number(count));
  });

  it("routes every recognized dispatcher return through capture with unchanged precedence and fallback", () => {
    const scope = named("src/stream-collapse.ts", "collapseStreamingResponseWithResponsesTools");
    const complete = declaredSymbol(named("src/stream-collapse.ts", "complete"));
    const returns: ts.ReturnStatement[] = [];
    const contentTypes: string[] = [];
    const providers: string[] = [];
    walk(scope, (node) => {
      if (ts.isReturnStatement(node)) returns.push(node);
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "includes"
      ) {
        const text = literal(node.arguments[0]);
        if (text) contentTypes.push(text);
      }
      if (ts.isCaseClause(node)) {
        const text = literal(node.expression);
        if (text) providers.push(text);
      }
    });
    expect(contentTypes).toEqual([
      "application/vnd.amazon.eventstream",
      "application/x-ndjson",
      "text/event-stream",
    ]);
    expect(providers).toEqual([
      "openai",
      "azure",
      "openrouter",
      "byteplus",
      "anthropic",
      "gemini",
      "vertexai",
      "gemini-interactions",
      "cohere",
      "bedrock",
    ]);
    const served = returns.filter(
      (node) => node.expression && ts.isCallExpression(node.expression),
    );
    expect(served).toHaveLength(9);
    expect(
      served.every(
        (node) =>
          node.expression &&
          ts.isCallExpression(node.expression) &&
          unalias(checker.getSymbolAtLocation(node.expression.expression)) === complete,
      ),
    ).toBe(true);
    const routedFunctions = served.map((node) => {
      if (!node.expression || !ts.isCallExpression(node.expression))
        throw new Error("Missing complete return");
      const inner = node.expression.arguments[0];
      if (!ts.isCallExpression(inner)) throw new Error("Missing actual dispatcher callee");
      return unalias(checker.getSymbolAtLocation(inner.expression));
    });
    const expectedRoutes = [
      "collapseBedrockEventStream",
      "collapseOllamaNDJSON",
      "collapseOpenAISSEWithResponsesTools",
      "collapseAnthropicSSE",
      "collapseGeminiSSE",
      "collapseGeminiInteractionsSSE",
      "collapseCohereSSE",
      "collapseAnthropicSSE",
      "collapseOpenAISSEWithResponsesTools",
    ];
    expectedRoutes.forEach((name, index) => {
      expect(
        routedFunctions[index] === declaredSymbol(named("src/stream-collapse.ts", name)),
        name,
      ).toBe(true);
    });
    expect(
      returns.filter((node) => node.expression?.kind === ts.SyntaxKind.NullKeyword),
    ).toHaveLength(1);
    const context = objectFields(calls(scope, capture())[0].arguments[0]);
    expect(literal(context.get("family"))).toBe("stream-dispatch");
    expect(literal(context.get("stage"))).toBe("collapsed");
    const fallback = calls(
      scope,
      exported("src/stream-collapse.ts", "collapseOpenAISSEWithResponsesTools"),
    );
    expect(fallback).toHaveLength(2);
  });

  it("keeps capture-family precedence, accepted omission modes and sanitation in their shared owner", () => {
    const family = named("src/response/usage/recording.ts", "selectedFamily");
    const mode = named("src/response/usage/recording.ts", "mode");
    const modeCases: string[] = [];
    const contentTypes: string[] = [];
    const returnModes: string[] = [];
    const stagedModes: Array<[string | undefined, string | undefined]> = [];
    const stageConditions: ts.Expression[] = [];
    walk(family, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "includes"
      ) {
        const text = literal(node.arguments[0]);
        if (text) contentTypes.push(text);
      }
    });
    walk(mode, (node) => {
      if (ts.isCaseClause(node)) {
        const text = literal(node.expression);
        if (text) modeCases.push(text);
      }
      if (ts.isReturnStatement(node)) {
        const text = literal(node.expression);
        if (text) returnModes.push(text);
      }
      if (ts.isConditionalExpression(node)) {
        stagedModes.push([literal(node.whenTrue), literal(node.whenFalse)]);
        stageConditions.push(node.condition);
      }
    });
    expect(contentTypes).toEqual([
      "application/vnd.amazon.eventstream",
      "application/x-ndjson",
      "text/event-stream",
    ]);
    expect(modeCases).toEqual([
      "openai",
      "transcription",
      "anthropic",
      "bedrock-invoke",
      "gemini",
      "ollama",
      "cohere",
      "bedrock-converse",
      "interactions",
    ]);
    expect(returnModes).toEqual(["sanitize", "anthropic-merge", "omit"]);
    expect(stagedModes).toEqual([
      ["sanitize", "last-nonempty"],
      ["transcription-object", "last-nonempty"],
    ]);
    expect(
      stageConditions.map(
        (condition) =>
          ts.isBinaryExpression(condition) &&
          condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
          condition.left.getText() === "stage" &&
          literal(condition.right),
      ),
    ).toEqual(["nonstream", "nonstream"]);
    expect(calls(mode, declaredSymbol(family))).toHaveLength(1);
    const anthroCapture = exported("src/response/usage/codecs/anthropic.ts", "capture");
    expect(
      calls(named("src/response/usage/recording.ts", "captureUsage"), anthroCapture),
    ).toHaveLength(3);
  });
});

// Keep this suite source-bound: neither retained proof paths nor historical
// source overrides are an input to CI. Historical sensitivity runs use a
// separate read-only checkout of the same test against authentic old sources.
