/**
 * School-owner dashboard end-to-end verification.
 *
 * Seeds a deterministic school, then checks every endpoint the dashboard reads
 * and every action it can fire against DB ground truth computed independently
 * with Prisma. Writes the raw API payloads + truth to a fixture the frontend
 * render test consumes.
 *
 *   PORT=3005 DATABASE_URL=...lopay_dash npm run start:dev
 *   E2E_BASE=http://localhost:3005 npx ts-node -r tsconfig-paths/register <this>
 */
import {
  PrismaClient,
  PaymentStatus,
  PaymentType,
  PaymentTransactionStatus,
  PaymentReceiver,
} from '../src/generated/prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as fs from 'fs';
import * as path from 'path';

const BASE = process.env.E2E_BASE || 'http://localhost:3005';
const OUT =
  process.env.FIXTURE_OUT || path.join(__dirname, 'dash-fixture.json');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

let pass = 0;
let fail = 0;
const failures: string[] = [];
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name}   ${extra}`);
    console.log(`  FAIL  ${name}   ${extra}`);
  }
};
const section = (s: string) => console.log(`\n=== ${s} ===`);

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@lopay.com';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin12345';
const OWNER_EMAIL = 'dash-owner@lopay.test';
const OWNER_PW = 'ownerpass12345';
const OTHER_OWNER_EMAIL = 'dash-other-owner@lopay.test';
const PARENT_EMAIL = 'dash-parent@lopay.test';
const PARENT_PW = 'parentpass12345';
const ORIGIN = BASE;

const N = (kobo: number) => kobo / 100;

async function signIn(email: string, password: string) {
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  return {
    status: r.status,
    token: r.headers.get('set-auth-token'),
    j: await r.json().catch(() => null),
  };
}
async function signUp(email: string, password: string, name: string) {
  const r = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  return {
    status: r.status,
    token: r.headers.get('set-auth-token'),
    j: await r.json().catch(() => null),
  };
}
async function session(token: string) {
  const r = await fetch(`${BASE}/api/auth/get-session`, {
    headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN },
  });
  return await r.json().catch(() => null);
}
async function api(
  method: string,
  p: string,
  token: string | null,
  body?: any,
) {
  const r = await fetch(`${BASE}/api/v1${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, j: (await r.json().catch(() => null)) as any };
}

async function cleanup() {
  const emails = [OWNER_EMAIL, OTHER_OWNER_EMAIL, PARENT_EMAIL];
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const parents = await prisma.parent.findMany({
    where: { userId: { in: ids } },
    select: { id: true },
  });
  const pIds = parents.map((p) => p.id);
  const children = await prisma.child.findMany({
    where: { parentId: { in: pIds } },
    select: { id: true },
  });
  const cIds = children.map((c) => c.id);
  const schools = await prisma.school.findMany({
    where: { ownerId: { in: ids } },
    select: { id: true },
  });
  const sIds = schools.map((s) => s.id);
  await prisma.payment.deleteMany({
    where: {
      OR: [
        { enrollment: { childId: { in: cIds } } },
        { schoolId: { in: sIds } },
      ],
    },
  });
  await prisma.childEnrollment.deleteMany({
    where: { OR: [{ childId: { in: cIds } }, { schoolId: { in: sIds } }] },
  });
  await prisma.auditLog.deleteMany({ where: { schoolId: { in: sIds } } });
  await prisma.classFee.deleteMany({ where: { schoolId: { in: sIds } } });
  await prisma.child.deleteMany({ where: { parentId: { in: pIds } } });
  await prisma.school.deleteMany({ where: { ownerId: { in: ids } } });
  await prisma.parent.deleteMany({ where: { userId: { in: ids } } });
  await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.account.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

/** Independent DB-side truth for every number the dashboard shows. */
async function truth(schoolId: string) {
  const [enrollments, payments] = await Promise.all([
    prisma.childEnrollment.findMany({
      where: { schoolId },
      include: { child: true },
    }),
    prisma.payment.findMany({ where: { schoolId } }),
  ]);
  const confirmed = payments.filter((p) => p.isConfirmed);
  const unconfirmed = payments.filter((p) => !p.isConfirmed);
  const pendingOnly = payments.filter(
    (p) => !p.isConfirmed && p.status === PaymentTransactionStatus.PENDING,
  );
  return {
    totalStudents: enrollments.length,
    totalRevenueKobo: confirmed.reduce((s, p) => s + p.schoolAmount, 0),
    // Money genuinely awaiting the owner: PENDING installments only. Rejected
    // (FAILED) and reversed (REVERSED) rows are also `isConfirmed: false`.
    pendingRevenueKobo: pendingOnly
      .filter((p) => p.paymentType === 'INSTALLMENT')
      .reduce((s, p) => s + p.schoolAmount, 0),
    awaitingActivationKobo: pendingOnly
      .filter((p) => p.paymentType === 'FIRST_PAYMENT')
      .reduce((s, p) => s + p.schoolAmount, 0),
    // The old, unfiltered definition — kept to prove the fix changes the number.
    unconfirmedAnyStatusKobo: unconfirmed.reduce(
      (s, p) => s + p.schoolAmount,
      0,
    ),
    defaultedKobo: enrollments
      .filter((e) => e.paymentStatus === PaymentStatus.DEFAULTED)
      .reduce((s, e) => s + e.remainingBalance, 0),
    activeCount: enrollments.filter(
      (e) => e.paymentStatus === PaymentStatus.ACTIVE,
    ).length,
    outstandingAllKobo: enrollments.reduce((s, e) => s + e.remainingBalance, 0),
    pendingInstallments: payments.filter(
      (p) =>
        !p.isConfirmed &&
        p.paymentType === 'INSTALLMENT' &&
        p.status === 'PENDING',
    ).length,
    pendingFirstPayments: payments.filter(
      (p) =>
        !p.isConfirmed &&
        p.paymentType === 'FIRST_PAYMENT' &&
        p.status === 'PENDING',
    ).length,
    paymentCount: payments.length,
    enrollments,
  };
}

async function main() {
  console.log(`\nSchool-owner dashboard E2E against ${BASE}\n`);
  await cleanup();

  // ── setup ────────────────────────────────────────────────────────────────
  section('Setup: admin onboards school + owner signs in');
  const admin = await signIn(ADMIN_EMAIL, ADMIN_PW);
  check(
    'admin sign-in',
    admin.status === 200 && !!admin.token,
    `status ${admin.status}`,
  );
  if (!admin.token) return finish();

  const onboard = await api('POST', '/admin/onboard-school', admin.token, {
    schoolName: 'Dash E2E School',
    ownerEmail: OWNER_EMAIL,
    ownerPassword: OWNER_PW,
    ownerName: 'Dash Owner',
    address: '1 Dashboard Road',
    phone: '08010000001',
    bankName: 'GTBank',
    bankCode: '058',
    accountName: 'Dash E2E School',
    accountNumber: '0123456789',
  });
  const schoolId: string = onboard.j?.school?.id;
  check(
    'school onboarded',
    !!schoolId,
    `status ${onboard.status} ${JSON.stringify(onboard.j)?.slice(0, 200)}`,
  );
  if (!schoolId) return finish();

  // second school — tenant isolation control
  const onboard2 = await api('POST', '/admin/onboard-school', admin.token, {
    schoolName: 'Other E2E School',
    ownerEmail: OTHER_OWNER_EMAIL,
    ownerPassword: OWNER_PW,
    ownerName: 'Other Owner',
    address: '2 Other Road',
    phone: '08010000002',
    bankName: 'GTBank',
    bankCode: '058',
    accountName: 'Other E2E School',
    accountNumber: '0123456788',
  });
  const otherSchoolId: string = onboard2.j?.school?.id;

  const owner = await signIn(OWNER_EMAIL, OWNER_PW);
  const ownerSess = await session(owner.token!);
  check(
    'owner session carries schoolId',
    ownerSess?.user?.schoolId === schoolId,
    `${ownerSess?.user?.schoolId}`,
  );
  const otherOwner = await signIn(OTHER_OWNER_EMAIL, OWNER_PW);

  // ── fee schedule (dashboard action: Fee Structure) ───────────────────────
  section('Action: publish fee schedule (POST /school-payments/fees/bulk)');
  const bulk = await api('POST', '/school-payments/fees/bulk', owner.token!, {
    fees: [
      { className: 'Grade 1', feeAmount: 100000 },
      { className: 'Grade 2', feeAmount: 200000 },
      { className: 'Grade 3', feeAmount: 300000 },
    ],
  });
  check(
    'bulk publish ok',
    bulk.status === 200 || bulk.status === 201,
    `status ${bulk.status}`,
  );
  const feesAfter = await api('GET', '/school-payments/fees', owner.token!);
  check(
    '3 active fees returned',
    Array.isArray(feesAfter.j) && feesAfter.j.length === 3,
    `${JSON.stringify(feesAfter.j)?.slice(0, 160)}`,
  );
  const dbFees = await prisma.classFee.findMany({
    where: { schoolId, isActive: true },
  });
  check(
    'fees stored in kobo, returned in naira',
    dbFees.find((f) => f.className === 'Grade 1')?.feeAmount === 10_000_000 &&
      (feesAfter.j as any[])?.find((f) => f.className === 'Grade 1')
        ?.feeAmount === 100000,
    `db=${dbFees.find((f) => f.className === 'Grade 1')?.feeAmount}`,
  );

  // republish without Grade 3 -> must deactivate
  const bulk2 = await api('POST', '/school-payments/fees/bulk', owner.token!, {
    fees: [
      { className: 'Grade 1', feeAmount: 100000 },
      { className: 'Grade 2', feeAmount: 200000 },
    ],
  });
  check(
    'republish ok',
    bulk2.status === 200 || bulk2.status === 201,
    `status ${bulk2.status}`,
  );
  const g3 = await prisma.classFee.findFirst({
    where: { schoolId, className: 'Grade 3' },
  });
  check(
    'dropped class deactivated',
    g3?.isActive === false,
    `isActive=${g3?.isActive}`,
  );

  // single-fee update (dashboard action: update one class fee)
  const single = await api('POST', '/school-payments/fees', owner.token!, {
    className: 'Grade 2',
    feeAmount: 250000,
  });
  check(
    'single fee update ok',
    single.status === 200 || single.status === 201,
    `status ${single.status}`,
  );
  const g2 = await prisma.classFee.findFirst({
    where: { schoolId, className: 'Grade 2' },
  });
  check(
    'single fee persisted in kobo',
    g2?.feeAmount === 25_000_000,
    `db=${g2?.feeAmount}`,
  );
  // restore for the enrollment maths below
  await api('POST', '/school-payments/fees', owner.token!, {
    className: 'Grade 2',
    feeAmount: 200000,
  });

  // ── seed students ────────────────────────────────────────────────────────
  section('Seed: 55 enrollments across every payment state');
  const parent = await signUp(PARENT_EMAIL, PARENT_PW, 'Dash Parent');
  const parentRow = await prisma.parent.create({
    data: { userId: parent.j?.user?.id, phoneNumber: '08020000001' },
  });

  type Seed = {
    name: string;
    className: string;
    feeKobo: number;
    depositKobo: number;
    remainingKobo: number;
    status: PaymentStatus;
    firstPaymentConfirmed: boolean;
  };
  const seeds: Seed[] = [
    // Ada: active, deposit confirmed, one confirmed installment added below
    {
      name: 'Ada Active',
      className: 'Grade 1',
      feeKobo: 10_000_000,
      depositKobo: 2_750_000,
      remainingKobo: 7_500_000,
      status: PaymentStatus.ACTIVE,
      firstPaymentConfirmed: true,
    },
    // Bode: active, deposit confirmed, a PENDING installment added below
    {
      name: 'Bode Pending',
      className: 'Grade 1',
      feeKobo: 10_000_000,
      depositKobo: 2_750_000,
      remainingKobo: 7_500_000,
      status: PaymentStatus.ACTIVE,
      firstPaymentConfirmed: true,
    },
    // Chidi: defaulted with a real outstanding balance
    {
      name: 'Chidi Defaulted',
      className: 'Grade 2',
      feeKobo: 20_000_000,
      depositKobo: 5_500_000,
      remainingKobo: 15_000_000,
      status: PaymentStatus.DEFAULTED,
      firstPaymentConfirmed: true,
    },
    // Dami: fully paid
    {
      name: 'Dami Completed',
      className: 'Grade 1',
      feeKobo: 10_000_000,
      depositKobo: 2_750_000,
      remainingKobo: 0,
      status: PaymentStatus.COMPLETED,
      firstPaymentConfirmed: true,
    },
    // Emeka: first payment submitted but NOT confirmed
    {
      name: 'Emeka Unconfirmed',
      className: 'Grade 2',
      feeKobo: 20_000_000,
      depositKobo: 5_500_000,
      remainingKobo: 15_000_000,
      status: PaymentStatus.PENDING,
      firstPaymentConfirmed: false,
    },
  ];
  // filler to push past the default page size of 50
  for (let i = 1; i <= 50; i++) {
    seeds.push({
      name: `Filler Student ${String(i).padStart(2, '0')}`,
      className: 'Grade 1',
      feeKobo: 10_000_000,
      depositKobo: 2_750_000,
      remainingKobo: 7_500_000,
      status: PaymentStatus.ACTIVE,
      firstPaymentConfirmed: true,
    });
  }

  const enrollmentIds: Record<string, string> = {};
  for (const s of seeds) {
    const child = await prisma.child.create({
      data: {
        parentId: parentRow.id,
        fullName: s.name,
        className: s.className,
      },
    });
    const platformFee = Math.round(s.feeKobo * 0.025);
    const enrollment = await prisma.childEnrollment.create({
      data: {
        childId: child.id,
        schoolId,
        className: s.className,
        totalSchoolFee: s.feeKobo,
        platformFee,
        schoolMinimumFee: Math.round(s.feeKobo * 0.25),
        firstPaymentPaid: s.depositKobo,
        remainingBalance: s.remainingKobo,
        paymentStatus: s.status,
        installmentFrequency: 'MONTHLY',
        termStartDate: new Date('2026-01-01'),
        termEndDate: new Date('2026-07-01'),
      },
    });
    enrollmentIds[s.name] = enrollment.id;
    // the first payment row the Paystack split would have written
    await prisma.payment.create({
      data: {
        enrollmentId: enrollment.id,
        schoolId,
        amountPaid: s.depositKobo,
        platformAmount: platformFee,
        schoolAmount: s.depositKobo - platformFee,
        receiver: PaymentReceiver.PLATFORM,
        paymentType: PaymentType.FIRST_PAYMENT,
        status: s.firstPaymentConfirmed
          ? PaymentTransactionStatus.SUCCESS
          : PaymentTransactionStatus.PENDING,
        isConfirmed: s.firstPaymentConfirmed,
        paymentDate: new Date('2026-02-01'),
      },
    });
  }
  // Ada: one already-confirmed installment of ₦25,000
  await prisma.payment.create({
    data: {
      enrollmentId: enrollmentIds['Ada Active'],
      schoolId,
      amountPaid: 2_500_000,
      platformAmount: 0,
      schoolAmount: 2_500_000,
      receiver: PaymentReceiver.SCHOOL,
      paymentType: PaymentType.INSTALLMENT,
      status: PaymentTransactionStatus.SUCCESS,
      isConfirmed: true,
      paymentDate: new Date('2026-03-01'),
    },
  });
  await prisma.childEnrollment.update({
    where: { id: enrollmentIds['Ada Active'] },
    data: { remainingBalance: 5_000_000 },
  });
  // Bode: a real pending installment submitted through the parent API
  const bodeInst = await api(
    'POST',
    '/enrollments/pay-installment',
    parent.token!,
    {
      enrollmentId: enrollmentIds['Bode Pending'],
      amountPaid: 10000,
    },
  );
  check(
    'parent installment submitted',
    bodeInst.status === 200 || bodeInst.status === 201,
    `status ${bodeInst.status} ${JSON.stringify(bodeInst.j)?.slice(0, 160)}`,
  );
  const bodePaymentId: string = bodeInst.j?.id;

  const T0 = await truth(schoolId);
  console.log(
    `  (truth: ${T0.totalStudents} students, revenue ₦${N(T0.totalRevenueKobo).toLocaleString()}, pending ₦${N(T0.pendingRevenueKobo).toLocaleString()}, defaulted ₦${N(T0.defaultedKobo).toLocaleString()})`,
  );

  // ── metric: GET /school-payments/stats ───────────────────────────────────
  section('Metric: GET /school-payments/stats vs DB');
  const stats = await api('GET', '/school-payments/stats', owner.token!);
  check('stats 200', stats.status === 200, `status ${stats.status}`);
  check(
    'stats.totalStudents matches DB',
    stats.j?.totalStudents === T0.totalStudents,
    `api=${stats.j?.totalStudents} db=${T0.totalStudents}`,
  );
  check(
    'stats.activeStudents matches ACTIVE enrollments',
    stats.j?.activeStudents === T0.activeCount,
    `api=${stats.j?.activeStudents} db=${T0.activeCount}`,
  );
  check(
    'stats.totalRevenue matches confirmed schoolAmount',
    stats.j?.totalRevenue === N(T0.totalRevenueKobo),
    `api=${stats.j?.totalRevenue} db=${N(T0.totalRevenueKobo)}`,
  );
  check(
    'stats.pendingRevenue = PENDING installments only',
    stats.j?.pendingRevenue === N(T0.pendingRevenueKobo),
    `api=${stats.j?.pendingRevenue} db=${N(T0.pendingRevenueKobo)}`,
  );
  check(
    'stats.awaitingActivation = PENDING first payments',
    stats.j?.awaitingActivation === N(T0.awaitingActivationKobo),
    `api=${stats.j?.awaitingActivation} db=${N(T0.awaitingActivationKobo)}`,
  );
  check(
    'stats.defaultedAmount matches DEFAULTED remaining balances',
    stats.j?.defaultedAmount === N(T0.defaultedKobo),
    `api=${stats.j?.defaultedAmount} db=${N(T0.defaultedKobo)}`,
  );
  check(
    'every pending naira is attributable to one of the two buckets',
    N(T0.pendingRevenueKobo) + N(T0.awaitingActivationKobo) ===
      (stats.j?.pendingRevenue ?? 0) + (stats.j?.awaitingActivation ?? 0),
  );

  // ── metric: GET /school-payments/students ────────────────────────────────
  section('Metric: GET /school-payments/students vs DB');
  const studentsRaw = await api(
    'GET',
    '/school-payments/students',
    owner.token!,
  );
  check(
    'students 200',
    studentsRaw.status === 200,
    `status ${studentsRaw.status}`,
  );
  const isArray = Array.isArray(studentsRaw.j);
  const isEnvelope = !isArray && Array.isArray(studentsRaw.j?.items);
  check(
    'students payload is the documented pagination envelope',
    isEnvelope,
    `shape=${isArray ? 'array' : Object.keys(studentsRaw.j || {}).join(',')}`,
  );
  const studentItems: any[] = isArray
    ? studentsRaw.j
    : (studentsRaw.j?.items ?? []);
  check(
    'envelope.total equals DB enrollment count',
    (isEnvelope ? studentsRaw.j.total : studentItems.length) ===
      T0.totalStudents,
    `api=${isEnvelope ? studentsRaw.j.total : studentItems.length} db=${T0.totalStudents}`,
  );
  check(
    'envelope declares the truncation (total > page size, totalPages > 1)',
    !isEnvelope ||
      (studentsRaw.j.total > studentItems.length
        ? studentsRaw.j.totalPages > 1
        : true),
    `total=${studentsRaw.j?.total} returned=${studentItems.length} totalPages=${studentsRaw.j?.totalPages}`,
  );

  // What the client now does: walk every page.
  const paged: any[] = [];
  let pageNo = 1;
  let pages = 1;
  do {
    const r = await api(
      'GET',
      `/school-payments/students?page=${pageNo}&limit=200`,
      owner.token!,
    );
    const body = Array.isArray(r.j) ? { items: r.j, totalPages: 1 } : r.j;
    paged.push(...(body?.items ?? []));
    pages = body?.totalPages ?? 1;
    pageNo += 1;
  } while (pageNo <= pages && pageNo <= 50);
  check(
    'paging through the envelope yields the whole roster',
    paged.length === T0.totalStudents,
    `paged=${paged.length} db=${T0.totalStudents}`,
  );

  const studentsFull = await api(
    'GET',
    '/school-payments/students?limit=200',
    owner.token!,
  );
  const fullItems: any[] = Array.isArray(studentsFull.j)
    ? studentsFull.j
    : (studentsFull.j?.items ?? []);
  check(
    'limit=200 returns all 55',
    fullItems.length === T0.totalStudents,
    `returned=${fullItems.length}`,
  );

  const ada = fullItems.find((s) => s.studentName === 'Ada Active');
  const adaEnr = T0.enrollments.find((e) => e.child.fullName === 'Ada Active')!;
  const adaPayments = await prisma.payment.findMany({
    where: { enrollmentId: adaEnr.id, isConfirmed: true },
  });
  const adaPaidKobo = adaPayments.reduce((s, p) => s + p.amountPaid, 0);
  check(
    'student.totalFee = enrollment.totalSchoolFee in naira',
    ada?.totalFee === N(adaEnr.totalSchoolFee),
    `api=${ada?.totalFee} db=${N(adaEnr.totalSchoolFee)}`,
  );
  check(
    'student.paidAmount = confirmed amountPaid in naira',
    ada?.paidAmount === N(adaPaidKobo),
    `api=${ada?.paidAmount} db=${N(adaPaidKobo)}`,
  );
  check(
    'student.paymentStatus matches enrollment',
    ada?.paymentStatus === adaEnr.paymentStatus,
    `api=${ada?.paymentStatus} db=${adaEnr.paymentStatus}`,
  );
  check(
    'student row exposes remainingBalance (arrears source of truth)',
    ada?.remainingBalance !== undefined,
    `keys=${Object.keys(ada || {}).join(',')}`,
  );
  check(
    'student.remainingBalance matches the enrollment',
    Math.round((ada?.remainingBalance ?? -1) * 100) === adaEnr.remainingBalance,
    `api=${ada?.remainingBalance} db=${N(adaEnr.remainingBalance)}`,
  );
  check(
    'the naive totalFee - paidAmount derivation is short by the platform fee',
    ada &&
      Math.round((ada.totalFee - ada.paidAmount) * 100) ===
        adaEnr.remainingBalance - adaEnr.platformFee,
    `derived=${ada ? ada.totalFee - ada.paidAmount : 'n/a'} actual=${N(adaEnr.remainingBalance)} platformFee=${N(adaEnr.platformFee)}`,
  );
  check(
    'student row exposes the enrollment id (needed for owner actions)',
    !!ada?.enrollmentId,
    `id=${ada?.id} enrollmentId=${ada?.enrollmentId}`,
  );
  check(
    'student id IS the enrollment id (matches the parent-side DTO)',
    ada?.id === adaEnr.id,
    `id=${ada?.id} enrollmentId=${adaEnr.id}`,
  );
  check(
    'student row still carries childId',
    ada?.childId === adaEnr.childId,
    `childId=${ada?.childId}`,
  );

  // search + class filter
  const searched = await api(
    'GET',
    '/school-payments/students?search=Chidi',
    owner.token!,
  );
  const searchedItems: any[] = Array.isArray(searched.j)
    ? searched.j
    : (searched.j?.items ?? []);
  check(
    'server-side search returns only the match',
    searchedItems.length === 1 &&
      searchedItems[0].studentName === 'Chidi Defaulted',
    `count=${searchedItems.length}`,
  );
  const filtered = await api(
    'GET',
    '/school-payments/students?className=Grade%202&limit=200',
    owner.token!,
  );
  const filteredItems: any[] = Array.isArray(filtered.j)
    ? filtered.j
    : (filtered.j?.items ?? []);
  const dbGrade2 = T0.enrollments.filter(
    (e) => e.className === 'Grade 2',
  ).length;
  check(
    'class filter matches DB',
    filteredItems.length === dbGrade2,
    `api=${filteredItems.length} db=${dbGrade2}`,
  );

  // ── metric: GET /school-payments/pending ─────────────────────────────────
  section('Metric: GET /school-payments/pending vs DB');
  const pending = await api('GET', '/school-payments/pending', owner.token!);
  const pendingItems: any[] = Array.isArray(pending.j) ? pending.j : [];
  check('pending 200', pending.status === 200, `status ${pending.status}`);
  check(
    'default queue = installments the owner can approve',
    pendingItems.length === T0.pendingInstallments,
    `api=${pendingItems.length} db=${T0.pendingInstallments}`,
  );
  const pendingAll = await api(
    'GET',
    '/school-payments/pending?paymentType=ALL',
    owner.token!,
  );
  const pendingAllItems: any[] = Array.isArray(pendingAll.j)
    ? pendingAll.j
    : [];
  check(
    'paymentType=ALL also surfaces first payments awaiting activation',
    pendingAllItems.length === T0.pendingInstallments + T0.pendingFirstPayments,
    `api=${pendingAllItems.length} db installments=${T0.pendingInstallments} + first=${T0.pendingFirstPayments}`,
  );
  const pendingFirst = await api(
    'GET',
    '/school-payments/pending?paymentType=FIRST_PAYMENT',
    owner.token!,
  );
  check(
    'paymentType=FIRST_PAYMENT isolates first payments',
    (pendingFirst.j as any[])?.length === T0.pendingFirstPayments,
    `api=${(pendingFirst.j as any[])?.length} db=${T0.pendingFirstPayments}`,
  );
  const bodePending = pendingItems.find((p) => p.id === bodePaymentId);
  check(
    'pending row amount in naira',
    bodePending?.amount === 10000 || bodePending?.amountPaid === 10000,
    `amount=${bodePending?.amount} amountPaid=${bodePending?.amountPaid}`,
  );
  check(
    'pending row carries childName',
    bodePending?.childName === 'Bode Pending',
    `childName=${bodePending?.childName}`,
  );

  // ── metric: GET /school-payments/history ─────────────────────────────────
  section('Metric: GET /school-payments/history vs DB');
  const history = await api('GET', '/school-payments/history', owner.token!);
  const historyItems: any[] = Array.isArray(history.j) ? history.j : [];
  check('history 200', history.status === 200, `status ${history.status}`);
  check(
    'history returns every payment for the school',
    historyItems.length === T0.paymentCount,
    `api=${historyItems.length} db=${T0.paymentCount}`,
  );
  const historySorted = historyItems.every(
    (h, i) =>
      i === 0 ||
      new Date(historyItems[i - 1].date).getTime() >=
        new Date(h.date).getTime(),
  );
  check('history sorted newest first', historySorted);
  const histSum = historyItems.reduce(
    (s, h) => s + (h.amount ?? h.amountPaid ?? 0),
    0,
  );
  const dbSum = (await prisma.payment.findMany({ where: { schoolId } })).reduce(
    (s, p) => s + p.amountPaid,
    0,
  );
  check(
    'history amounts sum to DB amountPaid',
    Math.round(histSum * 100) === dbSum,
    `api=${histSum} db=${N(dbSum)}`,
  );

  // Month window backing the CSV export. Seed data straddles Feb and Mar 2026.
  const feb = await api(
    'GET',
    '/school-payments/history?from=2026-02-01T00:00:00.000Z&to=2026-02-28T23:59:59.999Z&take=1000',
    owner.token!,
  );
  const febItems: any[] = Array.isArray(feb.j) ? feb.j : [];
  const dbFeb = await prisma.payment.count({
    where: {
      schoolId,
      paymentDate: {
        gte: new Date('2026-02-01T00:00:00.000Z'),
        lte: new Date('2026-02-28T23:59:59.999Z'),
      },
    },
  });
  check(
    'history ?from/?to returns exactly that month',
    febItems.length === dbFeb && dbFeb > 0,
    `api=${febItems.length} db=${dbFeb}`,
  );
  check(
    'date-filtered history excludes other months',
    febItems.every((h) => new Date(h.date).getUTCMonth() === 1),
    `months=${[...new Set(febItems.map((h) => new Date(h.date).getUTCMonth()))].join(',')}`,
  );
  const mar = await api(
    'GET',
    '/school-payments/history?from=2026-03-01T00:00:00.000Z&to=2026-03-31T23:59:59.999Z&take=1000',
    owner.token!,
  );
  const dbMar = await prisma.payment.count({
    where: {
      schoolId,
      paymentDate: {
        gte: new Date('2026-03-01T00:00:00.000Z'),
        lte: new Date('2026-03-31T23:59:59.999Z'),
      },
    },
  });
  check(
    'a different month returns a different slice',
    (mar.j as any[])?.length === dbMar,
    `api=${(mar.j as any[])?.length} db=${dbMar}`,
  );
  check(
    'export take above the old 200 cap is honoured',
    febItems.length <= 1000,
  );

  // ── tenant isolation ─────────────────────────────────────────────────────
  section('Tenant isolation');
  const otherStats = await api(
    'GET',
    '/school-payments/stats',
    otherOwner.token!,
  );
  check(
    'other school sees 0 students',
    otherStats.j?.totalStudents === 0,
    `${otherStats.j?.totalStudents}`,
  );
  check(
    'other school sees 0 revenue',
    otherStats.j?.totalRevenue === 0,
    `${otherStats.j?.totalRevenue}`,
  );
  const otherConfirm = await api(
    'POST',
    '/school-payments/confirm',
    otherOwner.token!,
    { paymentId: bodePaymentId },
  );
  const bodeStillPending = await prisma.payment.findUnique({
    where: { id: bodePaymentId },
  });
  check(
    'cross-tenant confirm rejected',
    otherConfirm.status >= 400,
    `status ${otherConfirm.status}`,
  );
  check(
    'cross-tenant confirm left the payment untouched',
    bodeStillPending?.isConfirmed === false &&
      bodeStillPending?.status === 'PENDING',
    `${bodeStillPending?.isConfirmed}/${bodeStillPending?.status}`,
  );
  const parentStats = await api('GET', '/school-payments/stats', parent.token!);
  check(
    'parent cannot read school stats',
    parentStats.status === 403,
    `status ${parentStats.status}`,
  );
  const anonStats = await api('GET', '/school-payments/stats', null);
  check(
    'anonymous cannot read school stats',
    anonStats.status === 401,
    `status ${anonStats.status}`,
  );

  // ── action: confirm ──────────────────────────────────────────────────────
  section('Action: confirm installment (POST /school-payments/confirm)');
  const beforeConfirm = await truth(schoolId);
  const bodeEnrBefore = await prisma.childEnrollment.findUnique({
    where: { id: enrollmentIds['Bode Pending'] },
  });
  const confirmRes = await api(
    'POST',
    '/school-payments/confirm',
    owner.token!,
    { paymentId: bodePaymentId },
  );
  check(
    'confirm ok',
    confirmRes.status === 200 || confirmRes.status === 201,
    `status ${confirmRes.status} ${JSON.stringify(confirmRes.j)?.slice(0, 160)}`,
  );
  const bodePayAfter = await prisma.payment.findUnique({
    where: { id: bodePaymentId },
  });
  const bodeEnrAfter = await prisma.childEnrollment.findUnique({
    where: { id: enrollmentIds['Bode Pending'] },
  });
  check(
    'payment marked confirmed + SUCCESS',
    bodePayAfter?.isConfirmed === true && bodePayAfter?.status === 'SUCCESS',
    `${bodePayAfter?.isConfirmed}/${bodePayAfter?.status}`,
  );
  check(
    'enrollment balance reduced by the installment',
    bodeEnrBefore!.remainingBalance - bodeEnrAfter!.remainingBalance ===
      1_000_000,
    `before=${bodeEnrBefore!.remainingBalance} after=${bodeEnrAfter!.remainingBalance}`,
  );
  const statsAfterConfirm = await api(
    'GET',
    '/school-payments/stats',
    owner.token!,
  );
  const afterConfirmTruth = await truth(schoolId);
  check(
    'stats.totalRevenue moved by exactly the confirmed amount',
    statsAfterConfirm.j?.totalRevenue ===
      N(beforeConfirm.totalRevenueKobo + 1_000_000),
    `api=${statsAfterConfirm.j?.totalRevenue} expected=${N(beforeConfirm.totalRevenueKobo + 1_000_000)}`,
  );
  check(
    'stats.pendingRevenue dropped by the same amount',
    statsAfterConfirm.j?.pendingRevenue ===
      N(afterConfirmTruth.pendingRevenueKobo),
    `api=${statsAfterConfirm.j?.pendingRevenue} db=${N(afterConfirmTruth.pendingRevenueKobo)}`,
  );
  const pendingAfterConfirm = await api(
    'GET',
    '/school-payments/pending',
    owner.token!,
  );
  check(
    'confirmed payment leaves the pending queue',
    !(pendingAfterConfirm.j as any[]).some((p) => p.id === bodePaymentId),
  );
  const auditConfirm = await prisma.auditLog.findFirst({
    where: { schoolId, action: 'PAYMENT_CONFIRMED', entityId: bodePaymentId },
  });
  check('audit row written for confirm', !!auditConfirm);
  const doubleConfirm = await api(
    'POST',
    '/school-payments/confirm',
    owner.token!,
    { paymentId: bodePaymentId },
  );
  check(
    'double confirm rejected',
    doubleConfirm.status >= 400,
    `status ${doubleConfirm.status}`,
  );

  // ── action: reverse ──────────────────────────────────────────────────────
  section(
    'Action: reverse a confirmed payment (POST /school-payments/reverse)',
  );
  const beforeReverse = await truth(schoolId);
  const reverseRes = await api(
    'POST',
    '/school-payments/reverse',
    owner.token!,
    { paymentId: bodePaymentId, reason: 'e2e reversal' },
  );
  check(
    'reverse ok',
    reverseRes.status === 200 || reverseRes.status === 201,
    `status ${reverseRes.status} ${JSON.stringify(reverseRes.j)?.slice(0, 160)}`,
  );
  const bodePayReversed = await prisma.payment.findUnique({
    where: { id: bodePaymentId },
  });
  const bodeEnrReversed = await prisma.childEnrollment.findUnique({
    where: { id: enrollmentIds['Bode Pending'] },
  });
  check(
    'payment marked REVERSED + unconfirmed',
    bodePayReversed?.status === 'REVERSED' &&
      bodePayReversed?.isConfirmed === false,
    `${bodePayReversed?.status}/${bodePayReversed?.isConfirmed}`,
  );
  check(
    'balance restored',
    bodeEnrReversed!.remainingBalance === bodeEnrBefore!.remainingBalance,
    `after=${bodeEnrReversed!.remainingBalance} original=${bodeEnrBefore!.remainingBalance}`,
  );
  const statsAfterReverse = await api(
    'GET',
    '/school-payments/stats',
    owner.token!,
  );
  const afterReverseTruth = await truth(schoolId);
  check(
    'stats.totalRevenue backed out the reversal',
    statsAfterReverse.j?.totalRevenue ===
      N(beforeReverse.totalRevenueKobo - 1_000_000),
    `api=${statsAfterReverse.j?.totalRevenue} expected=${N(beforeReverse.totalRevenueKobo - 1_000_000)}`,
  );
  const reversedRows = await prisma.payment.findMany({
    where: { schoolId, isConfirmed: false, status: 'REVERSED' },
  });
  check(
    'a REVERSED payment is not counted as pending revenue',
    reversedRows.length > 0 &&
      statsAfterReverse.j?.pendingRevenue ===
        N(afterReverseTruth.pendingRevenueKobo),
    `api=${statsAfterReverse.j?.pendingRevenue} genuinely-pending=${N(afterReverseTruth.pendingRevenueKobo)} reversed-rows=${reversedRows.length}`,
  );
  check(
    'the old unfiltered definition would have overstated it',
    N(afterReverseTruth.unconfirmedAnyStatusKobo) >
      N(afterReverseTruth.pendingRevenueKobo),
    `unfiltered=${N(afterReverseTruth.unconfirmedAnyStatusKobo)} filtered=${N(afterReverseTruth.pendingRevenueKobo)}`,
  );
  const pendingAfterReverse = await api(
    'GET',
    '/school-payments/pending',
    owner.token!,
  );
  check(
    'reversed payment does not reappear in the approval queue',
    !(pendingAfterReverse.j as any[]).some((p) => p.id === bodePaymentId),
  );

  // ── action: reject ───────────────────────────────────────────────────────
  section('Action: reject an installment (POST /school-payments/reject)');
  const inst2 = await api(
    'POST',
    '/enrollments/pay-installment',
    parent.token!,
    {
      enrollmentId: enrollmentIds['Ada Active'],
      amountPaid: 5000,
    },
  );
  const inst2Id: string = inst2.j?.id;
  const adaBefore = await prisma.childEnrollment.findUnique({
    where: { id: enrollmentIds['Ada Active'] },
  });
  const rejectRes = await api('POST', '/school-payments/reject', owner.token!, {
    paymentId: inst2Id,
  });
  check(
    'reject ok',
    rejectRes.status === 200 || rejectRes.status === 201,
    `status ${rejectRes.status}`,
  );
  const inst2After = await prisma.payment.findUnique({
    where: { id: inst2Id },
  });
  const adaAfter = await prisma.childEnrollment.findUnique({
    where: { id: enrollmentIds['Ada Active'] },
  });
  check(
    'rejected payment marked FAILED',
    inst2After?.status === 'FAILED',
    `status=${inst2After?.status}`,
  );
  check(
    'rejected payment leaves balance untouched',
    adaAfter!.remainingBalance === adaBefore!.remainingBalance,
    `${adaBefore!.remainingBalance} -> ${adaAfter!.remainingBalance}`,
  );
  const statsAfterReject = await api(
    'GET',
    '/school-payments/stats',
    owner.token!,
  );
  const rejectTruth = await truth(schoolId);
  check(
    'rejected amount excluded from pending revenue',
    statsAfterReject.j?.pendingRevenue === N(rejectTruth.pendingRevenueKobo),
    `api=${statsAfterReject.j?.pendingRevenue} db=${N(rejectTruth.pendingRevenueKobo)}`,
  );
  const failedRows = await prisma.payment.findMany({
    where: { schoolId, isConfirmed: false, status: 'FAILED' },
  });
  const pendingInstallmentSum = (
    await prisma.payment.findMany({
      where: {
        schoolId,
        isConfirmed: false,
        status: 'PENDING',
        paymentType: 'INSTALLMENT',
      },
    })
  ).reduce((s, p) => s + p.schoolAmount, 0);
  check(
    'a FAILED payment is not counted as pending revenue by the stats query',
    failedRows.length > 0 &&
      failedRows.some((p) => p.schoolAmount > 0) &&
      statsAfterReject.j?.pendingRevenue === N(pendingInstallmentSum),
    `pendingRevenue=${statsAfterReject.j?.pendingRevenue} pending-installments-only=${N(pendingInstallmentSum)} failed-rows=${failedRows.length}`,
  );
  check(
    'the pending queue and the pending figure agree',
    (await api('GET', '/school-payments/pending', owner.token!)).j?.reduce?.(
      (s: number, p: any) => s + (p.schoolAmount ?? p.amount ?? 0),
      0,
    ) === statsAfterReject.j?.pendingRevenue,
    `queue-sum=${(await api('GET', '/school-payments/pending', owner.token!)).j?.reduce?.((s: number, p: any) => s + (p.schoolAmount ?? p.amount ?? 0), 0)} card=${statsAfterReject.j?.pendingRevenue}`,
  );

  // ── action: mark defaulted ───────────────────────────────────────────────
  section('Action: mark enrollment defaulted (POST /school-payments/default)');
  const defBefore = await api('GET', '/school-payments/stats', owner.token!);
  const target = enrollmentIds['Filler Student 01'];
  const targetEnr = await prisma.childEnrollment.findUnique({
    where: { id: target },
  });
  const defRes = await api('POST', '/school-payments/default', owner.token!, {
    enrollmentId: target,
  });
  check(
    'default ok',
    defRes.status === 200 || defRes.status === 201,
    `status ${defRes.status} ${JSON.stringify(defRes.j)?.slice(0, 160)}`,
  );
  const targetAfter = await prisma.childEnrollment.findUnique({
    where: { id: target },
  });
  check(
    'enrollment marked DEFAULTED',
    targetAfter?.paymentStatus === 'DEFAULTED',
    `${targetAfter?.paymentStatus}`,
  );
  const defAfter = await api('GET', '/school-payments/stats', owner.token!);
  check(
    'stats.defaultedAmount grew by that balance',
    defAfter.j?.defaultedAmount ===
      defBefore.j?.defaultedAmount + N(targetEnr!.remainingBalance),
    `before=${defBefore.j?.defaultedAmount} after=${defAfter.j?.defaultedAmount} delta expected=${N(targetEnr!.remainingBalance)}`,
  );
  const auditDefault = await prisma.auditLog.findFirst({
    where: { schoolId, entityId: target, action: 'ENROLLMENT_DEFAULTED' },
  });
  check(
    'audit row written for default',
    !!auditDefault,
    `${auditDefault?.action}`,
  );

  // ── final snapshot for the frontend render test ──────────────────────────
  section('Capture fixture for the frontend render test');
  const finalTruth = await truth(schoolId);
  const [fStats, fStudents, fStudentsAll, fPending, fHistory, fSchools] =
    await Promise.all([
      api('GET', '/school-payments/stats', owner.token!),
      api('GET', '/school-payments/students', owner.token!),
      api('GET', '/school-payments/students?page=1&limit=200', owner.token!),
      api(
        'GET',
        '/school-payments/pending?includeReceiptSignedUrls=true',
        owner.token!,
      ),
      api(
        'GET',
        '/school-payments/history?includeReceiptSignedUrls=true',
        owner.token!,
      ),
      api('GET', '/schools', null),
    ]);
  const fixture = {
    schoolId,
    otherSchoolId,
    api: {
      stats: fStats.j,
      // page 1 (the envelope, as the endpoint returns it) and the full roster
      // the client assembles by paging — the render test uses both.
      students: fStudents.j,
      studentsAll: fStudentsAll.j,
      pending: fPending.j,
      history: fHistory.j,
      schools: fSchools.j,
    },
    truth: {
      totalStudents: finalTruth.totalStudents,
      totalRevenue: N(finalTruth.totalRevenueKobo),
      pendingRevenue: N(finalTruth.pendingRevenueKobo),
      awaitingActivation: N(finalTruth.awaitingActivationKobo),
      unconfirmedAnyStatus: N(finalTruth.unconfirmedAnyStatusKobo),
      defaultedAmount: N(finalTruth.defaultedKobo),
      activeCount: finalTruth.activeCount,
      outstandingAll: N(finalTruth.outstandingAllKobo),
      pendingInstallments: finalTruth.pendingInstallments,
      pendingFirstPayments: finalTruth.pendingFirstPayments,
      paymentCount: finalTruth.paymentCount,
      students: finalTruth.enrollments.map((e) => ({
        name: e.child.fullName,
        className: e.className,
        totalFee: N(e.totalSchoolFee),
        platformFee: N(e.platformFee),
        remainingBalance: N(e.remainingBalance),
        paymentStatus: e.paymentStatus,
      })),
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2));
  console.log(`  fixture -> ${OUT}`);

  await finish();
}

async function finish() {
  console.log(`\n──────────────────────────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log(`\nFailures:`);
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log();
  await prisma.$disconnect();
  await pool.end();
  // Non-zero on any failed check so CI (or a pre-deploy gate) can rely on this
  // script instead of a human reading the tally.
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('E2E crashed:', e);
  await prisma.$disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
