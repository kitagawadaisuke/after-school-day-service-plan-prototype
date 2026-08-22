import test from "node:test";
import assert from "node:assert/strict";
import { createWritingAssistant, writingAssistPrompt } from "../server/services/writing-assist.js";

const DAILY_INPUT = {
  kind: "daily_log",
  field: "observation",
  activity: "おやつ・自由活動",
  sourceText: "おやつ前に手洗いをし、職員の声かけで席に着いた。",
  targetCharacters: 300,
};

test("文章作成プロンプトは目標文字数と事実のみを根拠にする制約を明示する", () => {
  const prompt = writingAssistPrompt(DAILY_INPUT);
  assert.match(prompt, /出力は必ず335〜385字に収めてください。目標は360字です/);
  assert.match(prompt, /入力にない本人の心情、未記載の支援・日時・数値、評価を断定しない/);
  assert.match(prompt, /おやつ前に手洗いをし、職員の声かけで席に着いた/);
  assert.match(prompt, /活動・場面: おやつ・自由活動/);
});

test("支援時の引継ぎは家庭からの連絡を短い箇条書きに整理する", () => {
  const prompt = writingAssistPrompt({
    kind: "contact_request_summary",
    familyMessage: "明日の送迎時に、宿題の様子を確認してほしいです。疲れている様子なら休憩もお願いします。",
    targetCharacters: 120,
  });
  assert.match(prompt, /支援時の引継ぎ/);
  assert.match(prompt, /2〜4件の短い箇条書き/);
  assert.match(prompt, /宿題の様子を確認してほしい/);
  assert.doesNotMatch(prompt, /職員が入力した返信案/);
});

test("アセスメントの項目は入力内容のみを使い、指定文字数を目安に文章を整える", () => {
  const prompt = writingAssistPrompt({
    kind: "basic_assessment",
    field: "familyWishes",
    sourceText: "帰宅後は疲れすぎないよう、活動量に配慮してほしい。",
    targetCharacters: 200,
  });
  assert.match(prompt, /「家族の願い」の下書き/);
  assert.match(prompt, /入力された内容だけを使い/);
  assert.match(prompt, /出力は必ず215〜265字に収めてください。目標は240字です/);
  assert.match(prompt, /帰宅後は疲れすぎないよう/);
});

test("個別支援計画の項目も入力内容だけを目標文字数の下書きへ整える", () => {
  const prompt = writingAssistPrompt({
    kind: "individual_support_plan",
    field: "overallSupportPolicy",
    sourceText: "見通しを持って活動へ参加できるよう、予定を短く伝える。",
    targetCharacters: 300,
  });
  assert.match(prompt, /「総合的な支援の方針」の下書き/);
  assert.match(prompt, /入力された内容だけを使い/);
  assert.match(prompt, /見通しを持って活動へ参加できるよう/);
});

test("Responses APIへ保存なしで依頼し、生成文の実文字数を返す", async () => {
  let request;
  const assistant = createWritingAssistant({
    apiKey: "test-api-key-that-is-long-enough",
    model: "gpt-4.1",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ output_text: "事実を整えた下書きです。" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const generated = await assistant.generate(DAILY_INPUT);
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.options.headers.Authorization, "Bearer test-api-key-that-is-long-enough");
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.model, "gpt-4.1");
  assert.equal(payload.store, false);
  assert.equal(payload.reasoning, undefined);
  assert.equal(payload.max_output_tokens, 1200);
  assert.match(payload.input, /出力は必ず335〜385字に収めてください/);
  assert.equal(generated.text, "事実を整えた下書きです。");
  assert.equal(generated.characterCount, 12);
  assert.equal(generated.targetCharacters, 300);
});

test("APIキー未設定時は外部送信せず設定不足を返す", async () => {
  let called = false;
  const assistant = createWritingAssistant({ fetchImpl: async () => { called = true; } });
  await assert.rejects(() => assistant.generate(DAILY_INPUT), (error) => error.code === "SERVICE_UNAVAILABLE");
  assert.equal(called, false);
});
