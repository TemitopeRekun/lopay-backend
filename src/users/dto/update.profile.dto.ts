import { IsString, IsOptional, MinLength } from 'class-validator';

/**
 * Self-service profile update (`PATCH /users/me`). Deliberately narrow: a user
 * may change their display name and phone, but NOT their `role` or `email`
 * (those are admin/identity-provider concerns). Contrast with the admin-only
 * `UpdateUserDto`, which can set `role`.
 */
export class UpdateProfileDto {
  @IsString()
  @IsOptional()
  @MinLength(1)
  fullName?: string;

  @IsString()
  @IsOptional()
  phoneNumber?: string;
}
