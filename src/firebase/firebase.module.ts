import { Module } from '@nestjs/common';
import { FirebaseAdminProvider } from './firebase-admin.provider';

@Module({
  providers: [FirebaseAdminProvider],
  exports: [FirebaseAdminProvider],
})
export class FirebaseModule {}
