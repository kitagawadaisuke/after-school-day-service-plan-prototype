import { v7 as uuidv7 } from "uuid";
import { auditContextFromRequest } from "./audit.js";

export function authFailureReason(error) {
  if (error?.code === "COGNITO_AUTH_FAILED") return "cognito_denied";
  if (error?.code === "INVALID_AUTH_CALLBACK") return "invalid_callback";
  if (error?.code === "INVALID_AUTH_STATE") return "invalid_state";
  if (error?.code === "AUTH_REQUIRED") return "authentication_rejected";
  return "unknown";
}

export function createSecurityAuthAudit({ pool, config, idFactory = uuidv7 } = {}) {
  return async function recordSecurityAuthFailure(request, error) {
    if (!pool) return;
    const context = auditContextFromRequest(request, config);
    await pool.query(
      `select app_private.append_security_auth_event($1, $2, $3, $4, $5)`,
      [
        idFactory(),
        request.id,
        authFailureReason(error),
        context.ipHash,
        context.userAgentFamily,
      ],
    );
  };
}
