import { SetMetadata } from '@nestjs/common';
import { Feature } from './types';

export const RequiresFeature = (feature: Feature | string) => SetMetadata('requiredFeature', feature);
