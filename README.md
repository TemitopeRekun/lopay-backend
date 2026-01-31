# LoPay Backend

> **👋 Frontend Developers!**  
> Please read the **[API Integration Guide (API_GUIDE.md)](./API_GUIDE.md)** first.  
> It contains the "Human-Friendly" instructions, endpoint recipes, and troubleshooting tips you need to connect to this backend.

LoPay is a **school fee installment payment platform** designed to enable parents to pay school fees flexibly while ensuring schools receive confirmed payments and the platform earns a fixed service fee.

This backend is engineered with **security, trust, and financial integrity** as first-class concerns.

---

## 🚀 Project Overview

LoPay addresses critical challenges in education finance:

- **Parents** often struggle with lump-sum school fee payments.
- **Schools** require guaranteed, traceable payments.
- **Platforms** need controlled onboarding and robust fraud prevention.

**Key Value Propositions:**

- Controlled school onboarding.
- Flexible installment-based payments.
- Manual payment confirmations for security.
- Role-based access control (RBAC).
- Immutable financial records.

---

## 🧑‍💼 User Roles

### 👑 SUPER_ADMIN (Platform Owner)

_The administrator of the LoPay platform._

- **Access:** Login only (no public signup).
- **Responsibilities:**
  - Onboards schools and creates school owner accounts.
  - Receives all **first payments**.
  - Disburses the 25% share to schools.
  - Views global analytics (Total schools, students, revenue, platform earnings).

### 🏫 SCHOOL_OWNER

_The administrator for a specific school._

- **Creation:** Account created by SUPER_ADMIN.
- **Constraints:** Owns exactly **one school**; cannot change school identity.
- **Capabilities:**
  - Manage class fees.
  - Confirm payments.
  - Receive installment payments.
  - View school analytics.
  - Mark enrollments as defaulted.

### 👨‍👩‍👧 PARENT

_The end-user making payments._

- **Access:** Public signup.
- **Capabilities:**
  - Create child profiles.
  - Enroll children into schools.
  - Make first and installment payments.
  - View payment history and receive notifications.

---

## 💳 Financial Integrity & Payment Rules

### Fee Structure

1.  **Platform Fee:** **2.5% of the total school fee**. Fixed at enrollment.
2.  **School First Payment:** Minimum of **25% of the total school fee**.

### Minimum First Payment Formula

The system enforces a minimum deposit to ensure the platform fee is collected upfront:

> `minimumDeposit = (25% of school fee) + (2.5% platform fee)`

### Payment Lifecycle

All payments follow a strict status lifecycle controlled by backend logic:

> `PENDING` → `ACTIVE` → `COMPLETED` (or `DEFAULTED`)

1.  **Enrollment & First Payment:**
    - Parent selects school/class.
    - System calculates minimum payment.
    - Enrollment created with fee snapshots.
    - Status: `PENDING` until confirmed by School.
2.  **Installment Payments:**
    - Parent submits installment.
    - Status: `PENDING`.
    - School confirms payment → Balance updates.

---

## 🛠 Tech Stack

| Layer              | Technology             |
| :----------------- | :--------------------- |
| **Framework**      | NestJS (Node.js)       |
| **Language**       | TypeScript             |
| **Database**       | PostgreSQL             |
| **ORM**            | Prisma                 |
| **Auth**           | Firebase Auth + JWT    |
| **Validation**     | class-validator + Joi  |

---

## ⚙️ Configuration & Setup

### Environment Variables

Create a `.env` file in the root directory. You **must** define the following variables for the application to start (validation is enforced):

```env
# Server Config
NODE_ENV=development  # development | production | test
PORT=3000

# Database
DATABASE_URL="postgresql://user:password@localhost:5432/lopay?schema=public"

# Authentication (Backend JWT)
JWT_SECRET="your-strong-jwt-secret-here"

# Firebase Admin SDK (Get these from Firebase Console > Project Settings > Service Accounts)
FIREBASE_PROJECT_ID="your-project-id"
FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com"
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n..."
```

### Installation

```bash
npm install
```

### Running the app

```bash
# development
npm run start

# watch mode
npm run start:dev

# production mode
npm run start:prod
```
| **Framework**      | NestJS                 |
| **Language**       | TypeScript             |
| **ORM**            | Prisma                 |
| **Database**       | PostgreSQL             |
| **Authentication** | Firebase Admin + JWT   |
| **Architecture**   | Modular (Domain-based) |

---

## 🔐 Security & Architecture

### Authentication & Authorization

- **Auth:** Firebase Admin verifies identity; JWT issued for API access.
- **JWT Payload:** `{ userId, role, schoolId? }`
- **Guards:** `JwtAuthGuard` (validates user), `RolesGuard` (enforces permissions).
- **Security Note:** User identity is derived strictly from `req.user`, never from the request body.

### Database Design Principles

- **Snapshots:** Financial data (fees) is snapshotted at enrollment.
- **Immutability:** Financial records are never mutated, only appended.
- **Audit:** Full history is preserved to prevent recalculation errors.

---

## Getting Started

### Installation

```bash
$ npm install
```

### Running the Application

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

### Testing

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

---

## 🚧 Roadmap

- [ ] Paystack / Flutterwave integration
- [ ] Automated settlement
- [ ] Admin dashboards
- [ ] Penalty handling
- [ ] Credit scoring
- [ ] Mobile apps
- [ ] Webhooks