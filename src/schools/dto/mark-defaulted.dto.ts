import { IsNotEmpty, IsUUID } from 'class-validator';

export class MarkDefaultedDto {
  @IsUUID()
  @IsNotEmpty()
  enrollmentId: string;

  @IsUUID()
  @IsNotEmpty()
  schoolId: string;
}