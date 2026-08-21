import { v7 as uuidv7 } from "uuid";
import { badRequest, conflict, notFound } from "../errors.js";

const CHILD_SELECT = `
  select
    id,
    facility_id,
    management_code,
    display_name,
    legal_name,
    birth_date,
    grade,
    gender,
    address,
    primary_phone,
    emergency_contact,
    disability_category,
    medical_summary,
    municipality_name,
    copayment_limit_yen,
    recipient_certificate_last4,
    certificate_valid_from,
    certificate_valid_to,
    profile_photo_updated_at,
    status,
    updated_at,
    row_version
  from public.children
`;

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function serializeChild(row) {
  return {
    id: row.id,
    facilityId: row.facility_id,
    managementCode: row.management_code,
    displayName: row.display_name,
    legalName: row.legal_name,
    birthDate: dateOnly(row.birth_date),
    grade: row.grade,
    gender: row.gender,
    address: row.address || {},
    primaryPhone: row.primary_phone,
    emergencyContact: row.emergency_contact || {},
    disabilityCategory: row.disability_category,
    medicalSummary: row.medical_summary,
    municipalityName: row.municipality_name,
    copaymentLimitYen: row.copayment_limit_yen === null ? null : Number(row.copayment_limit_yen),
    recipientCertificateMasked: row.recipient_certificate_last4 ? `••••${row.recipient_certificate_last4}` : null,
    certificateValidFrom: dateOnly(row.certificate_valid_from),
    certificateValidTo: dateOnly(row.certificate_valid_to),
    profilePhotoUpdatedAt: row.profile_photo_updated_at instanceof Date
      ? row.profile_photo_updated_at.toISOString()
      : row.profile_photo_updated_at || null,
    status: row.status,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    rowVersion: Number(row.row_version),
  };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ updatedAt: row.updated_at, id: row.id })).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded.updatedAt || !decoded.id) throw new Error("missing cursor fields");
    return decoded;
  } catch {
    throw badRequest("INVALID_CURSOR", "一覧の続き位置が不正です。最初から読み込み直してください。");
  }
}

export async function listChildren(client, tenantId, options = {}) {
  const limit = Math.min(Math.max(options.limit || 30, 1), 100);
  const cursor = decodeCursor(options.cursor);
  const conditions = ["tenant_id = $1", "deleted_at is null"];
  const parameters = [tenantId];

  if (options.facilityId) {
    parameters.push(options.facilityId);
    conditions.push(`facility_id = $${parameters.length}`);
  }
  if (options.status) {
    parameters.push(options.status);
    conditions.push(`status = $${parameters.length}`);
  }
  if (cursor) {
    parameters.push(cursor.updatedAt, cursor.id);
    conditions.push(`(updated_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
  }

  parameters.push(limit + 1);
  const result = await client.query(
    `${CHILD_SELECT}
     where ${conditions.join(" and ")}
     order by updated_at desc, id desc
     limit $${parameters.length}`,
    parameters,
  );

  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  return {
    items: rows.map(serializeChild),
    nextCursor: hasMore ? encodeCursor(rows.at(-1)) : null,
  };
}

export async function getChild(client, tenantId, childId) {
  const result = await client.query(
    `${CHILD_SELECT} where tenant_id = $1 and id = $2 and deleted_at is null`,
    [tenantId, childId],
  );
  if (!result.rows[0]) throw notFound("利用児が見つかりません。");
  return serializeChild(result.rows[0]);
}

export async function createChild(client, actor, input) {
  const id = uuidv7();
  const result = await client.query(
    `insert into public.children (
      id, tenant_id, facility_id, management_code, display_name, legal_name,
      birth_date, grade, gender, address, primary_phone, emergency_contact,
      disability_category, medical_summary, recipient_certificate_ciphertext,
      recipient_certificate_last4, municipality_name, copayment_limit_yen,
      certificate_valid_from, certificate_valid_to,
      created_by, updated_by
    ) values (
      $1, $2, $3, $4, $5, $6,
      $7, $8, $9, $10::jsonb, $11, $12::jsonb,
      $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $21
    ) returning *`,
    [
      id,
      actor.tenantId,
      input.facilityId,
      input.managementCode,
      input.displayName,
      input.legalName,
      input.birthDate || null,
      input.grade || null,
      input.gender || null,
      JSON.stringify(input.address || {}),
      input.primaryPhone || null,
      JSON.stringify(input.emergencyContact || {}),
      input.disabilityCategory || null,
      input.medicalSummary || null,
      input.recipientCertificateCiphertext || null,
      input.recipientCertificateLast4 || null,
      input.municipalityName || null,
      input.copaymentLimitYen ?? null,
      input.certificateValidFrom || null,
      input.certificateValidTo || null,
      actor.userId,
    ],
  );
  return serializeChild(result.rows[0]);
}

const PATCH_COLUMNS = Object.freeze({
  facilityId: ["facility_id", (value) => value],
  managementCode: ["management_code", (value) => value],
  displayName: ["display_name", (value) => value],
  legalName: ["legal_name", (value) => value],
  birthDate: ["birth_date", (value) => value || null],
  grade: ["grade", (value) => value || null],
  gender: ["gender", (value) => value || null],
  address: ["address", (value) => JSON.stringify(value || {}), "jsonb"],
  primaryPhone: ["primary_phone", (value) => value || null],
  emergencyContact: ["emergency_contact", (value) => JSON.stringify(value || {}), "jsonb"],
  disabilityCategory: ["disability_category", (value) => value || null],
  medicalSummary: ["medical_summary", (value) => value || null],
  recipientCertificateCiphertext: ["recipient_certificate_ciphertext", (value) => value || null],
  recipientCertificateLast4: ["recipient_certificate_last4", (value) => value || null],
  municipalityName: ["municipality_name", (value) => value || null],
  copaymentLimitYen: ["copayment_limit_yen", (value) => value ?? null],
  certificateValidFrom: ["certificate_valid_from", (value) => value || null],
  certificateValidTo: ["certificate_valid_to", (value) => value || null],
  status: ["status", (value) => value],
});

export async function updateChild(client, actor, childId, expectedVersion, changes) {
  const entries = Object.entries(changes).filter(([key]) => PATCH_COLUMNS[key]);
  if (entries.length === 0) throw badRequest("NO_CHANGES", "変更する項目がありません。");

  const parameters = [actor.tenantId, childId, expectedVersion];
  const assignments = entries.map(([key, value]) => {
    const [column, transform, cast] = PATCH_COLUMNS[key];
    parameters.push(transform(value));
    return `${column} = $${parameters.length}${cast ? `::${cast}` : ""}`;
  });
  parameters.push(actor.userId);

  const result = await client.query(
    `update public.children
     set ${assignments.join(", ")},
         updated_by = $${parameters.length},
         updated_at = now(),
         row_version = row_version + 1
     where tenant_id = $1 and id = $2 and row_version = $3 and deleted_at is null
     returning *`,
    parameters,
  );

  if (result.rows[0]) return serializeChild(result.rows[0]);

  const current = await client.query(
    "select row_version, updated_at, updated_by from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
    [actor.tenantId, childId],
  );
  if (!current.rows[0]) throw notFound("利用児が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員が利用児情報を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
    updatedAt: current.rows[0].updated_at,
    updatedBy: current.rows[0].updated_by,
  });
}

export async function deleteChild(client, actor, childId, expectedVersion) {
  const result = await client.query(
    `update public.children
        set deleted_at = now(),
            deleted_by = $4,
            updated_by = $4,
            updated_at = now(),
            row_version = row_version + 1
      where tenant_id = $1 and id = $2 and row_version = $3 and deleted_at is null
      returning id, facility_id, deleted_at, row_version`,
    [actor.tenantId, childId, expectedVersion, actor.userId],
  );
  if (result.rows[0]) {
    const row = result.rows[0];
    return {
      id: row.id,
      facilityId: row.facility_id,
      deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : row.deleted_at,
      rowVersion: Number(row.row_version),
    };
  }

  const current = await client.query(
    "select row_version, updated_at, updated_by from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
    [actor.tenantId, childId],
  );
  if (!current.rows[0]) throw notFound("利用者が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員が利用者情報を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
    updatedAt: current.rows[0].updated_at,
    updatedBy: current.rows[0].updated_by,
  });
}

export async function getChildProfilePhoto(client, tenantId, childId) {
  const result = await client.query(
    `select profile_photo, profile_photo_content_type, profile_photo_updated_at
       from public.children
      where tenant_id = $1 and id = $2 and deleted_at is null`,
    [tenantId, childId],
  );
  const row = result.rows[0];
  if (!row) throw notFound("利用児が見つかりません。");
  if (!row.profile_photo || !row.profile_photo_content_type) return null;
  return {
    bytes: Buffer.from(row.profile_photo),
    contentType: row.profile_photo_content_type,
    updatedAt: row.profile_photo_updated_at instanceof Date
      ? row.profile_photo_updated_at.toISOString()
      : row.profile_photo_updated_at,
  };
}

export async function updateChildProfilePhoto(client, actor, childId, expectedVersion, photo) {
  const result = await client.query(
    `update public.children
        set profile_photo = $4,
            profile_photo_content_type = $5,
            profile_photo_byte_size = $6,
            profile_photo_updated_at = now(),
            updated_by = $7,
            updated_at = now(),
            row_version = row_version + 1
      where tenant_id = $1 and id = $2 and row_version = $3 and deleted_at is null
      returning *`,
    [
      actor.tenantId,
      childId,
      expectedVersion,
      photo.bytes,
      photo.contentType,
      photo.bytes.byteLength,
      actor.userId,
    ],
  );
  if (result.rows[0]) return serializeChild(result.rows[0]);

  const current = await client.query(
    "select row_version, updated_at, updated_by from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
    [actor.tenantId, childId],
  );
  if (!current.rows[0]) throw notFound("利用児が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員が利用児情報を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
    updatedAt: current.rows[0].updated_at,
    updatedBy: current.rows[0].updated_by,
  });
}

export async function removeChildProfilePhoto(client, actor, childId, expectedVersion) {
  const result = await client.query(
    `update public.children
        set profile_photo = null,
            profile_photo_content_type = null,
            profile_photo_byte_size = null,
            profile_photo_updated_at = null,
            updated_by = $4,
            updated_at = now(),
            row_version = row_version + 1
      where tenant_id = $1 and id = $2 and row_version = $3 and deleted_at is null
      returning *`,
    [actor.tenantId, childId, expectedVersion, actor.userId],
  );
  if (result.rows[0]) return serializeChild(result.rows[0]);

  const current = await client.query(
    "select row_version, updated_at, updated_by from public.children where tenant_id = $1 and id = $2 and deleted_at is null",
    [actor.tenantId, childId],
  );
  if (!current.rows[0]) throw notFound("利用児が見つかりません。");
  throw conflict("EDIT_CONFLICT", "別の職員が利用児情報を更新しました。最新内容を確認してください。", {
    currentVersion: Number(current.rows[0].row_version),
    updatedAt: current.rows[0].updated_at,
    updatedBy: current.rows[0].updated_by,
  });
}
