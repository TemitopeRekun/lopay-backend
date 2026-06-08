import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { DocumentsModule } from '../documents/documents.module';
import { AuditModule } from '../audit/audit.module';
import { PaystackModule } from '../paystack/paystack.module';

// Better Auth's AuthService is provided globally (AuthModule.forRootAsync isGlobal),
// so no auth module import is needed here.
@Module({
  imports: [NotificationsModule, DocumentsModule, AuditModule, PaystackModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
