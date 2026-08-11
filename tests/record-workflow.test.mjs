import test from "node:test";
import assert from "node:assert/strict";

import {
  FAMILY_DRAFT_MAX_LENGTH,
  STAFF_DRAFT_MAX_LENGTH,
  canShareFamilyRecord,
  createFamilyDraft,
  createStaffDraft,
  invalidateDerivedWorkflow,
  normalizeFamilyShareStatus,
  normalizeRecordStatus,
  reconcileRecordDrafts,
  sanitizePlainText
} from "../src/record-workflow.js";

test("確認状態は許可値だけを受け入れ、不正値を安全側へ戻す", () => {
  assert.equal(normalizeRecordStatus("draft"), "draft");
  assert.equal(normalizeRecordStatus(" review \n"), "review");
  assert.equal(normalizeRecordStatus("confirmed"), "confirmed");
  assert.equal(normalizeRecordStatus("approved"), "draft");
  assert.equal(normalizeRecordStatus(1), "draft");
  assert.equal(normalizeRecordStatus(null), "draft");

  assert.equal(normalizeFamilyShareStatus("private"), "private");
  assert.equal(normalizeFamilyShareStatus(" ready "), "ready");
  assert.equal(normalizeFamilyShareStatus("shared-demo"), "shared-demo");
  assert.equal(normalizeFamilyShareStatus("shared"), "private");
  assert.equal(normalizeFamilyShareStatus({ toString: () => "ready" }), "private");
});

test("プレーンテキストは非文字列を文字列化せず、制御文字と改行だけを安全に整える", () => {
  assert.equal(sanitizePlainText("  1行目\r\n2行目\u0000  "), "1行目\n2行目");
  assert.equal(sanitizePlainText(123), "");
  assert.equal(sanitizePlainText(false), "");
  assert.equal(sanitizePlainText(undefined), "");
});

test("職員記録は観察・支援・反応の明示情報だけをラベル付きで結合する", () => {
  const draft = createStaffDraft({
    activity: "工作",
    observation: "はさみを置いて職員を見た。",
    support: "切る位置を指で示した。",
    response: "自分ではさみを持ち直した。",
    familyNote: "家庭だけの連絡"
  });

  assert.equal(
    draft,
    "観察：はさみを置いて職員を見た。\n支援：切る位置を指で示した。\n反応：自分ではさみを持ち直した。"
  );
  assert.doesNotMatch(draft, /工作|家庭だけの連絡/);
});

test("職員記録は空欄を飛ばし、情報がなければ空文字を返す", () => {
  assert.equal(createStaffDraft({ observation: "  ", support: "声を掛けた。", response: null }), "支援：声を掛けた。");
  assert.equal(createStaffDraft({}), "");
  assert.equal(createStaffDraft(null), "");
});

test("家庭共有欄があれば文面を優先し、他の内容を混ぜない", () => {
  const draft = createFamilyDraft({
    familyNote: "  好きな活動を自分で選びました。  ",
    activity: "別の活動",
    response: "別の反応",
    observation: "内部の観察",
    support: "内部の支援"
  });

  assert.equal(draft, "好きな活動を自分で選びました。");
  assert.doesNotMatch(draft, /別の活動|別の反応|内部/);
});

test("家庭共有欄がなければ活動と反応だけから穏当な下書きを作る", () => {
  const draft = createFamilyDraft({
    activity: "カードゲーム",
    response: "順番を確認しながら最後まで参加しました。",
    observation: "職員を三回見た。",
    support: "秘密の手順を使った。"
  });

  assert.equal(draft, "本日は「カードゲーム」に取り組みました。\n順番を確認しながら最後まで参加しました。");
  assert.doesNotMatch(draft, /三回|秘密の手順/);
  assert.equal(createFamilyDraft({ activity: "読書" }), "本日は「読書」に取り組みました。");
  assert.equal(createFamilyDraft({ response: "落ち着いて過ごしました。" }), "本日のご様子：落ち着いて過ごしました。");
});

test("入力上限内の元記録から作る下書きは保存上限で途中切れしない", () => {
  const maximumSource = {
    activity: "活".repeat(80),
    observation: "観".repeat(1000),
    support: "支".repeat(1000),
    response: "反".repeat(1000)
  };

  assert.ok(createStaffDraft(maximumSource).length <= STAFF_DRAFT_MAX_LENGTH);
  assert.ok(createFamilyDraft(maximumSource).length <= FAMILY_DRAFT_MAX_LENGTH);
  assert.match(createFamilyDraft(maximumSource), /反{1000}$/);
});

test("共有情報がなければ、日付や数値を作らず職員確認を促す", () => {
  const expected = "共有する内容が不足しています。職員が日誌を確認してください。";
  assert.equal(createFamilyDraft({}), expected);
  assert.equal(createFamilyDraft(null), expected);
  assert.doesNotMatch(expected, /\d|年|月|日まで/);
});

test("元記録だけを変えた場合は古い用途別下書きを新しい明示情報へ同期する", () => {
  const existing = {
    activity: "工作",
    observation: "材料を選んだ。",
    support: "手順を示した。",
    response: "完成まで取り組んだ。",
    staffDraft: "観察：材料を選んだ。\n支援：手順を示した。\n反応：完成まで取り組んだ。",
    familyDraft: "本日は「工作」に取り組みました。\n完成まで取り組んだ。"
  };
  const next = {
    ...existing,
    activity: "ボードゲーム",
    observation: "順番カードを確認した。",
    response: "最後まで参加した。"
  };
  const result = reconcileRecordDrafts(existing, next, {
    staffDraft: existing.staffDraft,
    familyDraft: existing.familyDraft
  });

  assert.equal(result.regeneratedStaffDraft, true);
  assert.equal(result.regeneratedFamilyDraft, true);
  assert.equal(result.staffDraft, "観察：順番カードを確認した。\n支援：手順を示した。\n反応：最後まで参加した。");
  assert.equal(result.familyDraft, "本日は「ボードゲーム」に取り組みました。\n最後まで参加した。");
});

test("元記録と同時に職員が下書きも編集した場合は手入力を優先する", () => {
  const existing = {
    activity: "工作",
    observation: "材料を選んだ。",
    support: "手順を示した。",
    response: "完成した。",
    staffDraft: "以前の職員記録",
    familyDraft: "以前の共有文"
  };
  const next = { ...existing, observation: "材料を二つ選んだ。", response: "笑顔で完成品を見せた。" };
  const result = reconcileRecordDrafts(existing, next, {
    staffDraft: "職員が今回確認した記録",
    familyDraft: "ご本人が完成品を見せてくれました。"
  });

  assert.equal(result.regeneratedStaffDraft, false);
  assert.equal(result.regeneratedFamilyDraft, false);
  assert.equal(result.staffDraft, "職員が今回確認した記録");
  assert.equal(result.familyDraft, "ご本人が完成品を見せてくれました。");
});

test("共有文が空の記録は元情報の編集だけで共有文を自動作成しない", () => {
  const existing = { activity: "工作", observation: "着席した。", support: "見守った。", response: "参加した。", familyDraft: "" };
  const next = { ...existing, activity: "読書", response: "本を一冊選んだ。" };
  const result = reconcileRecordDrafts(existing, next, { staffDraft: createStaffDraft(existing), familyDraft: "" });

  assert.equal(result.familyDraft, "");
  assert.equal(result.regeneratedFamilyDraft, false);
});

test("保護者共有は職員確認・共有文・共有状態の三条件がそろった場合だけ許可する", () => {
  const base = {
    recordStatus: "confirmed",
    familyShareStatus: "ready",
    familyNote: "活動の様子を共有します。"
  };

  assert.equal(canShareFamilyRecord(base), true);
  assert.equal(canShareFamilyRecord({ ...base, familyNote: "", familyDraft: "下書きあり" }), true);
  assert.equal(canShareFamilyRecord({ ...base, familyShareStatus: "shared-demo" }), true);
  assert.equal(canShareFamilyRecord({ ...base, recordStatus: "review" }), false);
  assert.equal(canShareFamilyRecord({ ...base, familyShareStatus: "private" }), false);
  assert.equal(canShareFamilyRecord({ ...base, familyNote: "   " }), false);
  assert.equal(canShareFamilyRecord({ ...base, familyNote: 123 }), false);
  assert.equal(canShareFamilyRecord(null), false);
});

test("日誌編集時は元データを変えず、確認と共有の状態を安全側へ戻す", () => {
  const original = Object.freeze({
    id: "journal-1",
    activity: "工作",
    recordStatus: "confirmed",
    familyShareStatus: "shared-demo",
    familyDraft: "共有済みの下書き"
  });
  const invalidated = invalidateDerivedWorkflow(original);

  assert.notEqual(invalidated, original);
  assert.equal(invalidated.id, "journal-1");
  assert.equal(invalidated.familyDraft, "共有済みの下書き");
  assert.equal(invalidated.recordStatus, "review");
  assert.equal(invalidated.familyShareStatus, "private");
  assert.equal(original.recordStatus, "confirmed");
  assert.equal(original.familyShareStatus, "shared-demo");

  assert.equal(invalidateDerivedWorkflow({ recordStatus: "review" }).recordStatus, "review");
  assert.equal(invalidateDerivedWorkflow({ recordStatus: "draft" }).recordStatus, "draft");
  assert.deepEqual(invalidateDerivedWorkflow(null), { recordStatus: "draft", familyShareStatus: "private" });
});
