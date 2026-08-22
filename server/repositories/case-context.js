import { v7 as uuidv7 } from "uuid";
import { badRequest, conflict, notFound } from "../errors.js";

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function serializeFamilyMember(row) {
  return {
    id: row.id,
    childId: row.child_id,
    displayLabel: row.display_label,
    relationship: row.relationship,
    age: row.age === null ? null : Number(row.age),
    occupationOrRole: row.occupation_or_role,
    cohabitationStatus: row.cohabitation_status,
    supportSummary: row.support_summary,
    sortOrder: Number(row.sort_order),
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
  };
}

function serializeInstitution(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    contactName: row.contact_name,
    phone: row.phone,
    notes: row.notes,
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
  };
}

function serializeInstitutionRelation(row) {
  return {
    id: row.id,
    childId: row.child_id,
    institutionId: row.institution_id,
    institution: row.institution_name
      ? {
          id: row.institution_id,
          kind: row.institution_kind,
          name: row.institution_name,
        }
      : undefined,
    relationshipKind: row.relationship_kind,
    serviceDetails: row.service_details,
    frequencyText: row.frequency_text,
    validFrom: dateOnly(row.valid_from),
    validTo: dateOnly(row.valid_to),
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
  };
}

async function assertChildExists(client, tenantId, childId) {
  const result = await client.query(
    `select facility_id
     from public.children
     where tenant_id = $1 and id = $2 and deleted_at is null`,
    [tenantId, childId],
  );
  if (!result.rows[0]) throw notFound("利用児が見つかりません。");
  return result.rows[0];
}

async function assertInstitutionExists(client, tenantId, institutionId) {
  const result = await client.query(
    "select id from public.institutions where tenant_id = $1 and id = $2",
    [tenantId, institutionId],
  );
  if (!result.rows[0]) throw notFound("関係機関が見つかりません。");
}

function editConflict(row, resourceName) {
  return conflict(
    "EDIT_CONFLICT",
    `別の職員が${resourceName}を更新しました。最新の内容を確認してください。`,
    {
      currentVersion: Number(row.row_version),
      updatedAt: dateTime(row.updated_at),
    },
  );
}

async function currentOrNotFound(client, sql, parameters, resourceName) {
  const current = await client.query(sql, parameters);
  if (!current.rows[0]) throw notFound(`${resourceName}が見つかりません。`);
  return current.rows[0];
}

export async function listFamilyMembers(client, tenantId, childId) {
  await assertChildExists(client, tenantId, childId);
  const result = await client.query(
    `select * from public.family_members
     where tenant_id = $1 and child_id = $2
     order by sort_order, id`,
    [tenantId, childId],
  );
  return { items: result.rows.map(serializeFamilyMember) };
}

export async function getFamilyMember(client, tenantId, childId, familyMemberId) {
  const result = await client.query(
    `select * from public.family_members
     where tenant_id = $1 and child_id = $2 and id = $3`,
    [tenantId, childId, familyMemberId],
  );
  if (!result.rows[0]) throw notFound("家族構成が見つかりません。");
  return serializeFamilyMember(result.rows[0]);
}

export async function createFamilyMember(client, actor, childId, input) {
  const child = await assertChildExists(client, actor.tenantId, childId);
  const result = await client.query(
    `insert into public.family_members (
      id, tenant_id, child_id, display_label, relationship, age,
      occupation_or_role, cohabitation_status, support_summary, sort_order
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    returning *`,
    [
      uuidv7(),
      actor.tenantId,
      childId,
      input.displayLabel,
      input.relationship,
      input.age ?? null,
      input.occupationOrRole ?? null,
      input.cohabitationStatus ?? null,
      input.supportSummary ?? null,
      input.sortOrder ?? 0,
    ],
  );
  return { entity: serializeFamilyMember(result.rows[0]), facilityId: child.facility_id };
}

const FAMILY_MEMBER_COLUMNS = Object.freeze({
  displayLabel: "display_label",
  relationship: "relationship",
  age: "age",
  occupationOrRole: "occupation_or_role",
  cohabitationStatus: "cohabitation_status",
  supportSummary: "support_summary",
  sortOrder: "sort_order",
});

export async function updateFamilyMember(
  client,
  actor,
  childId,
  familyMemberId,
  expectedVersion,
  changes,
) {
  const child = await assertChildExists(client, actor.tenantId, childId);
  const parameters = [actor.tenantId, childId, familyMemberId, expectedVersion];
  const assignments = Object.entries(changes).map(([key, value]) => {
    parameters.push(value);
    return `${FAMILY_MEMBER_COLUMNS[key]} = $${parameters.length}`;
  });
  if (!assignments.length) throw badRequest("NO_CHANGES", "変更する項目がありません。");

  const result = await client.query(
    `update public.family_members
     set ${assignments.join(", ")}
     where tenant_id = $1 and child_id = $2 and id = $3 and row_version = $4
     returning *`,
    parameters,
  );
  if (result.rows[0]) {
    return { entity: serializeFamilyMember(result.rows[0]), facilityId: child.facility_id };
  }
  const current = await currentOrNotFound(
    client,
    `select row_version, updated_at from public.family_members
     where tenant_id = $1 and child_id = $2 and id = $3`,
    [actor.tenantId, childId, familyMemberId],
    "家族構成",
  );
  throw editConflict(current, "家族構成");
}

export async function listInstitutions(client, tenantId, kind) {
  const parameters = [tenantId];
  if (kind) parameters.push(kind);
  const result = await client.query(
    `select * from public.institutions
     where tenant_id = $1 ${kind ? "and kind = $2" : ""}
     order by kind, name, id`,
    parameters,
  );
  return { items: result.rows.map(serializeInstitution) };
}

export async function getInstitution(client, tenantId, institutionId) {
  const result = await client.query(
    "select * from public.institutions where tenant_id = $1 and id = $2",
    [tenantId, institutionId],
  );
  if (!result.rows[0]) throw notFound("関係機関が見つかりません。");
  return serializeInstitution(result.rows[0]);
}

export async function createInstitution(client, actor, input) {
  const result = await client.query(
    `insert into public.institutions (
      id, tenant_id, kind, name, contact_name, phone, notes
    ) values ($1, $2, $3, $4, $5, $6, $7)
    returning *`,
    [
      uuidv7(),
      actor.tenantId,
      input.kind,
      input.name,
      input.contactName ?? null,
      input.phone ?? null,
      input.notes ?? null,
    ],
  );
  return serializeInstitution(result.rows[0]);
}

const INSTITUTION_COLUMNS = Object.freeze({
  kind: "kind",
  name: "name",
  contactName: "contact_name",
  phone: "phone",
  notes: "notes",
});

export async function updateInstitution(client, actor, institutionId, expectedVersion, changes) {
  const parameters = [actor.tenantId, institutionId, expectedVersion];
  const assignments = Object.entries(changes).map(([key, value]) => {
    parameters.push(value);
    return `${INSTITUTION_COLUMNS[key]} = $${parameters.length}`;
  });
  if (!assignments.length) throw badRequest("NO_CHANGES", "変更する項目がありません。");

  const result = await client.query(
    `update public.institutions
     set ${assignments.join(", ")}
     where tenant_id = $1 and id = $2 and row_version = $3
     returning *`,
    parameters,
  );
  if (result.rows[0]) return serializeInstitution(result.rows[0]);
  const current = await currentOrNotFound(
    client,
    "select row_version, updated_at from public.institutions where tenant_id = $1 and id = $2",
    [actor.tenantId, institutionId],
    "関係機関",
  );
  throw editConflict(current, "関係機関");
}

const RELATION_SELECT = `
  select r.*, i.kind as institution_kind, i.name as institution_name
  from public.child_institution_relations r
  join public.institutions i
    on i.tenant_id = r.tenant_id and i.id = r.institution_id`;

export async function listInstitutionRelations(client, tenantId, childId) {
  await assertChildExists(client, tenantId, childId);
  const result = await client.query(
    `${RELATION_SELECT}
     where r.tenant_id = $1 and r.child_id = $2
     order by r.valid_from desc nulls last, i.kind, i.name, r.id`,
    [tenantId, childId],
  );
  return { items: result.rows.map(serializeInstitutionRelation) };
}

export async function getInstitutionRelation(client, tenantId, childId, relationId) {
  const result = await client.query(
    `${RELATION_SELECT}
     where r.tenant_id = $1 and r.child_id = $2 and r.id = $3`,
    [tenantId, childId, relationId],
  );
  if (!result.rows[0]) throw notFound("関係機関との紐付けが見つかりません。");
  return serializeInstitutionRelation(result.rows[0]);
}

export async function createInstitutionRelation(client, actor, childId, input) {
  const child = await assertChildExists(client, actor.tenantId, childId);
  await assertInstitutionExists(client, actor.tenantId, input.institutionId);
  const result = await client.query(
    `insert into public.child_institution_relations (
      id, tenant_id, child_id, institution_id, relationship_kind,
      service_details, frequency_text, valid_from, valid_to
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    returning *`,
    [
      uuidv7(),
      actor.tenantId,
      childId,
      input.institutionId,
      input.relationshipKind,
      input.serviceDetails ?? null,
      input.frequencyText ?? null,
      input.validFrom ?? null,
      input.validTo ?? null,
    ],
  );
  const entity = await getInstitutionRelation(client, actor.tenantId, childId, result.rows[0].id);
  return { entity, facilityId: child.facility_id };
}

const RELATION_COLUMNS = Object.freeze({
  institutionId: "institution_id",
  relationshipKind: "relationship_kind",
  serviceDetails: "service_details",
  frequencyText: "frequency_text",
  validFrom: "valid_from",
  validTo: "valid_to",
});

function assertValidPeriod(validFrom, validTo) {
  if (validFrom && validTo && validTo < validFrom) {
    throw badRequest("INVALID_PERIOD", "終了日は開始日以降にしてください。");
  }
}

export async function updateInstitutionRelation(
  client,
  actor,
  childId,
  relationId,
  expectedVersion,
  changes,
) {
  const child = await assertChildExists(client, actor.tenantId, childId);
  const currentResult = await client.query(
    `select * from public.child_institution_relations
     where tenant_id = $1 and child_id = $2 and id = $3
     for update`,
    [actor.tenantId, childId, relationId],
  );
  const current = currentResult.rows[0];
  if (!current) throw notFound("関係機関との紐付けが見つかりません。");
  if (Number(current.row_version) !== expectedVersion) {
    throw editConflict(current, "関係機関との紐付け");
  }

  if (changes.institutionId) {
    await assertInstitutionExists(client, actor.tenantId, changes.institutionId);
  }
  const validFrom = Object.hasOwn(changes, "validFrom")
    ? changes.validFrom
    : dateOnly(current.valid_from);
  const validTo = Object.hasOwn(changes, "validTo") ? changes.validTo : dateOnly(current.valid_to);
  assertValidPeriod(validFrom, validTo);

  const parameters = [actor.tenantId, childId, relationId, expectedVersion];
  const assignments = Object.entries(changes).map(([key, value]) => {
    parameters.push(value);
    return `${RELATION_COLUMNS[key]} = $${parameters.length}`;
  });
  if (!assignments.length) throw badRequest("NO_CHANGES", "変更する項目がありません。");

  const result = await client.query(
    `update public.child_institution_relations
     set ${assignments.join(", ")}
     where tenant_id = $1 and child_id = $2 and id = $3 and row_version = $4
     returning id`,
    parameters,
  );
  if (!result.rows[0]) {
    const latest = await currentOrNotFound(
      client,
      `select row_version, updated_at from public.child_institution_relations
       where tenant_id = $1 and child_id = $2 and id = $3`,
      [actor.tenantId, childId, relationId],
      "関係機関との紐付け",
    );
    throw editConflict(latest, "関係機関との紐付け");
  }
  const entity = await getInstitutionRelation(client, actor.tenantId, childId, relationId);
  return { entity, facilityId: child.facility_id };
}
