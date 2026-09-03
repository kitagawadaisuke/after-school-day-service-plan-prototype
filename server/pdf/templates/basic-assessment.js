import { buildCocoForm, cell, section, text, value } from "./coco-form.js";

export const BASIC_ASSESSMENT_ORIENTATION = "portrait";

export function renderBasicAssessment(source, snapshotKind) {
  const payload = source.document.payload || {};
  const dailyRows = [["食事", "dailyMeal"], ["衣類の着脱", "dailyDressing"], ["排泄", "dailyToileting"], ["入浴", "dailyBathing"], ["睡眠", "dailySleep"]];
  const pageOne = [
    section("日常生活について", `<table class="coco-table"><thead><tr><th>項目</th><th>確認内容</th><th>備考</th></tr></thead><tbody>${dailyRows.map(([label, key]) => `<tr><th>${label}</th><td>${text(value(payload, [key, "healthManagement"]))}</td><td></td></tr>`).join("")}<tr><th>スケジュール管理</th><td>${text(value(payload, ["scheduleManagement", "supportConsiderations"]))}</td><td></td></tr></tbody></table>`),
    section("学習面について", `<table class="coco-table"><thead><tr><th>項目</th><th>確認内容</th><th>備考</th></tr></thead><tbody><tr><th>在籍学級</th><td>${text(value(payload, ["schoolClass", "grade"]))}</td><td></td></tr><tr><th>授業中の様子</th><td>${text(value(payload, ["learning", "cognitionBehavior"]))}</td><td></td></tr></tbody></table>`),
    section("社会性について", `<div class="coco-grid">${cell("状況理解", value(payload, ["socialUnderstanding", "cognitionBehavior"]), "tall")}${cell("環境適応", value(payload, ["environmentAdaptation", "relationshipsSocial"]), "tall")}${cell("友達との関わり", value(payload, ["friendRelationships", "relationshipsSocial"]), "tall")}${cell("公共の場での行動", value(payload, ["publicBehavior", "relationshipsSocial"]), "tall")}</div>`),
    section("コミュニケーションについて", `<div class="coco-grid">${cell("自分から話す", value(payload, ["speaksIndependently", "languageCommunication"]), "tall")}${cell("相手の話を聴く", value(payload, ["listensToOthers", "languageCommunication"]), "tall")}</div>`),
    section("余暇について", `<div class="coco-grid">${cell("趣味・好きな遊び", value(payload, ["hobbies", "strengths"]), "tall")}${cell("習い事等", value(payload, ["lessons", "desiredLife"]), "tall")}</div>`),
  ].join("");
  const pageTwo = [
    section("進路について", `<div class="coco-grid">${cell("家族", value(payload, ["familyCareerPath"]), "tall")}${cell("本人", value(payload, ["childCareerPath"]), "tall")}</div>`),
    section("その他、支援に関わる特記事項", `<div class="coco-grid one">${cell("特記事項", value(payload, ["supportNotes", "medicalSafetyNotes", "planningNotes"]), "xl")}</div>`),
    section("生活・嗜好について", `<div class="coco-grid">${cell("好きな食べ物", value(payload, ["favoriteFood", "favoriteFoods", "strengths"]), "tall")}${cell("嫌いな食べ物", value(payload, ["dislikedFood", "dislikedFoods"]), "tall")}${cell("好きなおやつ", value(payload, ["favoriteSnack"]), "tall")}${cell("飲み物", value(payload, ["drinks"]), "tall")}${cell("好きな遊び", value(payload, ["favoritePlay", "favoriteActivities", "strengths"]), "tall")}${cell("苦手な遊び", value(payload, ["difficultPlay", "difficultActivities"]), "tall")}${cell("好きなキャラクター", value(payload, ["favoriteCharacter"]), "tall")}${cell("苦手なキャラクター", value(payload, ["difficultCharacter"]), "tall")}${cell("好きな色・物など", value(payload, ["favoriteThings"]), "tall")}${cell("睡眠", value(payload, ["sleepPattern", "dailySleep"]), "tall")}</div>`),
    section("家以外での様子について", `<div class="coco-grid">${cell("好きな外出先", value(payload, ["favoriteOutings"]), "tall")}${cell("苦手な外出先", value(payload, ["difficultOutings"]), "tall")}${cell("外出時に気をつけること", value(payload, ["outingNotes", "medicalSafetyNotes"]), "tall")}${cell("その他", value(payload, ["outsideNotes"]), "tall")}</div>`),
    section("習い事・他事業所の利用 / 利用希望日", `<div class="coco-grid">${cell("習い事・他事業所", value(payload, ["otherServices"]), "tall")}${cell("利用希望日", value(payload, ["desiredServiceDays"]), "tall")}</div>`),
  ].join("");
  return buildCocoForm({ source, snapshotKind, title: "アセスメントシート", bodyHtml: `${pageOne}<div class="page-break">${pageTwo}</div>`, pageClass: "basic-assessment" });
}
