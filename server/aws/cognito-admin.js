import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";

const SAFE_COGNITO_ERROR_CODES = new Set([
  "InternalErrorException",
  "InvalidParameterException",
  "LimitExceededException",
  "NotAuthorizedException",
  "ResourceNotFoundException",
  "ServiceUnavailableException",
  "TooManyRequestsException",
  "UsernameExistsException",
]);

// Only service responses that unambiguously reject the request may be retried
// automatically. A timeout, transport failure, 5xx, or unknown SDK error can
// occur after Cognito accepted AdminCreateUser, so treating it as a normal
// failure could send the invitation twice.
const DEFINITE_REJECTION_CODES = new Set([
  "InvalidParameterException",
  "LimitExceededException",
  "NotAuthorizedException",
  "ResourceNotFoundException",
  "TooManyRequestsException",
]);

export function safeCognitoErrorCode(error) {
  const candidate = typeof error?.name === "string" ? error.name : "";
  return SAFE_COGNITO_ERROR_CODES.has(candidate) ? candidate : "CognitoDeliveryFailed";
}

export function classifyCognitoDeliveryError(error) {
  const errorCode = safeCognitoErrorCode(error);
  return {
    errorCode,
    outcome: DEFINITE_REJECTION_CODES.has(errorCode) ? "rejected" : "unknown",
  };
}

export function cognitoAdminClientOptions(config) {
  return {
    region: config.cognito.region,
    // AdminCreateUser/RESEND has no idempotency token. SDK-level retries can
    // duplicate an email when Cognito accepted the first request but its
    // response was lost.
    maxAttempts: 1,
  };
}

export function createCognitoAdmin({ config, client } = {}) {
  if (!config?.cognito?.userPoolId) {
    throw new TypeError("Cognito user pool configuration is required");
  }

  const cognitoClient = client || new CognitoIdentityProviderClient(
    cognitoAdminClientOptions(config),
  );

  function invitationInput(username, email, displayName, messageAction) {
    return {
      UserPoolId: config.cognito.userPoolId,
      Username: username,
      DesiredDeliveryMediums: ["EMAIL"],
      UserAttributes: [
        { Name: "email", Value: email },
        // Identity resolution deliberately accepts an invitation only when
        // Cognito attests that this address is verified. Admin-created users
        // therefore need the verification attribute in the same command.
        { Name: "email_verified", Value: "true" },
        { Name: "name", Value: displayName },
      ],
      ...(messageAction ? { MessageAction: messageAction } : {}),
    };
  }

  async function inviteUser({ email, displayName, operation = "create", username = null }) {
    if (!["create", "resend"].includes(operation)) {
      throw new TypeError("Cognito invitation operation must be create or resend");
    }
    if (operation === "resend" && (typeof username !== "string" || username.length === 0)) {
      throw new TypeError("Cognito username is required to resend an invitation");
    }
    const response = await cognitoClient.send(
      new AdminCreateUserCommand(
        invitationInput(operation === "resend" ? username : email, email, displayName,
          operation === "resend" ? "RESEND" : undefined),
      ),
    );
    const returnedUsername = response?.User?.Username;
    if (typeof returnedUsername !== "string" || returnedUsername.length === 0) {
      const error = new Error("Cognito did not return a username");
      error.name = "CognitoDeliveryFailed";
      throw error;
    }
    return { username: returnedUsername };
  }

  return Object.freeze({ inviteUser });
}
