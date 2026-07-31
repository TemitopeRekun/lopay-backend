import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { CreateClassFeeDto } from './create-class-fee.dto';

/**
 * A school's whole fee schedule, published in one call.
 *
 * Capped so a single request cannot ask for an unbounded transaction; no real
 * school has more than a few dozen classes.
 */
export class SetClassFeesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => CreateClassFeeDto)
  fees: CreateClassFeeDto[];
}
