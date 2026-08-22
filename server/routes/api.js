import { auditEventRoutes } from "./audit-events.js";
import { childRoutes } from "./children.js";
import { caseContextRoutes } from "./case-context.js";
import { contactBookRoutes } from "./contact-book.js";
import { dailyLogRoutes } from "./daily-logs.js";
import { documentRoutes } from "./documents.js";
import { documentSnapshotRoutes } from "./document-snapshots.js";
import { documentWorkflowRoutes } from "./document-workflow.js";
import { draftGenerationRoutes } from "./draft-generation.js";
import { facilityRoutes } from "./facilities.js";
import { guardianRoutes } from "./guardians.js";
import { registerPiiReadAuditHook } from "../pii-read-audit.js";
import { sessionRoutes } from "./session.js";
import { scheduleRoutes } from "./schedules.js";
import { tenantAdminRoutes } from "./tenant-admin.js";
import { writingAssistRoutes } from "./writing-assist.js";

export async function apiRoutes(app) {
  app.decorateRequest("actor", null);
  app.addHook("preHandler", async (request) => {
    request.actor = await app.authenticateRequest(request);
  });
  registerPiiReadAuditHook(app);

  await app.register(sessionRoutes);
  await app.register(auditEventRoutes);
  await app.register(tenantAdminRoutes);
  await app.register(facilityRoutes);
  await app.register(childRoutes);
  await app.register(caseContextRoutes);
  await app.register(guardianRoutes);
  await app.register(dailyLogRoutes);
  await app.register(writingAssistRoutes);
  await app.register(contactBookRoutes);
  await app.register(scheduleRoutes);
  await app.register(documentRoutes);
  await app.register(documentSnapshotRoutes);
  await app.register(documentWorkflowRoutes);
  await app.register(draftGenerationRoutes);
}
