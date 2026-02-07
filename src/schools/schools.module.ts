import { Module } from '@nestjs/common';
import { SchoolPaymentsController } from './schools.controller';
import { SchoolsManagementController } from './schools.management.controller';
import { SchoolPaymentsService } from './schools.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { FirebaseModule } from '../firebase/firebase.module';

@Module({
  imports: [PrismaModule, NotificationsModule, FirebaseModule],
  controllers: [SchoolPaymentsController, SchoolsManagementController],
  providers: [SchoolPaymentsService],
})
export class SchoolsModule {}
