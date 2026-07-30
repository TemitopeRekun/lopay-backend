import {
  Controller,
  Get,
  Body,
  Param,
  Delete,
  Put,
  Patch,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update.user.dto';
import { UpdateProfileDto } from './dto/update.profile.dto';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/user.decorator';
import { UserRole } from '../generated/prisma/client';

// Auth + roles enforced globally (BetterAuthGuard + RolesGuard).
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ─── Self-service profile (any authenticated user, scoped to themselves) ───
  // Declared before the parameterised ':id' routes so 'me' is never captured as
  // an :id.
  @Get('me')
  @ApiOperation({ summary: 'Get the current authenticated user profile' })
  getMe(@CurrentUser('userId') userId: string) {
    return this.usersService.findOne(userId);
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the current authenticated user profile' })
  updateMe(
    @CurrentUser('userId') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(userId, dto);
  }

  // ─── Admin user management (SUPER_ADMIN only) ──────────────────────────────
  @Get()
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List all users' })
  findAll() {
    return this.usersService.findAll();
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get a user by id' })
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  // PATCH is the canonical verb (partial update) and matches the client; PUT is
  // kept as an alias for back-compat and removed in a later milestone.
  @Patch(':id')
  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update a user by id' })
  update(@Param('id') id: string, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(id, updateUserDto);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete a user by id' })
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }
}
