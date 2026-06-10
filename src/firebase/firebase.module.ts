import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initializeApp, cert, getApps, getApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { getMessaging } from 'firebase-admin/messaging';
import type { App } from 'firebase-admin/app';

export const FIREBASE_APP = 'FIREBASE_APP';
export const FIREBASE_STORAGE = 'FIREBASE_STORAGE';
export const FIREBASE_MESSAGING = 'FIREBASE_MESSAGING';

function createFirebaseApp(config: ConfigService): App {
  const projectId = config.get<string>('FIREBASE_PROJECT_ID');
  const clientEmail = config.get<string>('FIREBASE_CLIENT_EMAIL');
  // Env stores the PEM with literal "\n" escape sequences (single-line var).
  // firebase-admin's cert() needs real newlines, so normalize them here.
  const privateKey = config
    .get<string>('FIREBASE_PRIVATE_KEY')
    ?.replace(/\\n/g, '\n');

  if (getApps().length === 0) {
    return initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
      storageBucket: config.get<string>('FIREBASE_STORAGE_BUCKET'),
    });
  }
  return getApp();
}

@Global()
@Module({
  providers: [
    {
      provide: FIREBASE_APP,
      inject: [ConfigService],
      useFactory: createFirebaseApp,
    },
    {
      provide: FIREBASE_STORAGE,
      inject: [FIREBASE_APP],
      useFactory: (app: App) => getStorage(app),
    },
    {
      provide: FIREBASE_MESSAGING,
      inject: [FIREBASE_APP],
      useFactory: (app: App) => getMessaging(app),
    },
  ],
  exports: [FIREBASE_APP, FIREBASE_STORAGE, FIREBASE_MESSAGING],
})
export class FirebaseModule {}
