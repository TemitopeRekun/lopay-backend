import { Test, TestingModule } from '@nestjs/testing';
import { SchoolsManagementController } from './schools.management.controller';
import { SchoolPaymentsService } from './schools.service';
import type { CreateSchoolDto } from '../admin/dto/create.school.dto';
import type { UpdateSchoolDto } from './dto/update.school.dto';

describe('SchoolsManagementController', () => {
  let controller: SchoolsManagementController;

  const service = {
    getPublicSchools: jest.fn().mockResolvedValue([{ id: 's1', name: 'ABC' }]),
    createSchool: jest.fn().mockResolvedValue({ id: 's1' }),
    updateSchool: jest.fn().mockResolvedValue({ id: 's1', updated: true }),
    deleteSchool: jest.fn().mockResolvedValue({ deleted: true }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SchoolsManagementController],
      providers: [{ provide: SchoolPaymentsService, useValue: service }],
    }).compile();
    controller = module.get<SchoolsManagementController>(
      SchoolsManagementController,
    );
  });

  it('findAll passes the search term to the public directory', () => {
    controller.findAll('abc');
    expect(service.getPublicSchools).toHaveBeenCalledWith('abc');
  });

  it('create delegates the dto', () => {
    const dto = { schoolName: 'New School' } as CreateSchoolDto;
    controller.create(dto);
    expect(service.createSchool).toHaveBeenCalledWith(dto);
  });

  it('update delegates the id and dto', () => {
    const dto = { schoolName: 'Renamed' } as UpdateSchoolDto;
    controller.update('s1', dto);
    expect(service.updateSchool).toHaveBeenCalledWith('s1', dto);
  });

  it('remove delegates the id', () => {
    controller.remove('s1');
    expect(service.deleteSchool).toHaveBeenCalledWith('s1');
  });
});
