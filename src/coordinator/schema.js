import { z } from 'zod';
import { resolve } from 'node:path';
const absolute = z.string().startsWith('/').max(4096).refine(p => resolve(p) === p);
export const id = z.string().min(1).max(200);
export const ownerSchema = z.object({ pid: z.number().int().positive().safe(), nonce: z.string().uuid(), boot: z.string().uuid(), start: z.string().regex(/^[0-9]+$/) }).strict();
export const cursor = z.number().int().nonnegative().safe();
export const bindingSchema = z.object({ instance_id: id, task_id: id, run_id: id, revision: z.number().int().positive().safe(), runtime_id: id }).strict();
export const configSchema = z.object({ bridge_dir: absolute, cwd: absolute, binding: bindingSchema, title: id }).strict();
export const notificationSchema = z.object({ key: id, marker: id, source_cursor: cursor, status: z.enum(['pending','superseded','attempted','uncertain','sent','completed','failed','interrupted']), attempted_at: id.optional(), turn_id: id.optional(), result: z.string().max(1000000).optional(), final_status: id.optional(), error: id.optional() }).strict();
export const effectiveSchema = z.object({ model: id, cwd: absolute, approvalPolicy: z.unknown(), approvalsReviewer: z.unknown(), sandbox: z.unknown() });
export const stateSchema = z.object({ version: z.literal(1), config: configSchema, thread_id: id.optional(), lifecycle: z.enum(['prepared','creating','attaching','ready','uncertain']), effective: effectiveSchema.optional(), lifecycle_checks: z.array(z.object({ thread_id: id, checked_at: id, status: z.enum(['idle','notLoaded']), previous_error: id.nullable() }).strict()).max(1000).optional(), cursor: cursor.nullable(), baseline_cursor: cursor.nullable(), mode: id, last_state: id.optional(), error: id.nullable(), notifications: z.array(notificationSchema).max(1000), stats: z.object({ waits: cursor, timeouts: cursor, attempts: cursor }), updated_at: id }).strict();
export const snapshotSchema = z.object({ instance_id: id, runtime_id: id, task_id: id, revision: z.number().int().positive(), run: z.object({ id }).passthrough().nullable(), state: z.enum(['dispatching','running','execution_completed','cancel_requested','waiting_approval','awaiting_review','failed','needs_human','needs_recovery','cancelled','accepted','changes_requested']), event_cursor: cursor, evidence_cursor: cursor, spec: z.object({ workspace: absolute }).passthrough(), artifacts: z.unknown().optional() }).passthrough();
export const healthSchema = z.object({ instance_id: id, runtime_id: id, profile: z.literal('desktop') }).passthrough();
export const pageSchema = z.object({ items: z.array(z.object({ cursor }).passthrough()).max(50), next_cursor: cursor, has_more: z.boolean() }).passthrough();
export const threadSchema = z.object({ id, status: z.object({ type: z.enum(['idle','active','notLoaded','systemError']) }).passthrough() }).passthrough();
export const turnSchema = z.object({ id, status: z.enum(['inProgress','completed','failed','interrupted']), items: z.array(z.unknown()).optional() }).passthrough();
export const fail = code => { throw new Error(code); };
export function safeCode(error) { return /^[a-z][a-z0-9_]{0,120}$/.test(error?.message) ? error.message : 'operation_failed_check_local_environment'; }
