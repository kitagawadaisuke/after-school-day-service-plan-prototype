import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { v5 as uuidv5 } from "uuid";

const { Client } = pg;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FACILITY_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const DATABASE_ROLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function requiredEnvironment(name, env = process.env) {
  const value = env[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function stableUuid(name, env) {
  const value = requiredEnvironment(name, env).trim();
  if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`);
  return value.toLowerCase();
}

function boundedTrimmed(name, env, maximumLength) {
  const raw = requiredEnvironment(name, env);
  const value = raw.trim();
  if (value !== raw || value.length < 1 || value.length > maximumLength) {
    throw new Error(`${name} must be trimmed and contain at most ${maximumLength} characters`);
  }
  return value;
}

export function loadOnboardingInput(env = process.env) {
  const email = requiredEnvironment("ONBOARDING_ADMIN_EMAIL", env).trim().toLowerCase();
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new Error("ONBOARDING_ADMIN_EMAIL is invalid");
  }
  const facilityCode = requiredEnvironment("ONBOARDING_FACILITY_CODE", env).trim();
  if (!FACILITY_CODE_PATTERN.test(facilityCode)) {
    throw new Error("ONBOARDING_FACILITY_CODE is invalid");
  }

  const resendValue = env.ONBOARDING_RESEND_INVITATION || "false";
  if (!['true', 'false'].includes(resendValue)) {
    throw new Error("ONBOARDING_RESEND_INVITATION must be true or false");
  }
  const resendInvitation = resendValue === "true";
  const resendEventId = resendInvitation
    ? stableUuid("ONBOARDING_RESEND_EVENT_ID", env)
    : null;

  const input = Object.freeze({
    operationId: stableUuid("ONBOARDING_OPERATION_ID", env),
    organizationId: stableUuid("ONBOARDING_ORGANIZATION_ID", env),
    organizationName: boundedTrimmed("ONBOARDING_ORGANIZATION_NAME", env, 200),
    administratorUserId: stableUuid("ONBOARDING_ADMIN_USER_ID", env),
    administratorEmail: email,
    administratorDisplayName: boundedTrimmed("ONBOARDING_ADMIN_DISPLAY_NAME", env, 200),
    administratorMembershipId: stableUuid("ONBOARDING_ADMIN_MEMBERSHIP_ID", env),
    firstFacilityId: stableUuid("ONBOARDING_FACILITY_ID", env),
    firstFacilityCode: facilityCode,
    firstFacilityName: boundedTrimmed("ONBOARDING_FACILITY_NAME", env, 200),
    resendInvitation,
    resendEventId,
  });

  const uniqueIds = new Set([
    input.operationId,
    input.organizationId,
    input.administratorUserId,
    input.administratorMembershipId,
    input.firstFacilityId,
  ]);
  if (uniqueIds.size !== 5) {
    throw new Error("onboarding UUIDs must be distinct");
  }
  if (resendEventId && uniqueIds.has(resendEventId)) {
    throw new Error("resend event UUID must be distinct from onboarding UUIDs");
  }
  return input;
}

export function fingerprintOnboardingRequest(input, cognitoSub) {
  if (typeof cognitoSub !== "string" || cognitoSub.trim() !== cognitoSub || cognitoSub.length === 0) {
    throw new TypeError("verified Cognito subject is required");
  }
  // An array fixes ordering across runtimes and avoids accidental omission of
  // a newly added key without changing the explicit fingerprint version.
  const canonical = JSON.stringify([
    "michinote-initial-tenant-v1",
    input.operationId,
    input.organizationId,
    input.organizationName,
    input.administratorUserId,
    cognitoSub,
    input.administratorEmail,
    input.administratorDisplayName,
    input.administratorMembershipId,
    input.firstFacilityId,
    input.firstFacilityCode,
    input.firstFacilityName,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function cognitoAttributes(entries = []) {
  const attributes = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.Name !== "string" || typeof entry.Value !== "string") continue;
    if (attributes.has(entry.Name) && attributes.get(entry.Name) !== entry.Value) {
      throw new Error("Cognito identity contains conflicting attributes");
    }
    attributes.set(entry.Name, entry.Value);
  }
  return attributes;
}

function verifyCognitoAdministratorIdentity(identity, administratorEmail) {
  const attributes = cognitoAttributes(identity?.UserAttributes);
  const cognitoSub = attributes.get("sub");
  if (
    typeof identity?.Username !== "string"
    || identity.Username.length < 1
    || identity.Username.length > 255
    ||
    attributes.get("email") !== administratorEmail
    || attributes.get("email_verified") !== "true"
    || typeof cognitoSub !== "string"
    || cognitoSub.length < 1
    || cognitoSub.length > 255
    || identity?.Enabled === false
  ) {
    throw new Error("Cognito administrator identity does not match the verified request");
  }
  const allowedStatuses = new Set(["FORCE_CHANGE_PASSWORD", "CONFIRMED", "RESET_REQUIRED"]);
  if (identity.UserStatus && !allowedStatuses.has(identity.UserStatus)) {
    throw new Error("Cognito administrator is not in an allowed account state");
  }
  return Object.freeze({
    cognitoSub,
    cognitoUsername: identity.Username,
    userStatus: identity.UserStatus || "UNKNOWN",
  });
}

export async function reconcileCognitoAdministrator({
  cognitoClient,
  userPoolId,
  administratorEmail,
  allowCreate = true,
}) {
  let created = false;
  let identity;
  try {
    identity = await cognitoClient.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: administratorEmail,
    }));
  } catch (error) {
    if (error?.name !== "UserNotFoundException") throw error;
    if (!allowCreate) {
      throw new Error("existing Cognito administrator is required for invitation recovery");
    }
  }

  if (!identity) {
    try {
      await cognitoClient.send(new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: administratorEmail,
        DesiredDeliveryMediums: ["EMAIL"],
        UserAttributes: [
          { Name: "email", Value: administratorEmail },
          { Name: "email_verified", Value: "true" },
        ],
      }));
      created = true;
    } catch (error) {
      // Another approved retry can win between Get and Create. Read and verify
      // that identity rather than resending or mutating it.
      if (error?.name !== "UsernameExistsException") throw error;
    }
    // A create response is never accepted as identity evidence.
    identity = await cognitoClient.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: administratorEmail,
    }));
  }
  return Object.freeze({
    ...verifyCognitoAdministratorIdentity(identity, administratorEmail),
    created,
  });
}

export async function resendCognitoAdministratorInvitation({
  cognitoClient,
  userPoolId,
  administratorEmail,
}) {
  const currentIdentity = await cognitoClient.send(new AdminGetUserCommand({
    UserPoolId: userPoolId,
    Username: administratorEmail,
  }));
  const verifiedCurrent = verifyCognitoAdministratorIdentity(
    currentIdentity,
    administratorEmail,
  );
  await cognitoClient.send(new AdminCreateUserCommand({
    UserPoolId: userPoolId,
    Username: verifiedCurrent.cognitoUsername,
    MessageAction: "RESEND",
    DesiredDeliveryMediums: ["EMAIL"],
    UserAttributes: [
      { Name: "email", Value: administratorEmail },
      { Name: "email_verified", Value: "true" },
    ],
  }));
  const identity = await cognitoClient.send(new AdminGetUserCommand({
    UserPoolId: userPoolId,
    Username: verifiedCurrent.cognitoUsername,
  }));
  return verifyCognitoAdministratorIdentity(identity, administratorEmail);
}

export async function buildProvisioningConnectionOptions(
  env = process.env,
  { readFileImpl = readFile } = {},
) {
  const sslMode = env.PROVISION_DATABASE_SSL || "require";
  const user = requiredEnvironment("PROVISION_DATABASE_USER", env);
  const password = requiredEnvironment("PROVISION_DATABASE_PASSWORD", env);
  if (!DATABASE_ROLE_NAME_PATTERN.test(user)) {
    throw new Error("PROVISION_DATABASE_USER is not a valid PostgreSQL role name");
  }
  if (password.length < 32 || password.length > 1024 || password.includes("\0")) {
    throw new Error("PROVISION_DATABASE_PASSWORD is invalid");
  }

  let ssl = false;
  if (sslMode !== "disable") {
    const caFile = requiredEnvironment("PROVISION_DATABASE_CA_FILE", env);
    let ca;
    try {
      ca = await readFileImpl(caFile, "utf8");
    } catch {
      throw new Error("PROVISION_DATABASE_CA_FILE could not be read");
    }
    if (typeof ca !== "string" || !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(ca)) {
      throw new Error("PROVISION_DATABASE_CA_FILE is not a PEM certificate bundle");
    }
    ssl = { rejectUnauthorized: true, ca };
  }

  const port = Number(env.PROVISION_DATABASE_PORT || 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PROVISION_DATABASE_PORT is invalid");
  }
  return {
    host: requiredEnvironment("PROVISION_DATABASE_HOST", env),
    port,
    database: requiredEnvironment("PROVISION_DATABASE_NAME", env),
    user,
    password,
    ssl,
    application_name: "michinote-initial-tenant-provisioner",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  };
}

export async function reconcileDatabaseTenant({ databaseClient, input, cognitoSub }) {
  const fingerprint = fingerprintOnboardingRequest(input, cognitoSub);
  const result = await databaseClient.query(
    `select app_private.reconcile_initial_tenant(
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
     ) as receipt`,
    [
      input.operationId,
      fingerprint,
      input.organizationId,
      input.organizationName,
      input.administratorUserId,
      cognitoSub,
      input.administratorEmail,
      input.administratorDisplayName,
      input.administratorMembershipId,
      input.firstFacilityId,
      input.firstFacilityCode,
      input.firstFacilityName,
    ],
  );
  const receipt = result.rows[0]?.receipt;
  if (!receipt || !["created", "unchanged"].includes(receipt.outcome)) {
    throw new Error("database did not return a valid onboarding receipt");
  }
  return receipt;
}

export async function claimInitialAdministratorInvitationResend({ databaseClient, input }) {
  const result = await databaseClient.query(
    "select app_private.claim_initial_admin_invitation_resend($1, $2) as should_send",
    [input.operationId, input.resendEventId],
  );
  return result.rows[0]?.should_send === true;
}

export async function recordInitialAdministratorInvitationResendResult({
  databaseClient,
  input,
  result,
}) {
  const resultEventId = uuidv5(
    "michinote-initial-admin-invitation-resend-result-v1",
    input.resendEventId,
  );
  const response = await databaseClient.query(
    `select app_private.record_initial_admin_invitation_resend_result(
       $1, $2, $3, $4
     ) as outcome`,
    [input.operationId, input.resendEventId, resultEventId, result],
  );
  return response.rows[0]?.outcome;
}

export function buildProvisioningCognitoClientOptions(env = process.env) {
  return {
    region: requiredEnvironment("AWS_REGION", env),
    // AdminCreateUser and RESEND have no idempotency token. A lost response
    // must be reconciled from CloudTrail, never retried by the SDK itself.
    maxAttempts: 1,
  };
}

export async function runProvisioning({
  env = process.env,
  logger = console,
  cognitoClient,
  databaseClient,
} = {}) {
  const input = loadOnboardingInput(env);
  const userPoolId = requiredEnvironment("COGNITO_USER_POOL_ID", env);
  const ownsCognito = !cognitoClient;
  const ownsDatabase = !databaseClient;
  const resolvedCognitoClient = cognitoClient || new CognitoIdentityProviderClient(
    buildProvisioningCognitoClientOptions(env),
  );
  const resolvedDatabaseClient = databaseClient || new Client(
    await buildProvisioningConnectionOptions(env),
  );

  if (ownsDatabase) await resolvedDatabaseClient.connect();
  try {
    const identity = await reconcileCognitoAdministrator({
      cognitoClient: resolvedCognitoClient,
      userPoolId,
      administratorEmail: input.administratorEmail,
      allowCreate: !input.resendInvitation,
    });
    logger.info?.(JSON.stringify({
      event: "initial_tenant_cognito_reconciled",
      outcome: identity.created ? "created" : "unchanged",
    }));

    const receipt = await reconcileDatabaseTenant({
      databaseClient: resolvedDatabaseClient,
      input,
      cognitoSub: identity.cognitoSub,
    });
    logger.info?.(JSON.stringify({
      event: "initial_tenant_database_reconciled",
      outcome: receipt.outcome,
    }));

    let invitationResendOutcome = "not_requested";
    if (input.resendInvitation) {
      const shouldSend = await claimInitialAdministratorInvitationResend({
        databaseClient: resolvedDatabaseClient,
        input,
      });
      if (!shouldSend) {
        invitationResendOutcome = "unchanged";
      } else {
        try {
          if (identity.created || identity.userStatus === "CONFIRMED") {
            invitationResendOutcome = "not_required";
          } else if (identity.userStatus === "FORCE_CHANGE_PASSWORD") {
            await resendCognitoAdministratorInvitation({
              cognitoClient: resolvedCognitoClient,
              userPoolId,
              administratorEmail: input.administratorEmail,
            });
            invitationResendOutcome = "success";
          } else {
            throw new Error("Cognito administrator is not eligible for invitation resend");
          }
        } catch (error) {
          try {
            await recordInitialAdministratorInvitationResendResult({
              databaseClient: resolvedDatabaseClient,
              input,
              result: "failed",
            });
          } catch {
            // Preserve the original Cognito/state failure. The append-only
            // request event still prevents an automatic duplicate resend.
          }
          throw error;
        }
        await recordInitialAdministratorInvitationResendResult({
          databaseClient: resolvedDatabaseClient,
          input,
          result: invitationResendOutcome,
        });
      }
      logger.info?.(JSON.stringify({
        event: "initial_tenant_cognito_invitation_resend",
        outcome: invitationResendOutcome,
      }));
    }
    return { ...receipt, invitationResendOutcome };
  } finally {
    if (ownsDatabase) await resolvedDatabaseClient.end();
    if (ownsCognito) resolvedCognitoClient.destroy();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const receipt = await runProvisioning();
    // IDs are operational references rather than names/contact details. No
    // organization, facility, administrator name, email or Cognito subject is
    // emitted to stdout/stderr.
    console.info(JSON.stringify({
      event: "initial_tenant_onboarding_complete",
      outcome: receipt.outcome,
      operationId: receipt.operationId,
      tenantId: receipt.tenantId,
      facilityId: receipt.facilityId,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: "initial_tenant_onboarding_failed",
      errorName: error?.name || "Error",
      errorCode: typeof error?.code === "string" ? error.code : "ONBOARDING_FAILED",
    }));
    process.exitCode = 1;
  }
}
