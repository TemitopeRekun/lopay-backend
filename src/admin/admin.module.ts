import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';
import { DocumentsModule } from '../documents/documents.module';

@Module({
  imports: [NotificationsModule, AuthModule, DocumentsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
