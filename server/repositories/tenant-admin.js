import { v7 as uuidv7 } from "uuid";
import { AppError, conflict, notFound } from "../errors.js";

const FACILITY_ADMIN_MANAGEABLE_ROLES = Object.freeze([
  "plan_approver",
  "support_staff",
  "viewer",
]);

function dateTime(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function serializeStaff(row) {
  return {
    membershipId: row.membership_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    userStatus: row.user_status,
    role: row.role,
    status: row.membership_status,
    facilityIds: row.facility_ids || [],
    invitedAt: dateTime(row.invited_at),
    joinedAt: dateTime(row.joined_at),
    endedAt: dateTime(row.ended_at),
    updatedAt: dateTime(row.updated_at),
    rowVersion: Number(row.row_version),
    invitation: row.invitation_id
      ? {
          id: row.invitation_id,
          status: row.invitation_status,
          invitedAt: dateTime(row.invitation_invited_at),
          lastDeliveryAt: dateTime(row.last_delivery_at),
          acceptedAt: dateTime(row.accepted_at),
          deliveryErrorCode: row.delivery_error_code,
          rowVersion: Number(row.invitation_row_version),
        }
      : null,
  };
}

const STAFF_SELECT = `
  select
    m.id as membership_id,
    m.user_id,
    u.email,
    u.display_name,
    u.status as user_status,
    m.role,
    m.status as membership_status,
    m.invited_at,
    m.joined_at,
    m.ended_at,
    m.updated_at,
    m.row_version,
    coalesce(
      array_agg(distinct mf.facility_id order by mf.facility_id)
        filter (
          where mf.facility_id is not null
            and ($2::text = 'tenant_admin' or app_private.can_access_facility(mf.facility_id))
        ),
      '{}'::uuid[]
    ) as facility_ids,
    invitation.id as invitation_id,
    invitation.status as invitation_status,
    invitation.invited_at as invitation_invited_at,
    invitation.last_delivery_at,
    invitation.accepted_at,
    invitation.delivery_error_code,
    invitation.row_version as invitation_row_version
  from public.memberships m
  join public.app_users u on u.id = m.user_id
  left join public.membership_facilities mf
    on mf.tenant_id = m.tenant_id and mf.membership_id = m.id
  left join lateral (
    select si.id, si.status, si.invited_at, si.last_delivery_at,
           si.accepted_at, si.delivery_error_code, si.row_version
    from public.staff_invitations si
    where si.tenant_id = m.tenant_id and si.membership_id = m.id
    order by si.invited_at desc, si.id desc
    limit 1
  ) invitation on true
`;

function staffVisibilityClause() {
  return `
    m.tenant_id = $1
    and (
      $2::text = 'tenant_admin'
      or (
        $2::text = 'facility_admin'
        and m.role = any($3::text[])
        and exists (
          select 1
          from public.membership_facilities target_facility
          join public.memberships actor_membership
            on actor_membership.tenant_id = target_facility.tenant_id
           and actor_membership.user_id = app_private.current_user_id()
           and actor_membership.status = 'active'
          join public.membership_facilities actor_facility
            on actor_facility.tenant_id = actor_membership.tenant_id
           and actor_facility.membership_id = actor_membership.id
           and actor_facility.facility_id = target_facility.facility_id
          where target_facility.tenant_id = m.tenant_id
            and target_facility.membership_id = m.id
        )
        and not exists (
          select 1
          from public.membership_facilities outside_target_facility
          where outside_target_facility.tenant_id = m.tenant_id
            and outside_target_facility.membership_id = m.id
            and not app_private.can_access_facility(outside_target_facility.facility_id)
        )
      )
    )
  `;
}

const STAFF_GROUP_BY = `
  group by
    m.id, m.user_id, u.email, u.display_name, u.status, m.role, m.status,
    m.invited_at, m.joined_at, m.ended_at, m.updated_at, m.row_version,
    invitation.id, invitation.status, invitation.invited_at,
    invitation.last_delivery_at, invitation.accepted_at,
    invitation.delivery_error_code, invitation.row_version
`;

export async function listStaff(client, actor) {
  const result = await client.query(
    `${STAFF_SELECT}
     where ${staffVisibilityClause()}
     ${STAFF_GROUP_BY}
     order by lower(u.display_name), m.id`,
    [actor.tenantId, actor.role, FACILITY_ADMIN_MANAGEABLE_ROLES],
  );
  return { items: result.rows.map(serializeStaff) };
}

export async function getVisibleStaff(client, actor, membershipId) {
  const result = await client.query(
    `${STAFF_SELECT}
     where ${staffVisibilityClause()} and m.id = $4
     ${STAFF_GROUP_BY}`,
    [actor.tenantId, actor.role, FACILITY_ADMIN_MANAGEABLE_ROLES, membershipId],
  );
  if (!result.rows[0]) throw notFound("職員アカウントが見つかりません。");
  return serializeStaff(result.rows[0]);
}

export async function getInvitationDeliveryState(client, actor, membershipId) {
  const staff = await getVisibleStaff(client, actor, membershipId);
  if (!staff.invitation) return { staff, cognitoUsername: null };
  const result = await client.query(
    `select cognito_username
     from public.staff_invitations
     where tenant_id = $1 and id = $2 and membership_id = $3`,
    [actor.tenantId, staff.invitation.id, membershipId],
  );
  return {
    staff,
    cognitoUsername: result.rows[0]?.cognito_username || null,
  };
}

function mapStaffDatabaseError(error) {
  if (error?.code === "23505") {
    return conflict("STAFF_ALREADY_REGISTERED", "このメールアドレスの職員はすでに登録されています。");
  }
  if (error?.code === "23514") {
    return conflict("LAST_TENANT_ADMIN", "企業には有効な企業管理者が1名以上必要です。");
  }
  if (error?.code === "55000") {
    return conflict("STAFF_ACCOUNT_UNAVAILABLE", "この職員アカウントは現在利用できません。");
  }
  if (error?.code === "22023") {
    return new AppError(422, "VALIDATION_ERROR", "職員情報の入力内容を確認してください。");
  }
  if (error?.code === "40001") {
    return conflict("EDIT_CONFLICT", "別の管理者が職員情報を更新しました。最新の内容を確認してください。");
  }
  return error;
}

export async function inviteStaff(client, actor, input) {
  const invitationId = uuidv7();
  const userId = uuidv7();
  const membershipId = uuidv7();
  let invitation;
  try {
    const result = await client.query(
      `select app_private.invite_staff_member(
        $1, $2, $3, $4, $5, $6, $7::uuid[]
      ) as invitation`,
      [
        invitationId,
        userId,
        membershipId,
        input.email,
        input.displayName,
        input.role,
        input.facilityIds,
      ],
    );
    invitation = result.rows[0]?.invitation;
  } catch (error) {
    throw mapStaffDatabaseError(error);
  }

  const staff = await getVisibleStaff(client, actor, membershipId);
  return {
    staff,
    invitationId,
    membershipId,
    requiresCognitoInvitation: invitation?.requiresCognitoInvitation === true,
  };
}

export async function recordInvitationDelivery(client, actor, invitationId, delivery) {
  await client.query(
    "select app_private.mark_staff_invitation_delivery($1, $2, $3, $4)",
    [
      invitationId,
      delivery.succeeded,
      delivery.username || null,
      delivery.errorCode || null,
    ],
  );
  const result = await client.query(
    `select membership_id
     from public.staff_invitations
     where tenant_id = $1 and id = $2`,
    [actor.tenantId, invitationId],
  );
  if (!result.rows[0]) throw notFound("職員招待が見つかりません。");
  return getVisibleStaff(client, actor, result.rows[0].membership_id);
}

export async function claimInvitationDelivery(
  client,
  membershipId,
  invitationId,
  descriptor,
  claimToken,
) {
  const result = await client.query(
    "select app_private.claim_staff_invitation_delivery($1,$2,$3,$4,$5) as outcome",
    [membershipId, invitationId, descriptor.key, descriptor.fingerprint, claimToken],
  );
  return result.rows[0]?.outcome;
}

export async function completeInvitationDeliveryClaim(client, claimToken, delivery) {
  await client.query(
    "select app_private.complete_staff_invitation_delivery_claim($1,$2,$3)",
    [claimToken, delivery.succeeded, delivery.errorCode || null],
  );
}

export async function markInvitationDeliveryClaimAmbiguous(client, claimToken, delivery) {
  await client.query(
    "select app_private.mark_staff_invitation_delivery_claim_ambiguous($1,$2)",
    [claimToken, delivery.errorCode],
  );
}

export async function updateStaffMembership(client, actor, membershipId, expectedVersion, changes) {
  const currentResult = await client.query(
    `select
       m.role,
       m.status,
       m.row_version,
       m.updated_at,
       coalesce(array(
         select mf.facility_id
         from public.membership_facilities mf
         where mf.tenant_id = m.tenant_id and mf.membership_id = m.id
         order by mf.facility_id
       ), '{}'::uuid[]) as facility_ids
     from public.memberships m
     where m.tenant_id = $1 and m.id = $2`,
    [actor.tenantId, membershipId],
  );
  const current = currentResult.rows[0];
  if (!current) throw notFound("職員アカウントが見つかりません。");
  if (Number(current.row_version) !== expectedVersion) {
    throw conflict("EDIT_CONFLICT", "別の管理者が職員情報を更新しました。最新の内容を確認してください。", {
      currentVersion: Number(current.row_version),
      updatedAt: dateTime(current.updated_at),
    });
  }

  const role = changes.role ?? current.role;
  const status = changes.status ?? current.status;
  const facilityIds = changes.facilityIds ?? current.facility_ids;

  try {
    await client.query(
      "select app_private.update_staff_membership($1, $2, $3, $4::uuid[], $5)",
      [membershipId, role, status, facilityIds, expectedVersion],
    );
  } catch (error) {
    throw mapStaffDatabaseError(error);
  }
  return getVisibleStaff(client, actor, membershipId);
}
