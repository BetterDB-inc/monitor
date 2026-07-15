import {
  IsString,
  IsOptional,
  Matches,
  MinLength,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { parseMaxmemoryMi, MAX_VALKEY_MAXMEMORY_MI } from '../../provisioning/sizing';

// Caps the requested maxmemory at 2gb (the largest size offered in the UI) so
// a hand-crafted API call can't provision an arbitrarily large pod and volume.
@ValidatorConstraint({ name: 'valkeyMaxmemoryCap' })
export class ValkeyMaxmemoryCap implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const mi = parseMaxmemoryMi(value);
    return mi !== null && mi <= MAX_VALKEY_MAXMEMORY_MI;
  }

  defaultMessage(): string {
    return `maxmemory cannot exceed ${MAX_VALKEY_MAXMEMORY_MI / 1024}gb`;
  }
}

export class CreateValkeyInstanceDto {
  @IsString()
  tenantId: string;

  // Used as the release name and the public SNI host
  // (<name>.valkey.betterdb.com), so it must be a DNS-safe slug.
  // Capped at 25 chars: the name is wrapped into the StatefulSet/pod label
  // `valkey-<name>-valkey-search-<11-char-revision-hash>`, which must stay
  // under the k8s 63-character label limit or the pod is never scheduled.
  @IsString()
  @MinLength(3)
  @MaxLength(25)
  @Matches(/^[a-z][a-z0-9-]*[a-z0-9]$/, {
    message:
      'name must be lowercase alphanumeric with hyphens, starting with a letter and ending with alphanumeric',
  })
  name: string;

  // e.g. "768mb" / "2gb"; passed through to the chart's valkey.maxmemory.
  @IsOptional()
  @IsString()
  @Matches(/^\d+(kb|mb|gb)$/i, {
    message: 'maxmemory must be a number followed by kb, mb, or gb (e.g. 768mb)',
  })
  @Validate(ValkeyMaxmemoryCap)
  maxmemory?: string;
}
