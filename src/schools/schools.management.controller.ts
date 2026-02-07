import { Controller, Post, Put, Delete, Body, Param, UseGuards, Get, Query } from '@nestjs/common';
import { SchoolPaymentsService } from './schools.service';
import { CreateSchoolDto } from '../admin/dto/create.school.dto';
import { UpdateSchoolDto } from './dto/update.school.dto';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { UserRole } from '../generated/prisma/client';

import { Public } from '../common/decorators/public.decorator';

@Controller('schools')
export class SchoolsManagementController {
  constructor(private readonly schoolsService: SchoolPaymentsService) {}

  @Public()
  @Get()
  findAll(@Query('search') search: string) {
    return this.schoolsService.getAllSchools(search);
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN)
  create(@Body() createSchoolDto: CreateSchoolDto) {
    return this.schoolsService.createSchool(createSchoolDto);
  }

  @Put(':id')
  @Roles(UserRole.SUPER_ADMIN)
  update(@Param('id') id: string, @Body() updateSchoolDto: UpdateSchoolDto) {
    return this.schoolsService.updateSchool(id, updateSchoolDto);
  }

  @Delete(':id')
  @Roles(UserRole.SUPER_ADMIN)
  remove(@Param('id') id: string) {
    return this.schoolsService.deleteSchool(id);
  }
}
