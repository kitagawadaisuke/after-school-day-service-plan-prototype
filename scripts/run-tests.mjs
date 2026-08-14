// Importing node:test suites in one process avoids Windows child-process issues
// while preserving standard TAP output and exit codes.
await import("../tests/plan-engine.test.mjs");
await import("../tests/permissions.test.mjs");
await import("../tests/server-foundation.test.mjs");
await import("../tests/database-schema.test.mjs");
await import("../tests/infra-contract.test.mjs");
await import("../tests/cognito-auth.test.mjs");
await import("../tests/document-api.test.mjs");
await import("../tests/saas-frontend.test.mjs");
await import("../tests/document-workflow.test.mjs");
await import("../tests/document-state-integrity.test.mjs");
await import("../tests/draft-generation.test.mjs");
await import("../tests/tenant-admin-api.test.mjs");
await import("../tests/schedule-api.test.mjs");
await import("../tests/guardian-api.test.mjs");
await import("../tests/document-snapshot.test.mjs");
await import("../tests/case-context-api.test.mjs");
await import("../tests/field-encryption.test.mjs");
await import("../tests/migration-runner.test.mjs");
await import("../tests/initial-onboarding.test.mjs");
await import("../tests/facility-api.test.mjs");
await import("../tests/rls-rbac-parity.test.mjs");
await import("../tests/security-audit.test.mjs");
