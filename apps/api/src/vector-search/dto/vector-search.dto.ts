import { IsString, IsNotEmpty, IsOptional, IsInt, Min, Max } from 'class-validator';

export class VectorSearchDto {
  @IsString()
  @IsNotEmpty()
  sourceKey: string;

  @IsString()
  @IsNotEmpty()
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
