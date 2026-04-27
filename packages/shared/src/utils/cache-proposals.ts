import { z } from 'zod';

export const CacheTypeSchema = z.enum(['agent_cache', 'semantic_cache']);
export type CacheType = z.infer<typeof CacheTypeSchema>;

export const SEMANTIC_CACHE = 'semantic_cache' as const;
export const AGENT_CACHE = 'agent_cache' as const;

export const ProposalTypeSchema = z.enum(['threshold_adjust', 'tool_ttl_adjust', 'invalidate']);
export type ProposalType = z.infer<typeof ProposalTypeSchema>;

export const ProposalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'applied',
  'failed',
  'expired',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const ProposalAuditEventSchema = z.enum([
  'proposed',
  'approved',
  'rejected',
  'edited_and_approved',
  'applied',
  'failed',
  'expired',
]);
export type ProposalAuditEvent = z.infer<typeof ProposalAuditEventSchema>;

export const ActorSourceSchema = z.enum(['ui', 'mcp', 'system']);
export type ActorSource = z.infer<typeof ActorSourceSchema>;

export const SemanticThresholdAdjustPayloadSchema = z.object({
  category: z.string().nullable(),
  current_threshold: z.number().min(0).max(2),
  new_threshold: z.number().min(0).max(2),
});
export type SemanticThresholdAdjustPayload = z.infer<typeof SemanticThresholdAdjustPayloadSchema>;

export const AgentToolTtlAdjustPayloadSchema = z.object({
  tool_name: z.string().min(1),
  current_ttl_seconds: z.number().int().min(0),
  new_ttl_seconds: z.number().int().min(10).max(86400),
});
export type AgentToolTtlAdjustPayload = z.infer<typeof AgentToolTtlAdjustPayloadSchema>;

export const SemanticInvalidatePayloadSchema = z.object({
  filter_kind: z.literal('valkey_search'),
  filter_expression: z.string().min(1),
  estimated_affected: z.number().int().min(0),
});
export type SemanticInvalidatePayload = z.infer<typeof SemanticInvalidatePayloadSchema>;

export const AgentInvalidatePayloadSchema = z.object({
  filter_kind: z.enum(['tool', 'key_prefix', 'session']),
  filter_value: z.string().min(1),
  estimated_affected: z.number().int().min(0),
});
export type AgentInvalidatePayload = z.infer<typeof AgentInvalidatePayloadSchema>;

export const CacheProposalUnionSchema = z.union([
  z.object({
    cache_type: z.literal('semantic_cache'),
    proposal_type: z.literal('threshold_adjust'),
    proposal_payload: SemanticThresholdAdjustPayloadSchema,
  }),
  z.object({
    cache_type: z.literal('semantic_cache'),
    proposal_type: z.literal('invalidate'),
    proposal_payload: SemanticInvalidatePayloadSchema,
  }),
  z.object({
    cache_type: z.literal('agent_cache'),
    proposal_type: z.literal('tool_ttl_adjust'),
    proposal_payload: AgentToolTtlAdjustPayloadSchema,
  }),
  z.object({
    cache_type: z.literal('agent_cache'),
    proposal_type: z.literal('invalidate'),
    proposal_payload: AgentInvalidatePayloadSchema,
  }),
]);
export type CacheProposalUnion = z.infer<typeof CacheProposalUnionSchema>;

export const ProposalPayloadSchema = z.union([
  SemanticThresholdAdjustPayloadSchema,
  AgentToolTtlAdjustPayloadSchema,
  SemanticInvalidatePayloadSchema,
  AgentInvalidatePayloadSchema,
]);
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

export const AppliedResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type AppliedResult = z.infer<typeof AppliedResultSchema>;

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

const CacheProposalCommonSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  cache_name: z.string(),
  reasoning: z.string().nullable(),
  status: ProposalStatusSchema,
  proposed_by: z.string().nullable(),
  proposed_at: epochMs,
  reviewed_by: z.string().nullable(),
  reviewed_at: epochMsNullable,
  applied_at: epochMsNullable,
  applied_result: jsonColumn(AppliedResultSchema.nullable()),
  expires_at: epochMs,
});

const SemanticThresholdAdjustVariantSchema = z.object({
  cache_type: z.literal('semantic_cache'),
  proposal_type: z.literal('threshold_adjust'),
  proposal_payload: jsonColumn(SemanticThresholdAdjustPayloadSchema),
});

const SemanticInvalidateVariantSchema = z.object({
  cache_type: z.literal('semantic_cache'),
  proposal_type: z.literal('invalidate'),
  proposal_payload: jsonColumn(SemanticInvalidatePayloadSchema),
});

const AgentToolTtlAdjustVariantSchema = z.object({
  cache_type: z.literal('agent_cache'),
  proposal_type: z.literal('tool_ttl_adjust'),
  proposal_payload: jsonColumn(AgentToolTtlAdjustPayloadSchema),
});

const AgentInvalidateVariantSchema = z.object({
  cache_type: z.literal('agent_cache'),
  proposal_type: z.literal('invalidate'),
  proposal_payload: jsonColumn(AgentInvalidatePayloadSchema),
});

const StoredCacheProposalUnionSchema = z.union([
  SemanticThresholdAdjustVariantSchema,
  SemanticInvalidateVariantSchema,
  AgentToolTtlAdjustVariantSchema,
  AgentInvalidateVariantSchema,
]);

export const StoredCacheProposalSchema = z.intersection(
  CacheProposalCommonSchema,
  StoredCacheProposalUnionSchema,
);
export type StoredCacheProposal = z.infer<typeof StoredCacheProposalSchema>;

export const StoredCacheProposalAuditSchema = z.object({
  id: z.string(),
  proposal_id: z.string(),
  event_type: ProposalAuditEventSchema,
  event_payload: jsonColumn(z.record(z.string(), z.unknown()).nullable()),
  event_at: epochMs,
  actor: z.string().nullable(),
  actor_source: ActorSourceSchema,
});
export type StoredCacheProposalAudit = z.infer<typeof StoredCacheProposalAuditSchema>;

const CreateCacheProposalCommonSchema = z.object({
  id: z.string(),
  connection_id: z.string(),
  cache_name: z.string(),
  reasoning: z.string().nullish(),
  proposed_by: z.string().nullish(),
  proposed_at: z.number().optional(),
  expires_at: z.number().optional(),
});

export const CreateCacheProposalInputSchema = z.intersection(
  CreateCacheProposalCommonSchema,
  CacheProposalUnionSchema,
);
export type CreateCacheProposalInput = z.infer<typeof CreateCacheProposalInputSchema>;

export const ListCacheProposalsOptionsSchema = z.object({
  connection_id: z.string(),
  status: z.union([ProposalStatusSchema, z.array(ProposalStatusSchema)]).optional(),
  cache_name: z.string().optional(),
  cache_type: CacheTypeSchema.optional(),
  proposal_type: ProposalTypeSchema.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
export type ListCacheProposalsOptions = z.infer<typeof ListCacheProposalsOptionsSchema>;

export const UpdateProposalStatusInputSchema = z.object({
  id: z.string(),
  expected_status: z.union([ProposalStatusSchema, z.array(ProposalStatusSchema)]).optional(),
  status: ProposalStatusSchema,
  reviewed_by: z.string().nullish(),
  reviewed_at: z.number().nullish(),
  applied_at: z.number().nullish(),
  applied_result: AppliedResultSchema.nullish(),
  proposal_payload: ProposalPayloadSchema.optional(),
});
export type UpdateProposalStatusInput = z.infer<typeof UpdateProposalStatusInputSchema>;

export const AppendProposalAuditInputSchema = z.object({
  id: z.string(),
  proposal_id: z.string(),
  event_type: ProposalAuditEventSchema,
  event_payload: z.record(z.string(), z.unknown()).nullish(),
  event_at: z.number().optional(),
  actor: z.string().nullish(),
  actor_source: ActorSourceSchema,
});
export type AppendProposalAuditInput = z.infer<typeof AppendProposalAuditInputSchema>;

export const PROPOSAL_DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function variantPayloadSchemaFor(
  cacheType: CacheType,
  proposalType: ProposalType,
): z.ZodType<ProposalPayload> {
  if (cacheType === 'semantic_cache' && proposalType === 'threshold_adjust') {
    return SemanticThresholdAdjustPayloadSchema;
  }
  if (cacheType === 'semantic_cache' && proposalType === 'invalidate') {
    return SemanticInvalidatePayloadSchema;
  }
  if (cacheType === 'agent_cache' && proposalType === 'tool_ttl_adjust') {
    return AgentToolTtlAdjustPayloadSchema;
  }
  if (cacheType === 'agent_cache' && proposalType === 'invalidate') {
    return AgentInvalidatePayloadSchema;
  }
  throw new Error(
    `Unknown (cache_type, proposal_type) combination: ${cacheType}/${proposalType}`,
  );
}
