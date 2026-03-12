import { IsString, IsOptional, IsInt, Min, Max } from 'class-validator';

export class VectorSearchDto {
  @IsString()
  sourceKey: string;

  @IsString()
  vectorField: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  k?: number;

  @IsOptional()
  @IsString()
  filter?: string;
}
