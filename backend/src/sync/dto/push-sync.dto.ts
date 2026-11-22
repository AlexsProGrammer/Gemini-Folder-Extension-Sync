import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

const BASE64_PATTERN = /^[A-Za-z0-9+/=]+$/;

export class PushSyncDto {
  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  baseVersion?: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  @Matches(BASE64_PATTERN)
  ciphertext: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(BASE64_PATTERN)
  iv: string;

  @IsInt()
  @Min(1)
  updatedAt: number;
}