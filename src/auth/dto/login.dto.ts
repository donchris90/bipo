import { IsEmail, IsString, IsOptional, Length } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
  @IsOptional()
  @IsString()
  @Length(16, 200)
  deviceId?: string;
}
