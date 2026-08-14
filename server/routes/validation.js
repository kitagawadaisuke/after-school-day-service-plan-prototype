import { z } from "zod";
import { badRequest, preconditionRequired } from "../errors.js";

export const uuidSchema = z.string().uuid();
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD形式で入力してください");
export const dateTimeSchema = z.string().datetime({ offset: true });

export const addressSchema = z
  .object({
    postalCode: z.string().trim().max(16).optional(),
    prefecture: z.string().trim().max(20).optional(),
    city: z.string().trim().max(100).optional(),
    line1: z.string().trim().max(200).optional(),
    line2: z.string().trim().max(200).optional(),
  })
  .strict();

export const emergencyContactSchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    relationship: z.string().trim().max(50).optional(),
    phone: z.string().trim().max(50).optional(),
  })
  .strict();

export function parseInput(schema, value) {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw badRequest(
    "VALIDATION_ERROR",
    "入力内容を確認してください。",
    parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}

export function parseIfMatch(request) {
  const header = request.headers["if-match"];
  const match = typeof header === "string" ? header.match(/^(?:W\/)?"?(\d+)"?$/) : null;
  if (!match) throw preconditionRequired();
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) throw preconditionRequired();
  return version;
}

export function setVersionEtag(reply, entity) {
  if (entity?.rowVersion) reply.header("ETag", `"${entity.rowVersion}"`);
  return entity;
}
