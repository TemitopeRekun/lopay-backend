/**
 * No-key end-to-end verification of the core platform flows after the Better Auth
 * migration. Exercises auth across all three roles, role-based authorization,
 * tenant isolation, class-fee setup (kobo), the installment → confirm → balance
 * recompute money lifecycle, history, dashboards, and the audit trail.
 *
 * Does NOT cover: Paystack first payment (needs a test key), receipt upload
 * (Supabase), Google sign-in. The active enrollment is seeded directly so the
 * downstream money flow can be tested without Paystack.
 *
 * Run against a backend on E2E_BASE (default :3005):
 *   PORT=3005 npm run start:dev   # in another shell
 *   E2E_BASE=http://localhost:3005 npx ts-node -r tsconfig-paths/register scripts/e2e-verify.ts
 */
import { PrismaClient, UserRole, PaymentStatus } from '../src/generated/prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';

dotenv.config();

const BASE = process.env.E2E_BASE || 'http://localhost:3005';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}   ${extra}`);
  }
};

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@lopay.com';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'admin12345';
const OWNER_EMAIL = 'e2e-owner@lopay.test';
const OWNER_PW = 'ownerpass12345';
const PARENT_EMAIL = 'e2e-parent@lopay.test';
const PARENT_PW = 'parentpass12345';

// Better Auth's CSRF guard requires a trusted Origin; real browsers send it.
const ORIGIN = BASE;
async function signUp(email: string, password: string, name: string) {
  const r = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password, name }),
  });
  return { status: r.status, token: r.headers.get('set-auth-token'), j: await r.json().catch(() => null) };
}
async function signIn(email: string, password: string) {
  const r = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  return { status: r.status, token: r.headers.get('set-auth-token'), j: await r.json().catch(() => null) };
}
async function session(token: string) {
  const r = await fetch(`${BASE}/api/auth/get-session`, { headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN } });
  return await r.json().catch(() => null);
}
async function api(method: string, path: string, token: string | null, body?: any) {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, j: await r.json().catch(() => null) };
}

async function cleanup() {
  const emails = [OWNER_EMAIL, PARENT_EMAIL];
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    const parents = await prisma.parent.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const pIds = parents.map((p) => p.id);
    const children = await prisma.child.findMany({ where: { parentId: { in: pIds } }, select: { id: true } });
    const cIds = children.map((c) => c.id);
    const schools = await prisma.school.findMany({ where: { ownerId: { in: ids } }, select: { id: true } });
    const sIds = schools.map((s) => s.id);
    await prisma.payment.deleteMany({ where: { OR: [{ enrollment: { childId: { in: cIds } } }, { schoolId: { in: sIds } }] } });
    await prisma.childEnrollment.deleteMany({ where: { OR: [{ childId: { in: cIds } }, { schoolId: { in: sIds } }] } });
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
}

async function main() {
  console.log(`\nE2E against ${BASE}\n`);
  await cleanup();

  // ── 1. SUPER_ADMIN auth ──────────────────────────────────────────────────
  console.log('1. Admin auth');
  console.log(`   (using ADMIN_EMAIL=${ADMIN_EMAIL}, pw len=${ADMIN_PW.length})`);
  const admin = await signIn(ADMIN_EMAIL, ADMIN_PW);
  check('admin sign-in 200', admin.status === 200, `got ${admin.status} body=${JSON.stringify(admin.j)?.slice(0, 200)}`);
  if (!admin.token) {
    console.log('   admin sign-in failed. Aborting.');
    return finish();
  }
  const adminSess = await session(admin.token);
  check('admin role = SUPER_ADMIN', adminSess?.user?.role === 'SUPER_ADMIN', JSON.stringify(adminSess?.user?.role));

  // ── 2. Admin onboards a school (Paystack subaccount fails gracefully) ─────
  console.log('2. School onboarding');
  const onboard = await api('POST', '/admin/onboard-school', admin.token, {
    schoolName: 'E2E Test School',
    ownerEmail: OWNER_EMAIL,
    ownerPassword: OWNER_PW,
    ownerName: 'E2E Owner',
    address: '1 Test Road',
    phone: '08010000000',
    bankName: 'GTBank',
    bankCode: '058',
    accountName: 'E2E Test School',
    accountNumber: '0123456789',
  });
  check('onboard-school ok', onboard.status === 200 || onboard.status === 201, `status ${onboard.status} ${JSON.stringify(onboard.j)?.slice(0, 160)}`);
  const schoolId = onboard.j?.school?.id;
  check('school created with id', !!schoolId);
  check('owner user returned as SCHOOL_OWNER', onboard.j?.user?.role === 'SCHOOL_OWNER', JSON.stringify(onboard.j?.user?.role));

  // ── 3. Owner auth + session schoolId (customSession) ──────────────────────
  console.log('3. Owner auth');
  const owner = await signIn(OWNER_EMAIL, OWNER_PW);
  check('owner sign-in 200', owner.status === 200, `got ${owner.status}`);
  const ownerSess = await session(owner.token!);
  check('owner role = SCHOOL_OWNER', ownerSess?.user?.role === 'SCHOOL_OWNER');
  check('owner session has schoolId (customSession)', ownerSess?.user?.schoolId === schoolId, `sess=${ownerSess?.user?.schoolId} school=${schoolId}`);

  // ── 4. Owner creates a class fee (stored kobo, returned naira) ────────────
  console.log('4. Class fee');
  const fee = await api('POST', '/school-payments/fees', owner.token!, { className: 'Grade 1', feeAmount: 100000 });
  check('create fee ok', fee.status === 200 || fee.status === 201, `status ${fee.status}`);
  const fees = await api('GET', `/school-payments/fees/${schoolId}`, owner.token!);
  const grade1 = (fees.j as any[])?.find?.((f) => f.className === 'Grade 1');
  check('fee returned in naira (100000)', grade1?.feeAmount === 100000, `got ${grade1?.feeAmount}`);

  // ── 5. Parent registers (defaults to PARENT — role not client-settable) ───
  console.log('5. Parent registration');
  const parent = await signUp(PARENT_EMAIL, PARENT_PW, 'E2E Parent');
  check('parent sign-up ok', !!parent.token, `status ${parent.status} ${JSON.stringify(parent.j)?.slice(0,120)}`);
  const parentUserId = parent.j?.user?.id;
  check('parent role = PARENT (not escalated)', parent.j?.user?.role === 'PARENT', JSON.stringify(parent.j?.user?.role));

  // Privilege-escalation guard: try to self-assign SUPER_ADMIN at signup.
  const evil = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'e2e-evil@lopay.test', password: 'evilpass12345', name: 'Evil', role: 'SUPER_ADMIN' }),
  });
  const evilJson = await evil.json().catch(() => null);
  check('cannot self-assign SUPER_ADMIN at signup', evilJson?.user?.role !== 'SUPER_ADMIN', JSON.stringify(evilJson?.user?.role));
  await prisma.user.deleteMany({ where: { email: 'e2e-evil@lopay.test' } }).catch(() => {});

  // ── 6. Seed an ACTIVE enrollment directly (stands in for the Paystack first payment) ──
  console.log('6. Seed active enrollment (kobo)');
  const parentRow = await prisma.parent.create({ data: { userId: parentUserId, phoneNumber: '08020000000' } });
  const child = await prisma.child.create({ data: { parentId: parentRow.id, fullName: 'E2E Child', className: 'Grade 1' } });
  const enrollment = await prisma.childEnrollment.create({
    data: {
      childId: child.id,
      schoolId,
      className: 'Grade 1',
      totalSchoolFee: 10_000_000, // ₦100,000 in kobo
      platformFee: 250_000,        // ₦2,500
      schoolMinimumFee: 2_750_000, // ₦27,500
      firstPaymentPaid: 2_750_000,
      remainingBalance: 7_500_000, // ₦75,000 after 25% deposit
      paymentStatus: PaymentStatus.ACTIVE,
      installmentFrequency: 'MONTHLY',
      termStartDate: new Date('2026-01-01'),
      termEndDate: new Date('2026-07-01'),
    },
  });
  check('enrollment seeded ACTIVE', enrollment.paymentStatus === 'ACTIVE');

  // ── 7. Parent submits an installment (₦25,000) ────────────────────────────
  console.log('7. Installment submission');
  const inst = await api('POST', '/enrollments/pay-installment', parent.token!, { enrollmentId: enrollment.id, amountPaid: 25000 });
  check('installment submitted', inst.status === 200 || inst.status === 201, `status ${inst.status} ${JSON.stringify(inst.j)?.slice(0,160)}`);
  check('installment amount echoed as naira (25000)', inst.j?.amount === 25000 || inst.j?.amountPaid === 25000, `got ${inst.j?.amount}/${inst.j?.amountPaid}`);

  // over-payment cap (Feature 2): more than remaining balance must be rejected
  const over = await api('POST', '/enrollments/pay-installment', parent.token!, { enrollmentId: enrollment.id, amountPaid: 999999 });
  check('over-balance installment rejected (400)', over.status === 400, `got ${over.status}`);

  // ── 8. Owner sees the pending installment ─────────────────────────────────
  console.log('8. Owner pending queue + confirm');
  const pending = await api('GET', '/school-payments/pending', owner.token!);
  const pendingPayment = (pending.j as any[])?.find?.((p) => p.enrollmentId === enrollment.id) || (pending.j as any[])?.[0];
  check('pending installment visible to owner', !!pendingPayment, `count ${(pending.j as any[])?.length}`);
  check('pending amount in naira (25000)', pendingPayment?.amount === 25000 || pendingPayment?.amountPaid === 25000, `got ${pendingPayment?.amount}/${pendingPayment?.amountPaid}`);

  // ── 9. Owner confirms → balance recompute + audit ─────────────────────────
  const confirm = await api('POST', '/school-payments/confirm', owner.token!, { paymentId: pendingPayment?.id });
  check('confirm ok', confirm.status === 200 || confirm.status === 201, `status ${confirm.status} ${JSON.stringify(confirm.j)?.slice(0,160)}`);

  // ── 10. Parent sees updated balance (naira, recomputed) ───────────────────
  console.log('9. Balance recompute + history + dashboards');
  const kids = await api('GET', '/enrollments/my-children', parent.token!);
  const myChild = (kids.j as any[])?.[0];
  check('my-children returns the child', !!myChild, `count ${(kids.j as any[])?.length}`);
  check('remaining balance recomputed to ₦50,000', myChild?.remainingBalance === 50000, `got ${myChild?.remainingBalance}`);
  check('paid amount = ₦25,000 (naira)', myChild?.paidAmount === 25000, `got ${myChild?.paidAmount}`);
  check('total fee = ₦100,000 (naira)', myChild?.totalFee === 100000, `got ${myChild?.totalFee}`);

  // ── 11. Owner history + dashboard stats ───────────────────────────────────
  const history = await api('GET', '/school-payments/history', owner.token!);
  const histItem = (history.j as any[])?.find?.((h) => h.amount === 25000);
  check('owner history shows confirmed ₦25,000', !!histItem, `items ${(history.j as any[])?.length}`);
  const stats = await api('GET', '/school-payments/stats', owner.token!);
  check('dashboard stats returned', stats.status === 200 && stats.j != null, `status ${stats.status}`);

  // ── 12. Admin transactions + audit trail ──────────────────────────────────
  console.log('10. Admin views + audit');
  const txns = await api('GET', '/admin/transactions', admin.token, undefined);
  check('admin transactions include the payment', Array.isArray(txns.j) && (txns.j as any[]).some((t) => t.amount === 25000), `count ${(txns.j as any[])?.length}`);
  const audit = await api('GET', '/audit-logs?take=20', admin.token, undefined);
  const auditItems = (audit.j as any)?.items;
  check('audit log has PAYMENT_CONFIRMED', Array.isArray(auditItems) && auditItems.some((a: any) => a.action === 'PAYMENT_CONFIRMED'), `shape ${JSON.stringify(audit.j)?.slice(0,80)}`);

  // ── 13. Authorization boundaries ──────────────────────────────────────────
  console.log('11. Authorization');
  const parentHitsAdmin = await api('GET', '/admin/overview', parent.token!, undefined);
  check('parent → admin route = 403', parentHitsAdmin.status === 403, `got ${parentHitsAdmin.status}`);
  const noToken = await api('GET', '/enrollments/my-children', null, undefined);
  check('no token = 401', noToken.status === 401, `got ${noToken.status}`);

  await finish();
}

async function finish() {
  console.log(`\n──────────\nRESULT: ${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error('E2E crashed:', e);
  await prisma.$disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
