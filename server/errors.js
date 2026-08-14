export class AppError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message, options);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
  }
}

export function badRequest(code, message, details) {
  return new AppError(400, code, message, { details });
}

export function unauthorized(message = "ログインが必要です。") {
  return new AppError(401, "AUTH_REQUIRED", message);
}

export function forbidden(message = "この操作を行う権限がありません。") {
  return new AppError(403, "FORBIDDEN", message);
}

export function notFound(message = "対象のデータが見つかりません。") {
  return new AppError(404, "NOT_FOUND", message);
}

export function conflict(code, message, details) {
  return new AppError(409, code, message, { details });
}

export function preconditionRequired(message = "更新前の版番号が必要です。画面を再読み込みしてください。") {
  return new AppError(428, "VERSION_REQUIRED", message);
}

export function serviceUnavailable(message = "現在データベースへ接続できません。しばらくしてから再度お試しください。") {
  return new AppError(503, "SERVICE_UNAVAILABLE", message);
}
