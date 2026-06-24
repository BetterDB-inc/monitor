import { z } from 'zod';
import {
  ProposalStatusSchema,
  ProposalAuditEventSchema,
  ActorSourceSchema,
  AppliedResultSchema,
} from './cache-proposals';

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
  status: ProposalStatusSchema,
  proposed_by: z.string().nullable(),
  proposed_at: epochMs,
  reviewed_by: z.string().nullable(),
  reviewed_at: epochMsNullable,
  applied_at: epochMsNullable,
  applied_result: jsonColumn(AppliedResultSchema.nullable()),
  expires_at: epochMs,
  proposal_type: MemoryProposalTypeSchema,
  proposal_payload: jsonColumn(MemoryForgetPayloadSchema),
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
});
export type CreateMemoryProposalInput = z.infer<typeof CreateMemoryProposalInputSchema>;

export const ListMemoryProposalsOptionsSchema = z.object({
  connection_id: z.string(),
  status: z.union([ProposalStatusSchema, z.array(ProposalStatusSchema)]).optional(),
  store_name: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
export type ListMemoryProposalsOptions = z.infer<typeof ListMemoryProposalsOptionsSchema>;

export const UpdateMemoryProposalStatusInputSchema = z.object({
  id: z.string(),
  expected_status: z.union([ProposalStatusSchema, z.array(ProposalStatusSchema)]).optional(),
  status: ProposalStatusSchema,
  reviewed_by: z.string().nullish(),
  reviewed_at: z.number().nullish(),
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
