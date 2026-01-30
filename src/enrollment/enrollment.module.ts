import { Module } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentController } from './enrollment.controller';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PaymentsModule, NotificationsModule],
  providers: [EnrollmentService],
  controllers: [EnrollmentController]
})
export class EnrollmentModule {}
