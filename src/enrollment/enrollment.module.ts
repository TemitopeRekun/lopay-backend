import { Module } from '@nestjs/common';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentController } from './enrollment.controller';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EventsModule } from '../events/events.module';
import { AuditModule } from '../audit/audit.module';
import { PaystackModule } from '../paystack/paystack.module';
import { PaystackWebhookController } from './paystack-webhook.controller';

@Module({
  imports: [PaymentsModule, NotificationsModule, EventsModule, AuditModule, PaystackModule],
  providers: [EnrollmentService],
  controllers: [EnrollmentController, PaystackWebhookController],
  exports: [EnrollmentService],
})
export class EnrollmentModule {}
