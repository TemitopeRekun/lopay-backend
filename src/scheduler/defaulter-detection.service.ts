import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentStatus, AuditAction } from '../generated/prisma/client';
import { EventsGateway } from '../events/events.gateway';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class DefaulterDetectionService {
  private readonly logger = new Logger(DefaulterDetectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly audit: AuditService,
  ) {}

  /**
   * Runs at midnight every day.
   * Finds active enrollments whose term has ended and still carry a balance,
   * then marks them as DEFAULTED and notifies the parent.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async detectDefaulters() {
    const now = new Date();
    this.logger.log(`Running defaulter detection at ${now.toISOString()}`);

    const overdue = await this.prisma.childEnrollment.findMany({
      where: {
        paymentStatus: PaymentStatus.ACTIVE,
        termEndDate: { lt: now },
        remainingBalance: { gt: 0 },
      },
      include: {
        child: { include: { parent: true } },
        school: true,
      },
    });

    if (overdue.length === 0) {
      this.logger.log('No new defaulters found');
      return;
    }

    this.logger.warn(`Marking ${overdue.length} enrollment(s) as DEFAULTED`);

    await Promise.all(
      overdue.map(async (enrollment) => {
        await this.prisma.$transaction(async (tx) => {
          await tx.childEnrollment.update({
            where: { id: enrollment.id },
            data: { paymentStatus: PaymentStatus.DEFAULTED },
          });

          // Audit (atomic). actor is null — this is a system action.
          await this.audit.record(
            {
              action: AuditAction.ENROLLMENT_DEFAULTED,
              entityType: 'ChildEnrollment',
              entityId: enrollment.id,
              actor: null,
              schoolId: enrollment.schoolId,
              before: { paymentStatus: PaymentStatus.ACTIVE },
              after: { paymentStatus: PaymentStatus.DEFAULTED },
              metadata: {
                remainingBalance: enrollment.remainingBalance,
                source: 'scheduled-defaulter-detection',
              },
            },
            tx,
          );

          await tx.notification.create({
            data: {
              userId: enrollment.child.parent.userId,
              title: 'Payment Defaulted',
              message: `Your enrollment for ${enrollment.child.fullName} at ${enrollment.school.name} has been marked as defaulted due to outstanding balance of ₦${enrollment.remainingBalance.toLocaleString()}.`,
              link: '/history',
            },
          });
        });

        this.events.emitEnrollmentsChanged({
          parentUserId: enrollment.child.parent.userId,
          schoolId: enrollment.schoolId,
          notifyAdmins: true,
        });

        this.logger.warn(
          `Defaulted enrollment ${enrollment.id} for ${enrollment.child.fullName} (balance: ₦${enrollment.remainingBalance})`,
        );
      }),
    );
  }
}
