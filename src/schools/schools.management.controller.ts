import {
  Controller,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Get,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SchoolPaymentsService } from './schools.service';
import { CreateSchoolDto } from '../admin/dto/create.school.dto';
import { UpdateSchoolDto } from './dto/update.school.dto';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';

import { Public } from '../common/decorators/public.decorator';

@ApiTags('schools')
@ApiBearerAuth()
@Controller('schools')
export class SchoolsManagementController {
  constructor(private readonly schoolsService: SchoolPaymentsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Public school directory (id + name only)' })
  findAll(@Query('search') search: string) {
    // Public directory: id + name only (no PII). See getPublicSchools.
    return this.schoolsService.getPublicSchools(search);
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a school' })
  create(@Body() createSchoolDto: CreateSchoolDto) {
    return this.schoolsService.createSchool(createSchoolDto);
  }

  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update a school by id' })
  update(@Param('id') id: string, @Body() updateSchoolDto: UpdateSchoolDto) {
    return this.schoolsService.updateSchool(id, updateSchoolDto);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete a school by id' })
  remove(@Param('id') id: string) {
    return this.schoolsService.deleteSchool(id);
  }
}
