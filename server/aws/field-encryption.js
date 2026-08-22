import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

function encryptionContext(tenantId, fieldName) {
  return {
    tenant_id: tenantId,
    field_name: fieldName,
    application: "michinote",
  };
}

export function createKmsFieldEncryption({ config, kmsClient } = {}) {
  if (!config?.documentKmsKeyArn) return null;
  const client = kmsClient || new KMSClient({ region: config.awsRegion });

  return Object.freeze({
    async encrypt({ tenantId, fieldName, plaintext }) {
      if (!tenantId || !fieldName || typeof plaintext !== "string" || !plaintext) {
        throw new TypeError("field encryption requires tenant, field and non-empty plaintext");
      }
      const response = await client.send(new EncryptCommand({
        KeyId: config.documentKmsKeyArn,
        Plaintext: Buffer.from(plaintext, "utf8"),
        EncryptionContext: encryptionContext(tenantId, fieldName),
      }));
      if (!response.CiphertextBlob?.byteLength) throw new Error("KMS did not return ciphertext");
      return Buffer.from(response.CiphertextBlob);
    },

    async decrypt({ tenantId, fieldName, ciphertext }) {
      if (!tenantId || !fieldName || !ciphertext?.byteLength) {
        throw new TypeError("field decryption requires tenant, field and ciphertext");
      }
      const response = await client.send(new DecryptCommand({
        KeyId: config.documentKmsKeyArn,
        CiphertextBlob: ciphertext,
        EncryptionContext: encryptionContext(tenantId, fieldName),
      }));
      if (!response.Plaintext?.byteLength) throw new Error("KMS did not return plaintext");
      return Buffer.from(response.Plaintext).toString("utf8");
    },
  });
}
