export const RECORD_STATUSES = Object.freeze(["draft", "review", "confirmed"]);
export const FAMILY_SHARE_STATUSES = Object.freeze(["private", "ready", "shared-demo"]);
export const STAFF_DRAFT_MAX_LENGTH = 3200;
export const FAMILY_DRAFT_MAX_LENGTH = 1200;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * 保存値を表示用のプレーンテキストとして扱える文字列へ正規化する。
 * HTMLへ挿入するときのエスケープは、描画側で別途行う。
 */
export function sanitizePlainText(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARACTER_PATTERN, "").trim();
}

/** 記録の確認状態を許可値へ正規化する。 */
export function normalizeRecordStatus(value) {
  const status = sanitizePlainText(value);
  return RECORD_STATUSES.includes(status) ? status : "draft";
}

/** 保護者共有の状態を許可値へ正規化する。 */
export function normalizeFamilyShareStatus(value) {
  const status = sanitizePlainText(value);
  return FAMILY_SHARE_STATUSES.includes(status) ? status : "private";
}

/**
 * 日誌に明記された観察・支援・反応だけから、職員記録の下書きを作る。
 * 空欄は出力せず、事実の補完や推測は行わない。
 */
export function createStaffDraft(journal) {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return "";

  return [
    ["観察", sanitizePlainText(journal.observation)],
    ["支援", sanitizePlainText(journal.support)],
    ["反応", sanitizePlainText(journal.response)]
  ]
    .filter(([, text]) => text)
    .map(([label, text]) => `${label}：${text}`)
    .join("\n");
}

/**
 * 明記済みの家庭共有欄、または活動・反応だけから保護者向け下書きを作る。
 * 観察欄や職員の支援内容は参照しない。
 */
export function createFamilyDraft(journal) {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) {
    return "共有する内容が不足しています。職員が日誌を確認してください。";
  }

  const familyNote = sanitizePlainText(journal.familyNote);
  if (familyNote) return familyNote;

  const activity = sanitizePlainText(journal.activity);
  const response = sanitizePlainText(journal.response);

  if (activity && response) return `本日は「${activity}」に取り組みました。\n${response}`;
  if (activity) return `本日は「${activity}」に取り組みました。`;
  if (response) return `本日のご様子：${response}`;
  return "共有する内容が不足しています。職員が日誌を確認してください。";
}

/**
 * 元記録を編集したとき、画面に残っている用途別下書きを安全に同期する。
 *
 * - 元記録だけが変わった場合は、古い下書きを新しい明示情報から作り直す。
 * - 同じ保存操作で下書きも書き換えた場合は、その職員編集を優先する。
 * - 保護者向け文章が元から空なら、元記録の編集だけで共有文を自動作成しない。
 */
export function reconcileRecordDrafts(existingJournal, nextJournal, submittedDrafts = {}) {
  const submittedStaffDraft = sanitizePlainText(submittedDrafts.staffDraft);
  const submittedFamilyDraft = sanitizePlainText(submittedDrafts.familyDraft);

  if (!existingJournal || typeof existingJournal !== "object" || Array.isArray(existingJournal)) {
    return {
      staffDraft: submittedStaffDraft || createStaffDraft(nextJournal),
      familyDraft: submittedFamilyDraft,
      regeneratedStaffDraft: false,
      regeneratedFamilyDraft: false
    };
  }

  const previousStaffDraft = sanitizePlainText(existingJournal.staffDraft) || createStaffDraft(existingJournal);
  const previousFamilyDraft = sanitizePlainText(existingJournal.familyDraft)
    || sanitizePlainText(existingJournal.familyNote);
  const staffSourceChanged = ["observation", "support", "response"]
    .some((field) => sanitizePlainText(existingJournal[field]) !== sanitizePlainText(nextJournal?.[field]));
  const familySourceChanged = ["activity", "response"]
    .some((field) => sanitizePlainText(existingJournal[field]) !== sanitizePlainText(nextJournal?.[field]));
  const staffDraftEdited = submittedStaffDraft !== previousStaffDraft;
  const familyDraftEdited = submittedFamilyDraft !== previousFamilyDraft;
  const regeneratedStaffDraft = staffSourceChanged && !staffDraftEdited;
  const regeneratedFamilyDraft = Boolean(previousFamilyDraft) && familySourceChanged && !familyDraftEdited;

  return {
    staffDraft: regeneratedStaffDraft ? createStaffDraft(nextJournal) : submittedStaffDraft,
    familyDraft: regeneratedFamilyDraft
      ? createFamilyDraft({ ...nextJournal, familyNote: "", familyDraft: "" })
      : submittedFamilyDraft,
    regeneratedStaffDraft,
    regeneratedFamilyDraft
  };
}

/** 職員確認済みで、共有内容と共有操作の明示がある場合だけ共有可能とする。 */
export function canShareFamilyRecord(journal) {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) return false;

  const hasShareContent = Boolean(
    sanitizePlainText(journal.familyNote) || sanitizePlainText(journal.familyDraft)
  );
  const shareStatus = normalizeFamilyShareStatus(journal.familyShareStatus);

  return normalizeRecordStatus(journal.recordStatus) === "confirmed"
    && hasShareContent
    && (shareStatus === "ready" || shareStatus === "shared-demo");
}

/**
 * 元の日誌が編集されたとき、派生した確認・共有状態を安全側へ戻す。
 * 引数は変更せず、新しいオブジェクトを返す。
 */
export function invalidateDerivedWorkflow(journal) {
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) {
    return { recordStatus: "draft", familyShareStatus: "private" };
  }

  const currentRecordStatus = normalizeRecordStatus(journal.recordStatus);
  return {
    ...journal,
    recordStatus: currentRecordStatus === "draft" ? "draft" : "review",
    familyShareStatus: "private"
  };
}
