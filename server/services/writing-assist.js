import { serviceUnavailable } from "../errors.js";

const DAILY_FIELD_LABELS = Object.freeze({
  observation: "観察した事実",
  supportProvided: "行った支援",
  childResponse: "本人の反応",
  healthNote: "健康上の連絡",
});

const ASSESSMENT_FIELD_LABELS = Object.freeze({
  childWishes: "本人の願い",
  familyWishes: "家族の願い",
  concerns: "困りごと・相談内容",
  desiredLife: "望む生活のイメージ",
  healthManagement: "生活・健康",
  movementSensory: "運動・感覚",
  cognitionBehavior: "認知・行動",
  languageCommunication: "言語・コミュニケーション",
  relationshipsSocial: "人間関係・社会性",
  familySituation: "家族・生活環境",
  strengths: "強み・好きなこと",
  priorityNeeds: "優先して支援する課題",
  overallAssessment: "総合的なアセスメント",
  supportConsiderations: "支援で大切にすること",
  medicalSafetyNotes: "医療・安全上の留意事項",
  supportNetwork: "連携先と役割",
  planningNotes: "個別支援計画へ引き継ぐこと",
});

const INDIVIDUAL_PLAN_FIELD_LABELS = Object.freeze({
  userAndFamilyWishes: "本人・家族の意向",
  overallSupportPolicy: "総合的な支援の方針",
  consultationPlanBasis: "相談支援計画とのつながり",
  supportConsiderations: "支援上の留意事項",
  serviceDelivery: "標準的な支援方法",
  coordination: "家族・関係機関との連携",
  monitoringPlan: "モニタリングの時期・方法",
  explanationNotes: "説明・同意時の確認事項",
});

function characterCount(value) {
  return [...String(value || "").trim()].length;
}

function modelTargetCharacters(targetCharacters) {
  // モデルは短いメモを指定量より短く要約しやすいため、出力目標に届くよう補正する。
  return Math.min(800, Math.round(targetCharacters * 1.2));
}

function outputText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text.trim();
  return (payload?.output || [])
    .flatMap((item) => item?.content || [])
    .filter((item) => item?.type === "output_text")
    .map((item) => item.text || "")
    .join("")
    .trim();
}

function sourceLines(input) {
  if (input.kind === "daily_log") {
    return [
      input.activity ? `活動・場面: ${input.activity}` : "",
      `${DAILY_FIELD_LABELS[input.field]}: ${input.sourceText}`,
    ].filter(Boolean);
  }
  if (input.kind === "basic_assessment") {
    return [`${ASSESSMENT_FIELD_LABELS[input.field]}: ${input.sourceText}`];
  }
  if (input.kind === "individual_support_plan") {
    return [`${INDIVIDUAL_PLAN_FIELD_LABELS[input.field]}: ${input.sourceText}`];
  }
  if (input.kind === "contact_request_summary") {
    return [
      input.familyMessage ? `家庭からの連絡: ${input.familyMessage}` : "",
      input.requestSummary ? `職員が入力した支援時の引継ぎ: ${input.requestSummary}` : "",
    ].filter(Boolean);
  }
  return [
    input.familyMessage ? `家庭からの連絡: ${input.familyMessage}` : "",
    input.requestSummary ? `支援時の引継ぎ: ${input.requestSummary}` : "",
    input.facilityReply ? `職員が入力した返信案: ${input.facilityReply}` : "",
    input.reflectedInSupport ? "支援内容へ反映する: はい" : "",
  ].filter(Boolean);
}

export function writingAssistPrompt(input) {
  const modelTarget = modelTargetCharacters(input.targetCharacters);
  const lowerBound = Math.max(1, modelTarget - 25);
  const upperBound = Math.min(800, modelTarget + 25);
  const documentLabel = input.kind === "daily_log"
    ? DAILY_FIELD_LABELS[input.field]
    : input.kind === "basic_assessment"
      ? ASSESSMENT_FIELD_LABELS[input.field]
      : input.kind === "individual_support_plan"
        ? INDIVIDUAL_PLAN_FIELD_LABELS[input.field]
      : input.kind === "contact_request_summary"
      ? "支援時の引継ぎ"
      : "事業所からの返信";
  const summaryRules = input.kind === "contact_request_summary"
    ? [
      "家庭からの連絡に書かれた、次の支援で共有すべきこと、確認したいこと、配慮が必要な点だけを、2〜4件の短い箇条書きに整理してください。",
      "引継ぐ内容が読み取れない場合は、連絡内容を短く要約してください。",
      "見出し、注釈、文字数の説明は出力せず、箇条書き本文だけを返してください。",
    ]
    : input.kind === "basic_assessment" || input.kind === "individual_support_plan"
      ? [
        "入力された内容だけを使い、この欄に合う読みやすい文へ整えてください。入力の意味を変えないでください。",
        "入力にない本人の心情、未記載の支援・日時・数値、評価を断定したり、一般論だけで水増ししたりしないでください。",
        "見出し、箇条書き、注釈、文字数の説明は出力せず、下書き本文だけを返してください。",
      ]
      : [
      "各事実を省略せず、時系列や文のつながりが分かる記録文へ丁寧に展開してください。事実の意味は変えないでください。",
      "同じ文を繰り返したり、一般論だけで水増ししたりしないでください。",
      "見出し、箇条書き、注釈、文字数の説明は出力せず、下書き本文だけを返してください。",
    ];
  return [
    "あなたは放課後等デイサービスの記録作成を支援する日本語の文章補助です。",
    `以下の入力を踏まえ、職員が確認・修正する「${documentLabel}」の下書きを作成してください。`,
    `出力は必ず${lowerBound}〜${upperBound}字に収めてください。目標は${modelTarget}字です。`,
    "入力にない本人の心情、未記載の支援・日時・数値、評価を断定しないでください。",
    ...summaryRules,
    "",
    "入力:",
    ...sourceLines(input),
  ].join("\n");
}

export function createWritingAssistant({ apiKey, model = "gpt-4.1", fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  return {
    async generate(input) {
      if (!apiKey) throw serviceUnavailable("AIによる文章作成はまだ設定されていません。");
      let response;
      try {
        const body = {
          model,
          store: false,
          input: writingAssistPrompt(input),
          max_output_tokens: 1200,
        };
        if (model.startsWith("gpt-5")) body.reasoning = { effort: "minimal" };
        response = await fetchImpl("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw serviceUnavailable("AIによる文章作成に接続できません。しばらくしてから再度お試しください。");
      }

      let payload = null;
      try { payload = await response.json(); } catch { /* handled below */ }
      if (!response.ok) throw serviceUnavailable("AIによる文章作成を完了できませんでした。しばらくしてから再度お試しください。");
      const text = outputText(payload);
      if (!text) throw serviceUnavailable("AIによる文章作成を完了できませんでした。入力内容を確認して再度お試しください。");
      return { text, characterCount: characterCount(text), targetCharacters: input.targetCharacters };
    },
  };
}
