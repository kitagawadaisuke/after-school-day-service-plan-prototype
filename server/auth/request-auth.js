import { unauthorized } from "../errors.js";

export function createDevelopmentAuthenticator(config) {
  if (config.nodeEnv === "production") {
    throw new Error("development authentication must not be enabled in production");
  }

  return async function authenticateDevelopmentRequest() {
    return config.devActor;
  };
}

export function createUnavailableAuthenticator() {
  return async function authenticateUnavailableRequest() {
    throw unauthorized("認証設定が完了していません。管理者へお問い合わせください。");
  };
}

export function createCognitoAuthenticator(cognitoAuth) {
  if (!cognitoAuth || typeof cognitoAuth.authenticateRequest !== "function") {
    throw new TypeError("Cognito authenticator is not configured");
  }
  return (request) => cognitoAuth.authenticateRequest(request);
}
