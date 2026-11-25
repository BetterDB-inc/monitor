export type PlacementMode = 'observe' | 'recommend' | 'approve' | 'auto';

export const PLACEMENT_MODES: readonly PlacementMode[] = ['observe', 'recommend', 'approve', 'auto'];

export const PLACEMENT_DEFAULT_MODE: PlacementMode = 'observe';

export interface PlacementPolicy {
  connectionId: string;
  mode: PlacementMode;
  updatedAt: number;
}
