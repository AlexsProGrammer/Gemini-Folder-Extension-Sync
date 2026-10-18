import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class PushSyncDto {
  @IsInt()
  @Min(1)
  version: number;

  @IsString()
  @IsNotEmpty()
  ciphertext: string;

  @IsString()
  @IsNotEmpty()
  iv: string;

  @IsInt()
  @Min(1)
  updatedAt: number;
}