import { IsEmail, IsString, MinLength, IsOptional, Length } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(10)
  password: string;

  @IsOptional()
  @IsString()
  displayName?: string;

  // Client may hint a country (e.g. from app locale), but the backend must
  // ultimately resolve/verify this server-side (IP, phone prefix, etc.) —
  // never trust this field alone for legal/regional gating.
  @IsString()
  @Length(2, 2)
  countryCode: string;

  @IsOptional()
  @IsString()
  referralCode?: string;
}
