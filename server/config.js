import { z } from "zod";

const optionalUrl = z.preprocess((value) => value || undefined, z.string().url().optional());
const optionalString = z.preprocess((value) => value || undefined, z.string().min(1).optional());

const discreteDatabaseKeys = Object.freeze([
  "DATABASE_HOST",
  "DATABASE_NAME",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
]);

const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8015),
    APP_BASE_URL: optionalUrl.default("http://127.0.0.1:8015"),
    // Allows the authenticated SaaS shell to be demonstrated at the root URL
    // without weakening the production-only Cognito requirement.
    PUBLIC_SAAS_UI: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
    DATABASE_URL: optionalString,
    DATABASE_HOST: optionalString,
    DATABASE_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
    DATABASE_NAME: z.preprocess(
      (value) => value || undefined,
      z.string().min(1).max(63).regex(/^[a-zA-Z_][a-zA-Z0-9_$]*$/).optional(),
    ),
    DATABASE_USER: optionalString,
    DATABASE_PASSWORD: optionalString,
    DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
    DATABASE_CA_FILE: optionalString,
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    AUTH_MODE: z.enum(["development", "local", "cognito"]).default("development"),
    COOKIE_SECRET: z.preprocess((value) => value || undefined, z.string().min(32).optional()),
    LOCAL_SIGNUP_TENANT_ID: z.preprocess((value) => value || undefined, z.string().uuid().optional()),
    AUDIT_HASH_KEY: z.preprocess((value) => value || undefined, z.string().min(32).optional()),
    PDF_FINALIZATION_SECRET: z.preprocess(
      (value) => value || undefined,
      z.string().regex(/^[A-Za-z0-9]{64}$/).optional(),
    ),
    AWS_REGION: z.preprocess(
      (value) => value || undefined,
      z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/).optional(),
    ),
    DOCUMENT_KMS_KEY_ARN: optionalString,
    DOCUMENT_BUCKET: optionalString,
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: optionalString,
    PDF_RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(1),
    PDF_RENDER_QUEUE_LIMIT: z.coerce.number().int().min(0).max(4).default(1),
    PDF_RENDER_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
    PDF_JOB_LEASE_SECONDS: z.coerce.number().int().min(60).max(600).default(120),
    WRITING_ASSISTANT_PROVIDER: z.enum(["openai", "anthropic"]).default("openai"),
    OPENAI_API_KEY: z.preprocess((value) => value || undefined, z.string().min(20).optional()),
    OPENAI_MODEL: z.string().min(1).max(100).default("gpt-4.1"),
    ANTHROPIC_API_KEY: z.preprocess((value) => value || undefined, z.string().min(20).optional()),
    ANTHROPIC_MODEL: z.string().min(1).max(100).default("claude-opus-5"),
    COGNITO_USER_POOL_ID: z.preprocess((value) => value || undefined, z.string().min(1).optional()),
    COGNITO_CLIENT_ID: z.preprocess((value) => value || undefined, z.string().min(1).optional()),
    COGNITO_CLIENT_SECRET: z.preprocess((value) => value || undefined, z.string().min(1).optional()),
    COGNITO_DOMAIN: optionalUrl,
    COGNITO_CALLBACK_URL: optionalUrl,
    COGNITO_LOGOUT_URL: optionalUrl,
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    MAIL_SERVER: optionalString,
    MAIL_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    MAIL_USE_TLS: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
    MAIL_USERNAME: optionalString,
    MAIL_PASSWORD: optionalString,
    MAIL_DEFAULT_SENDER: optionalString,
    DEV_USER_ID: z.string().uuid().default("018f1db5-c170-7c35-a784-3cfc6f98c201"),
    DEV_TENANT_ID: z.string().uuid().default("018f1db5-c170-7c35-a784-3cfc6f98c101"),
    DEV_TENANT_NAME: z.string().min(1).max(200).default("開発用デモ法人"),
    DEV_FACILITY_ID: z.string().uuid().default("018f1db5-c170-7c35-a784-3cfc6f98c301"),
    DEV_ROLE: z
      .enum(["tenant_admin", "facility_admin", "plan_approver", "support_staff", "viewer", "auditor"])
      .default("tenant_admin"),
  })
  .superRefine((value, context) => {
    const providedDiscreteKeys = discreteDatabaseKeys.filter((key) => Boolean(value[key]));
    const hasAnyDiscreteDatabaseSetting = providedDiscreteKeys.length > 0;
    const hasCompleteDiscreteDatabaseSetting = providedDiscreteKeys.length === discreteDatabaseKeys.length;

    if (value.DATABASE_URL && hasAnyDiscreteDatabaseSetting) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "DATABASE_URLと個別のDB接続項目は同時に設定できません",
      });
    }
    if (hasAnyDiscreteDatabaseSetting && !hasCompleteDiscreteDatabaseSetting) {
      for (const key of discreteDatabaseKeys.filter((candidate) => !value[candidate])) {
        context.addIssue({ code: "custom", path: [key], message: "個別DB接続では必須です" });
      }
    }
    if (value.NODE_ENV === "production" && !value.DATABASE_URL && !hasCompleteDiscreteDatabaseSetting) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "productionではDATABASE_URLか完全な個別DB接続項目が必須です",
      });
    }
    if (value.NODE_ENV === "production" && value.DATABASE_SSL !== "require") {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_SSL"],
        message: "productionではCA検証付きTLSが必須です",
      });
    }
    if (value.NODE_ENV === "production" && !value.DATABASE_CA_FILE) {
      context.addIssue({
        code: "custom",
        path: ["DATABASE_CA_FILE"],
        message: "productionではRDS CA bundleが必須です",
      });
    }
    if (value.NODE_ENV === "production" && value.AUTH_MODE !== "cognito") {
      context.addIssue({ code: "custom", path: ["AUTH_MODE"], message: "productionではcognitoのみ利用できます" });
    }
    if (value.AUTH_MODE === "local" && !value.COOKIE_SECRET) {
      context.addIssue({ code: "custom", path: ["COOKIE_SECRET"], message: "local authentication requires COOKIE_SECRET" });
    }
    if (value.AUTH_MODE === "local" && !value.LOCAL_SIGNUP_TENANT_ID) {
      context.addIssue({ code: "custom", path: ["LOCAL_SIGNUP_TENANT_ID"], message: "local signup requires a tenant" });
    }
    if (value.AUTH_MODE === "local") {
      const mailKeys = ["MAIL_SERVER", "MAIL_USERNAME", "MAIL_PASSWORD", "MAIL_DEFAULT_SENDER"];
      const supplied = mailKeys.filter((key) => Boolean(value[key]));
      if (supplied.length > 0 && supplied.length !== mailKeys.length) {
        for (const key of mailKeys.filter((key) => !value[key])) context.addIssue({ code: "custom", path: [key], message: "local認証のメール設定では必須です" });
      }
    }
    if (value.NODE_ENV === "production" && !value.AUDIT_HASH_KEY) {
      context.addIssue({ code: "custom", path: ["AUDIT_HASH_KEY"], message: "productionでは必須です" });
    }
    if (value.NODE_ENV === "production" && !value.PDF_FINALIZATION_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["PDF_FINALIZATION_SECRET"],
        message: "production requires an independent PDF finalization secret",
      });
    }
    if (value.PDF_FINALIZATION_SECRET && value.PDF_FINALIZATION_SECRET === value.DATABASE_PASSWORD) {
      context.addIssue({
        code: "custom",
        path: ["PDF_FINALIZATION_SECRET"],
        message: "must be independent from DATABASE_PASSWORD",
      });
    }
    if (value.NODE_ENV === "production" && !value.DOCUMENT_KMS_KEY_ARN) {
      context.addIssue({
        code: "custom",
        path: ["DOCUMENT_KMS_KEY_ARN"],
        message: "productionでは受給者証番号と帳票を保護するKMSキーが必須です",
      });
    }
    if (value.NODE_ENV === "production" && !value.DOCUMENT_BUCKET) {
      context.addIssue({
        code: "custom",
        path: ["DOCUMENT_BUCKET"],
        message: "productionでは帳票PDF用の非公開S3バケットが必要です",
      });
    }
    if (value.NODE_ENV === "production" && new URL(value.APP_BASE_URL).protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["APP_BASE_URL"], message: "productionではHTTPSが必須です" });
    }
    if (value.AUTH_MODE === "cognito") {
      for (const key of ["COOKIE_SECRET", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID", "COGNITO_DOMAIN"]) {
        if (!value[key]) context.addIssue({ code: "custom", path: [key], message: "cognito認証では必須です" });
      }
      if (value.NODE_ENV === "production" && value.COGNITO_DOMAIN && new URL(value.COGNITO_DOMAIN).protocol !== "https:") {
        context.addIssue({ code: "custom", path: ["COGNITO_DOMAIN"], message: "productionではHTTPSが必須です" });
      }
      const expectedCallbackUrl = new URL("/auth/callback", value.APP_BASE_URL).toString();
      const expectedLogoutUrl = new URL("/", value.APP_BASE_URL).toString();
      if (value.NODE_ENV === "production" && !value.COGNITO_CALLBACK_URL) {
        context.addIssue({ code: "custom", path: ["COGNITO_CALLBACK_URL"], message: "production Cognito authentication requires an explicit callback URL" });
      }
      if (value.NODE_ENV === "production" && !value.COGNITO_LOGOUT_URL) {
        context.addIssue({ code: "custom", path: ["COGNITO_LOGOUT_URL"], message: "production Cognito authentication requires an explicit logout URL" });
      }
      if (value.COGNITO_CALLBACK_URL && value.COGNITO_CALLBACK_URL !== expectedCallbackUrl) {
        context.addIssue({ code: "custom", path: ["COGNITO_CALLBACK_URL"], message: "must exactly match APP_BASE_URL /auth/callback" });
      }
      if (value.COGNITO_LOGOUT_URL && value.COGNITO_LOGOUT_URL !== expectedLogoutUrl) {
        context.addIssue({ code: "custom", path: ["COGNITO_LOGOUT_URL"], message: "must exactly match APP_BASE_URL root" });
      }
    }
  });

export function loadConfig(env = process.env) {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`環境設定が不正です: ${message}`);
  }

  const value = parsed.data;
  const userPoolRegion = value.COGNITO_USER_POOL_ID?.split("_")[0];
  const inferredCognitoRegion = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(userPoolRegion || "")
    ? userPoolRegion
    : undefined;
  const cognitoCallbackUrl = new URL("/auth/callback", value.APP_BASE_URL).toString();
  const cognitoLogoutUrl = new URL("/", value.APP_BASE_URL).toString();
  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    appBaseUrl: value.APP_BASE_URL,
    publicSaasUi: value.PUBLIC_SAAS_UI,
    databaseUrl: value.DATABASE_URL,
    databaseHost: value.DATABASE_HOST,
    databasePort: value.DATABASE_PORT,
    databaseName: value.DATABASE_NAME,
    databaseUser: value.DATABASE_USER,
    databasePassword: value.DATABASE_PASSWORD,
    pdfFinalizationSecret: value.PDF_FINALIZATION_SECRET,
    databaseSsl: value.DATABASE_SSL === "require",
    databaseCaFile: value.DATABASE_CA_FILE,
    dbPoolMax: value.DB_POOL_MAX,
    authMode: value.AUTH_MODE,
    cookieSecret: value.COOKIE_SECRET,
    localSignupTenantId: value.LOCAL_SIGNUP_TENANT_ID,
    auditHashKey: value.AUDIT_HASH_KEY || "development-audit-key-not-for-production",
    awsRegion: value.AWS_REGION || inferredCognitoRegion || "ap-northeast-3",
    documentKmsKeyArn: value.DOCUMENT_KMS_KEY_ARN,
    documentBucket: value.DOCUMENT_BUCKET,
    playwrightChromiumExecutablePath: value.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    pdfRenderConcurrency: value.PDF_RENDER_CONCURRENCY,
    pdfRenderQueueLimit: value.PDF_RENDER_QUEUE_LIMIT,
    pdfRenderRetryAfterSeconds: value.PDF_RENDER_RETRY_AFTER_SECONDS,
    pdfJobLeaseSeconds: value.PDF_JOB_LEASE_SECONDS,
    writingAssistantProvider: value.WRITING_ASSISTANT_PROVIDER,
    openAiApiKey: value.OPENAI_API_KEY,
    openAiModel: value.OPENAI_MODEL,
    anthropicApiKey: value.ANTHROPIC_API_KEY,
    anthropicModel: value.ANTHROPIC_MODEL,
    cognito: value.AUTH_MODE === "cognito"
      ? {
          region: value.AWS_REGION || inferredCognitoRegion || "ap-northeast-3",
          userPoolId: value.COGNITO_USER_POOL_ID,
          clientId: value.COGNITO_CLIENT_ID,
          clientSecret: value.COGNITO_CLIENT_SECRET,
          domain: value.COGNITO_DOMAIN,
          callbackUri: value.COGNITO_CALLBACK_URL || cognitoCallbackUrl,
          logoutUri: value.COGNITO_LOGOUT_URL || cognitoLogoutUrl,
          sessionTtlSeconds: value.SESSION_TTL_HOURS * 60 * 60,
        }
      : null,
    mail: value.MAIL_SERVER ? {
      host: value.MAIL_SERVER,
      port: value.MAIL_PORT,
      secure: false,
      requireTLS: value.MAIL_USE_TLS,
      username: value.MAIL_USERNAME,
      password: value.MAIL_PASSWORD,
      from: value.MAIL_DEFAULT_SENDER,
    } : null,
    devActor: {
      userId: value.DEV_USER_ID,
      tenantId: value.DEV_TENANT_ID,
      tenantName: value.DEV_TENANT_NAME,
      facilityIds: [value.DEV_FACILITY_ID],
      role: value.DEV_ROLE,
      displayName: "開発用 管理者",
    },
  });
}
