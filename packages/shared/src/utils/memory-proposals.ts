import { z } from 'zod';
import {
  ProposalAuditEventSchema,
  ActorSourceSchema,
  AppliedResultSchema,
} from './cache-proposals';

// Memory proposals add an intermediate `applying` state between `approved` and
// `applied`: the forget is claimed (approved -> applying) before it runs, and
// only reaches `applied` once the deletion succeeds. A crash mid-apply therefore
// leaves a visible `applying` row rather than a false `applied`.
export const MemoryProposalStatusSchema = z.enum([
  'pending',
  'approved',
  'applying',
  'applied',
  'failed',
  'rejected',
  'expired',
]);
export type MemoryProposalStatus = z.infer<typeof MemoryProposalStatusSchema>;

export const MemoryProposalTypeSchema = z.literal('forget');
export type MemoryProposalType = z.infer<typeof MemoryProposalTypeSchema>;

export const MemoryProposalScopeSchema = z.object({
  threadId: z.string().optional(),
  agentId: z.string().optional(),
  namespace: z.string().optional(),
});
export type MemoryProposalScope = z.infer<typeof MemoryProposalScopeSchema>;

export const MemoryForgetByIdPayloadSchema = z.object({
  target_kind: z.literal('id'),
  memory_id: z.string().min(1),
});
export type MemoryForgetByIdPayload = z.infer<typeof MemoryForgetByIdPayloadSchema>;

export const MemoryForgetByScopePayloadSchema = z.object({
  target_kind: z.literal('scope'),
  scope: MemoryProposalScopeSchema.optional(),
  tags: z.array(z.string()).optional(),
});
export type MemoryForgetByScopePayload = z.infer<typeof MemoryForgetByScopePayloadSchema>;

export const MemoryForgetPayloadSchema = z.discriminatedUnion('target_kind', [
  MemoryForgetByIdPayloadSchema,
  MemoryForgetByScopePayloadSchema,
]);
export type MemoryForgetPayload = z.infer<typeof MemoryForgetPayloadSchema>;

const epochMs = z.preprocess((v) => {
  if (typeof v === 'number' || v == null) {
    return v;
  }
  return Number(v);
}, z.number());

const epochMsNullable = z.preprocess((v) => {
  if (v == null) {
    return null;
  }
  if (typeof v === 'number') {
    return v;
  }
  return Number(v);
}, z.number().nullable());

const jsonColumn = <T extends z.ZodType>(schema: T) => {
  return z.preprocess((v) => {
    if (typeof v === 'string') {
      return JSON.parse(v);
    }
    return v;
  }, schema);
};

export const StoredMemoryProposalSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  store_name: z.string(),
  reasoning: z.string().nullable(),
  status: MemoryProposalStatusSchema,
  proposed_by: z.string().nullable(),
  proposed_at: epochMs,
  reviewed_by: z.string().nullable(),
  reviewed_at: epochMsNullable,
  // When `approved -> applying` was claimed. Distinct from reviewed_at, which
  // records approval: the two coincide today only because approve and apply
  // happen in one request, and a stale-apply sweep measured off reviewed_at
  // would start sweeping live work the moment that stops being true.
  applying_at: epochMsNullable.optional().default(null),
  applied_at: epochMsNullable,
  applied_result: jsonColumn(AppliedResultSchema.nullable()),
  expires_at: epochMs,
  proposal_type: MemoryProposalTypeSchema,
  proposal_payload: jsonColumn(MemoryForgetPayloadSchema),
  // Stable key for the forget target, materialised at insert so the
  // duplicate-pending guard can be a uniqueness constraint instead of a
  // read-then-write race. Nullable for rows written before this column existed.
  target_discriminator: z.string().nullable().optional().default(null),
});
export type StoredMemoryProposal = z.infer<typeof StoredMemoryProposalSchema>;

export const StoredMemoryProposalAuditSchema = z.object({
  id: z.string(),
  proposal_id: z.string(),
  event_type: ProposalAuditEventSchema,
  event_payload: jsonColumn(z.record(z.string(), z.unknown()).nullable()),
  event_at: epochMs,
  actor: z.string().nullable(),
  actor_source: ActorSourceSchema,
});
export type StoredMemoryProposalAudit = z.infer<typeof StoredMemoryProposalAuditSchema>;

export const CreateMemoryProposalInputSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  store_name: z.string(),
  reasoning: z.string().nullish(),
  proposed_by: z.string().nullish(),
  proposed_at: z.number().optional(),
  expires_at: z.number().optional(),
  proposal_type: MemoryProposalTypeSchema,
  proposal_payload: MemoryForgetPayloadSchema,
  target_discriminator: z.string().optional(),
});
export type CreateMemoryProposalInput = z.infer<typeof CreateMemoryProposalInputSchema>;

export const ListMemoryProposalsOptionsSchema = z.object({
  connection_id: z.string(),
  status: z.union([MemoryProposalStatusSchema, z.array(MemoryProposalStatusSchema)]).optional(),
  store_name: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
export type ListMemoryProposalsOptions = z.infer<typeof ListMemoryProposalsOptionsSchema>;

export const UpdateMemoryProposalStatusInputSchema = z.object({
  id: z.string(),
  expected_status: z
    .union([MemoryProposalStatusSchema, z.array(MemoryProposalStatusSchema)])
    .optional(),
  status: MemoryProposalStatusSchema,
  reviewed_by: z.string().nullish(),
  reviewed_at: z.number().nullish(),
  applying_at: z.number().nullish(),
  applied_at: z.number().nullish(),
  applied_result: AppliedResultSchema.nullish(),
  proposal_payload: MemoryForgetPayloadSchema.optional(),
});
export type UpdateMemoryProposalStatusInput = z.infer<typeof UpdateMemoryProposalStatusInputSchema>;

export const AppendMemoryProposalAuditInputSchema = z.object({
  id: z.string(),
  proposal_id: z.string(),
  event_type: ProposalAuditEventSchema,
  event_payload: z.record(z.string(), z.unknown()).nullish(),
  event_at: z.number().optional(),
  actor: z.string().nullish(),
  actor_source: ActorSourceSchema,
});
export type AppendMemoryProposalAuditInput = z.infer<typeof AppendMemoryProposalAuditInputSchema>;

export const MEMORY_PROPOSAL_DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Stable identity for what a forget proposal targets — two proposals with the
 * same discriminator are duplicates of each other.
 *
 * Scope keys are emitted in a fixed order rather than via `JSON.stringify` on
 * the object: stringify follows insertion order, so `{threadId, agentId}` and
 * `{agentId, threadId}` describe the same target and would otherwise produce
 * different keys. Harmless while this was only compared in memory; permanent
 * once it backs a uniqueness constraint.
 *
 * Absent and empty-string scope fields are deliberately the same thing — both
 * mean "not scoped by this dimension".
 */
export function memoryForgetTargetDiscriminator(payload: MemoryForgetPayload): string {
  if (payload.target_kind === 'id') {
    return `id:${payload.memory_id}`;
  }
  const scope = payload.scope ?? {};
  const scopeKey = (['agentId', 'namespace', 'threadId'] as const)
    .map((field) => {
      return `${field}=${scope[field] ?? ''}`;
    })
    .join('&');
  const tags = Array.isArray(payload.tags) ? [...payload.tags].sort() : [];
  return `scope:${scopeKey}|tags:${tags.join(',')}`;
}
