import test from "node:test";
import assert from "node:assert/strict";

import { DEMO_JOURNALS } from "../src/demo-data.js";
import { createJournalChatReply } from "../src/journal-chat.js";

test("日誌チャットは質問に応じた根拠日誌を返す", () => {
  const reply = createJournalChatReply("友だちとの関わりはどう変化した？", DEMO_JOURNALS);
  assert.match(reply.answer, /友だちとの関わり/);
  assert.ok(reply.evidence.length >= 1);
  assert.ok(reply.evidence.every((journal) => DEMO_JOURNALS.some((source) => source.id === journal.id)));
  assert.ok(reply.evidence.some((journal) => DEMO_JOURNALS.find((source) => source.id === journal.id).domains.includes("social")));
});

test("日誌に根拠のない質問でも、断定せずに案内する", () => {
  const reply = createJournalChatReply("最近の様子を教えて", []);
  assert.match(reply.answer, /見つかりません/);
  assert.deepEqual(reply.evidence, []);
  assert.equal(createJournalChatReply("   ", DEMO_JOURNALS), null);
});
