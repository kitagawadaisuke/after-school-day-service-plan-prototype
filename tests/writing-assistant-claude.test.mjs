import test from "node:test";
import assert from "node:assert/strict";
import { createWritingAssistant } from "../server/services/writing-assist.js";

test("Claudeを文章補助プロバイダーとして呼び出せる", async () => {
  let request;
  const assistant = createWritingAssistant({
    provider: "anthropic",
    apiKey: "test-anthropic-key",
    model: "claude-opus-5",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        content: [{ type: "text", text: "本人の様子を確認しながら、落ち着いて参加できるよう支援します。" }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const result = await assistant.generate({
    kind: "daily_log",
    field: "observation",
    activity: "工作",
    sourceText: "開始時は緊張していたが、職員と一緒に取り組んだ。",
    targetCharacters: 100,
  });

  assert.equal(request.url, "https://api.anthropic.com/v1/messages");
  assert.equal(request.options.headers["x-api-key"], "test-anthropic-key");
  assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "claude-opus-5");
  assert.equal(body.max_tokens, 1200);
  assert.equal(body.messages[0].role, "user");
  assert.match(result.text, /落ち着いて参加/);
});
