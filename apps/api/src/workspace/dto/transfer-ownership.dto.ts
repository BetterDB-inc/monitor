import { IsNotEmpty, IsString } from 'class-validator';

export class TransferOwnershipDto {
  @IsString()
  @IsNotEmpty()
  userId: string;
}
