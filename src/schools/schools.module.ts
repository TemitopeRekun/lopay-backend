import { Module } from '@nestjs/common';
import { SchoolPaymentsController } from './schools.controller';
import { SchoolPaymentsService } from './schools.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [SchoolPaymentsController],
  providers: [SchoolPaymentsService],
})
export class SchoolsModule {}
