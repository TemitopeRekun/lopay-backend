import { Module } from '@nestjs/common';
import { SchoolOnboardingService } from './school-onboarding.service';

/**
 * Provisioning saga shared by AdminModule (onboardSchool) and SchoolsModule
 * (createSchool). PrismaService and Better Auth's AuthService are both provided
 * globally, so no imports are needed here.
 */
@Module({
  providers: [SchoolOnboardingService],
  exports: [SchoolOnboardingService],
})
export class SchoolOnboardingModule {}
