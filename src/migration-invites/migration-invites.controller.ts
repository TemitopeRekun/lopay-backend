import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';
import { CreateMigrationInviteDto } from './dto/create-migration-invite.dto';
import { MigrationDisputeDto } from './dto/migration-dispute.dto';
import { ClaimMigrationInviteDto } from './dto/claim-migration-invite.dto';
import { MigrationInvitesService } from './migration-invites.service';

@ApiTags('migration-invites')
@Controller('migration-invites')
export class MigrationInvitesController {
  constructor(private readonly service: MigrationInvitesService) {}

  @Post()
  @ApiBearerAuth()
  @Roles(UserRole.SCHOOL_OWNER)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Create a one-time invite for a parent-paid student' })
  create(@Body() dto: CreateMigrationInviteDto, @CurrentUser() user: AuthUser) {
    return this.service.create(dto, user);
  }

  @Get('preview')
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Preview a migration invite before signing in' })
  preview(@Headers('x-migration-token') token: string) {
    return this.service.preview(token);
  }

  @Post('dispute')
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Dispute the amount recorded on a migration invite' })
  dispute(@Body() dto: MigrationDisputeDto, @CurrentUser() user: AuthUser) {
    return this.service.dispute(dto.token, user, dto.reason);
  }

  @Post('claim')
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Claim and activate a confirmed migration invite' })
  claim(@Body() dto: ClaimMigrationInviteDto, @CurrentUser() user: AuthUser) {
    return this.service.claim(dto.token, user);
  }
}