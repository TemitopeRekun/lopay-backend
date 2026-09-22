import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiHeader,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser, AuthUser } from '../common/decorators/user.decorator';
import { UserRole } from '../generated/prisma/client';
import { EnrollmentInvitesService } from './enrollment-invites.service';
import { CreateEnrollmentInviteDto } from './dto/create-enrollment-invite.dto';
import {
  AmendMigratedPaymentDto,
  ClaimEnrollmentInviteDto,
  DisputeEnrollmentInviteDto,
  ListEnrollmentInvitesDto,
  RevokeEnrollmentInviteDto,
} from './dto/claim-enrollment-invite.dto';

/** Header carrying the claim token on the GET preview, which has no body. */
export const INVITE_TOKEN_HEADER = 'x-invite-token';

@ApiTags('enrollment-invites')
@Controller('enrollment-invites')
export class EnrollmentInvitesController {
  constructor(private readonly service: EnrollmentInvitesService) {}

  /**
   * Declared first so `preview` can never be swallowed by a future `:id` route.
   *
   * Public by necessity: a parent follows this link before they have an account,
   * and the screen has to render the figures they are being asked to confirm.
   * The token is the only gate, which is why the throttle here is the tightest
   * on the controller and why the response body (`ParentInviteView`) is a
   * deliberately thin allow-list.
   *
   * The token travels in a header rather than the query string: a GET has no
   * body, and a query string would put a bearer credential into access logs,
   * browser history and `Referer`.
   */
  @Get('preview')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiHeader({
    name: INVITE_TOKEN_HEADER,
    required: true,
    description: 'The raw claim token from the invite link.',
  })
  @ApiOperation({ summary: 'Preview an enrollment invite before signing in' })
  preview(@Headers(INVITE_TOKEN_HEADER) token: string) {
    return this.service.preview(token);
  }

  @Post()
  @ApiBearerAuth()
  @Roles(UserRole.SCHOOL_OWNER)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiOperation({
    summary: 'Invite a parent who already paid the school before Lopay',
  })
  create(
    @Body() dto: CreateEnrollmentInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.create(dto, user);
  }

  @SkipThrottle()
  @Get()
  @ApiBearerAuth()
  @Roles(UserRole.SCHOOL_OWNER)
  @ApiOperation({ summary: "List this school's enrollment invites" })
  list(
    @Query() query: ListEnrollmentInvitesDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.list(user, query);
  }

  @Post(':id/revoke')
  @ApiBearerAuth()
  @Roles(UserRole.SCHOOL_OWNER)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Cancel a live invite so it can be re-issued' })
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeEnrollmentInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.revoke(id, user, dto.reason);
  }

  /**
   * Correct the already-paid figure on a plan that has already been claimed.
   * Separate from revoke because there is a live plan behind it — see
   * `LedgerService.amendMigratedPayment`.
   */
  @Post(':id/amend')
  @ApiBearerAuth()
  @Roles(UserRole.SCHOOL_OWNER)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Correct the amount recorded on a claimed invite' })
  amend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AmendMigratedPaymentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.amend(id, dto, user);
  }

  /**
   * Remove a plan claimed by the wrong person, and free the student to be
   * re-invited.
   *
   * Separate from both `revoke` (cancels an unused link) and `amend` (restates
   * a wrong figure on the right family's plan). This one deletes rows, so it is
   * throttled tightest of the owner endpoints.
   */
  @Post(':id/release')
  @ApiBearerAuth()
  @Roles(UserRole.SCHOOL_OWNER)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({ summary: 'Remove a plan claimed by the wrong person' })
  release(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeEnrollmentInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.release(id, user, dto.reason);
  }

  /**
   * Claim an invite.
   *
   * Authenticated but deliberately NOT role-gated. A school owner can be a
   * parent at another school, and gating on `UserRole.PARENT` would lock that
   * person out of their own child's plan — a bug already fixed once in
   * `EnrollmentService.submitInstallmentPayment`. Authorisation is the phone
   * match inside the service, which is the real relationship.
   */
  @Post('claim')
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Claim an enrollment invite and activate the plan' })
  claim(@Body() dto: ClaimEnrollmentInviteDto, @CurrentUser() user: AuthUser) {
    return this.service.claim(dto.token, user);
  }

  @Post('dispute')
  @ApiBearerAuth()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: 'Contest the amount recorded on an invite' })
  dispute(
    @Body() dto: DisputeEnrollmentInviteDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.dispute(dto.token, user, dto.reason);
  }
}
