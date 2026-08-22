import test from "node:test";
import assert from "node:assert/strict";
import { createKmsFieldEncryption } from "../server/aws/field-encryption.js";

test("受給者証番号はテナントと項目名をKMS暗号化コンテキストへ固定する", async () => {
  const calls = [];
  const kmsClient = {
    async send(command) {
      calls.push(command);
      if (command.constructor.name === "EncryptCommand") {
        return { CiphertextBlob: Buffer.from("opaque-kms-ciphertext") };
      }
      return { Plaintext: Buffer.from("9999000012") };
    },
  };
  const encryption = createKmsFieldEncryption({
    config: {
      awsRegion: "ap-northeast-3",
      documentKmsKeyArn: "arn:aws:kms:ap-northeast-3:123456789012:key/test-key",
    },
    kmsClient,
  });

  const ciphertext = await encryption.encrypt({
    tenantId: "018f1db5-c170-7c35-a784-3cfc6f98f101",
    fieldName: "recipient_certificate_number",
    plaintext: "9999000012",
  });
  assert.equal(ciphertext.toString(), "opaque-kms-ciphertext");
  assert.equal(calls[0].input.KeyId, "arn:aws:kms:ap-northeast-3:123456789012:key/test-key");
  assert.deepEqual(calls[0].input.EncryptionContext, {
    tenant_id: "018f1db5-c170-7c35-a784-3cfc6f98f101",
    field_name: "recipient_certificate_number",
    application: "michinote",
  });
  assert.equal(Buffer.from(calls[0].input.Plaintext).toString(), "9999000012");

  const plaintext = await encryption.decrypt({
    tenantId: "018f1db5-c170-7c35-a784-3cfc6f98f101",
    fieldName: "recipient_certificate_number",
    ciphertext,
  });
  assert.equal(plaintext, "9999000012");
  assert.deepEqual(calls[1].input.EncryptionContext, calls[0].input.EncryptionContext);
});

test("KMSキー未設定時は暗号化アダプターを作らない", () => {
  assert.equal(createKmsFieldEncryption({ config: { awsRegion: "ap-northeast-3" } }), null);
});
