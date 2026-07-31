import { NotificationType } from '../../generated/prisma/client';

export class CreateNotificationDto {
  userId: string; // Who receives the notification
  title: string;
  message: string;
  /** Drives the recipient's filter tabs. Defaults to PAYMENT (see the schema). */
  type?: NotificationType;
  link?: string; // Optional link to frontend route
}
