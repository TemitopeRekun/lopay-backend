import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

/** Platform-wide announcement pushed to every parent. */
export class BroadcastNotificationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message: string;

  /** Optional in-app route to deep-link the announcement to. */
  @IsString()
  @IsOptional()
  link?: string;
}
