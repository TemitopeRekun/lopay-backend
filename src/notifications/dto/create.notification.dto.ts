export class CreateNotificationDto {
  userId: string;   // Who receives the notification
  title: string;
  message: string;
  link?: string;    // Optional link to frontend route
}
