# 📘 LoPay API: The "Human-Friendly" Guide

**Welcome!** If you are connecting the frontend to the backend for the first time, this guide is for you. Don't worry—it's just like sending messages between two phones.

---

## 1. The "Dictionary" (Read this first!)

Before we start, let's agree on some words:

- **Endpoint**: Think of this as a specific "webpage" or "address" for data. Instead of `google.com`, we have `.../auth/login`.
- **Method (GET, POST)**: The _action_ you want to do.
  - `GET`: "Hey, **give me** some data." (Like loading a page).
  - `POST`: "Hey, **take this** data and save it." (Like submitting a form).
- **Payload (Body)**: The actual data you are sending (like the username and password in a form).
- **Header**: Hidden information sent with the request. This is where we put the "ID Card" (Token) to prove who we are.

---

## 2. Getting Started

- **Base URL**: `http://localhost:3000`
  - _Every request starts with this._
- **The "Playground" (Swagger)**: [http://localhost:3000/api](http://localhost:3000/api)
  - **Go here first!** It's a website where you can click buttons to test every single endpoint without writing code.

---

## 3. The "Golden Rule": Authentication 🔐

Almost every action in this app requires you to be logged in. We use a **Token** (like a digital ID card).

**How it works:**

1.  **Log In**: You send a username/password.
2.  **Get Token**: The backend sends back a long text string called `accessToken`.
3.  **Keep it**: Save this in your browser's `localStorage`.
4.  **Show it**: For _every single request_ after that, you must show this token in the **Header**.

**❌ WRONG:**
`axios.get('http://localhost:3000/school-payments/stats')` -> _401 Unauthorized (Who are you?)_

**✅ RIGHT:**

```javascript
axios.get('http://localhost:3000/school-payments/stats', {
  headers: {
    Authorization: `Bearer YOUR_SAVED_TOKEN_HERE`, // Don't forget the space after "Bearer"!
  },
});
```

---

## 4. "Recipes" (How to build the pages)

Here are the exact steps to build the main pages of the app.

### 🏫 Recipe A: The School Owner Dashboard

**Goal:** Show the owner how much money they've made.

1.  **Login**: `POST /auth/login`
    - _Save the `accessToken`._
2.  **Get Stats**: `GET /school-payments/stats`
    - _What you get:_ Total revenue, number of students, pending payments.
3.  **Get Recent Payments**: `GET /school-payments/pending`
    - _What you get:_ A list of parents who say they paid but need confirmation.

### 🎓 Recipe B: The Parent "My Kids" Page

**Goal:** Show a parent their children and payment status.

1.  **Login**: `POST /auth/login`
2.  **Get Kids**: `GET /enrollments/my-children`
    - _What you get:_ List of children, their class, and if they owe money.

### 🏫 Recipe C: The School List (For Parents)

**Goal:** Parents pick a school from a dropdown list.

1.  **Get Schools**: `GET /schools`
    - _Auth:_ **Public** (No token needed)
    - _What you get:_ A list of all registered schools (ID, Name, Address).

### 💰 Recipe D: Confirming or Rejecting a Payment (School Owner)

**Goal:** A parent paid, and the owner wants to mark it as "Received" or "Rejected".

**To Confirm:**

1.  **Action**: `POST /school-payments/confirm`
2.  **Data to send (Body)**:

    ```json
    {
      "paymentId": "the-id-of-the-payment"
    }
    ```

    - _Result:_ Payment becomes `SUCCESS`. Enrollment becomes `ACTIVE` (if first payment) or `COMPLETED` (if fully paid).

**To Reject:**

1.  **Action**: `POST /school-payments/reject`
2.  **Data to send (Body)**:

    ```json
    {
      "paymentId": "the-id-of-the-payment"
    }
    ```

    - _Result:_ Payment becomes `FAILED`. Enrollment becomes `FAILED` (if first payment).

---

## 5. 📚 The "Big Book" of Endpoints (Reference)

Here is every single route in the app, exactly what you need to send, and what you will get back.

### 🔑 Authentication

#### 0. Global Transaction History

- **Method**: `GET`
- **URL**: `/transactions`
- **Header**: `Authorization: Bearer <token>`
- **What you get back**:
  ```json
  [
    {
      "id": "payment-uuid",
      "amount": 5000, // Alias for amountPaid
      "amountPaid": 5000,
      "date": "2023-10-01T12:00:00Z", // Alias for paymentDate
      "paymentDate": "2023-10-01T12:00:00Z",
      "status": "SUCCESS", // PENDING, SUCCESS, FAILED
      "type": "INSTALLMENT", // Alias for paymentType
      "paymentType": "INSTALLMENT",
      "studentName": "John Doe",
      "childName": "John Doe", // Alias for studentName
      "className": "Grade 1",
      "schoolName": "Springfield Elementary"
    }
  ]
  ```

#### 1. Login

- **Method**: `POST`
- **URL**: `/auth/login`
- **What to send (Body)**:
  ```json
  {
    "idToken": "eyJhbGciOiJSUzI1NiIs..." // The token from Firebase on frontend
  }
  ```
- **What you get back**:
  ```json
  {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...", // ⚠️ SAVE THIS TOKEN!
    "user": {
      "id": "user-uuid",
      "email": "parent@example.com",
      "fullName": "John Parent",
      "role": "PARENT",
      "createdAt": "2023-10-01T12:00:00Z"
    }
  }
  ```

#### 2. Register

- **Method**: `POST`
- **URL**: `/auth/register`
- **What to send (Body)**:
  ```json
  {
    "email": "newuser@example.com",
    "password": "secretpassword",
    "confirmPassword": "secretpassword",
    "fullName": "John Parent", // Required for parents
    "phoneNumber": "08012345678" // Required for parents
  }
  ```
- **What you get back**:
  ```json
  {
    "id": "user-uuid",
    "email": "newuser@example.com",
    "role": "PARENT" // or SCHOOL_OWNER
  }
  ```

#### 3. Super Admin: Onboard School

- **Method**: `POST`
- **URL**: `/admin/onboard-school`
- **Header**: `Authorization: Bearer <token>` (Must be Super Admin)
- **What to send (Body)**:
  ```json
  {
    "schoolName": "Springfield Elementary",
    "ownerEmail": "school@owner.com",
    "ownerPassword": "securepassword",
    "ownerName": "Principal Skinner",
    "address": "123 School Lane",
    "phone": "08012345678",
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```
- **What you get back**:
  ```json
  {
    "user": { 
      "id": "...", 
      "email": "...", 
      "fullName": "Principal Skinner",
      "role": "SCHOOL_OWNER" 
    },
    "school": { "id": "...", "name": "..." }
  }
  ```

#### 4. Super Admin: View Pending First Payments

- **Method**: `GET`
- **URL**: `/admin/pending-first-payments`
- **Header**: `Authorization: Bearer <token>` (Must be Super Admin)
- **What you get back (Array)**:
  ```json
  [
    {
      "id": "payment-uuid",
      "studentName": "John Doe",
      "childName": "John Doe",
      "schoolName": "Springfield Elementary",
      "className": "Grade 1",
      "amount": 50000,
      "date": "2023-10-01T10:00:00Z",
      "type": "FIRST_PAYMENT",
      "paymentType": "FIRST_PAYMENT"
    }
  ]
  ```

#### 5. Super Admin: Settle or Reject First Payment

- **Settle (Approve)**
  - **Method**: `POST`
  - **URL**: `/admin/settle-first-payment/:paymentId`
  - **Header**: `Authorization: Bearer <token>` (Must be Super Admin)
  - **What happens**:
    - First `Payment` → `status = "SUCCESS"`, `isConfirmed = true`.
    - `ChildEnrollment` → `paymentStatus = "ACTIVE"`.

- **Reject**
  - **Method**: `POST`
  - **URL**: `/admin/reject-first-payment/:paymentId`
  - **Header**: `Authorization: Bearer <token>` (Must be Super Admin)
  - **What happens**:
    - First `Payment` → `status = "FAILED"`, `isConfirmed` remains `false`.
    - `ChildEnrollment` → `paymentStatus = "FAILED"` (no balance changes).
    - Notifications are sent to School Owner and Parent explaining that the first payment was rejected and parent should pay again with a clearer receipt.

#### 6. Super Admin: View Pending Installment Payments (Read-Only)

- **Method**: `GET`
- **URL**: `/admin/pending-installments`
- **Header**: `Authorization: Bearer <token>` (Must be Super Admin)
- **What you get back (Array)**:
  ```json
  [
    {
      "id": "payment-uuid-1",
      "amount": 500,
      "amountPaid": 500,
      "studentName": "John Doe",
      "childName": "John Doe",
      "className": "Grade 1",
      "schoolName": "Springfield Elementary",
      "receiptUrl": "https://firebase...",
      "date": "2023-10-01T10:00:00Z",
      "paymentDate": "2023-10-01T10:00:00Z",
      "type": "INSTALLMENT",
      "paymentType": "INSTALLMENT"
    }
  ]
  ```
- **Note**: This endpoint is **read-only**. Only `SCHOOL_OWNER` users can confirm or reject installments via `/school-payments/confirm` and `/school-payments/reject`.

#### 6. Super Admin: View Students for a School (Read-Only)

- **Method**: `GET`
- **URL**: `/admin/schools/:schoolId/students`
- **Header**: `Authorization: Bearer <token>` (Must be Super Admin)
- **Query Params**:
  - `?className=Grade 1` (Optional: Filter by class)
  - `?search=John` (Optional: Search by student or parent name)
- **What you get back**: Same shape as `/school-payments/students` (see below).

---

### 🏫 School Owner Actions

#### 4. Manage Class Fees

- **Method**: `POST`
- **URL**: `/school-payments/fees`
- **Header**: `Authorization: Bearer <token>`
- **What to send (Body)**:
  ```json
  {
    "className": "Grade 1",
    "feeAmount": 50000
  }
  ```
- **What you get back**:
  ```json
  {
    "id": "fee-uuid",
    "className": "Grade 1",
    "feeAmount": 50000,
    "schoolId": "..."
  }
  ```

#### 5. Get Dashboard Stats

- **Method**: `GET`
- **URL**: `/school-payments/stats`
- **Header**: `Authorization: Bearer <token>`
- **What you get back**:
  ```json
  {
    "totalRevenue": 50000,
    "pendingRevenue": 2000,
    "totalStudents": 150,
    "activeStudents": 145
  }
  ```

#### 6. Get Pending Payments

- **Method**: `GET`
- **URL**: `/school-payments/pending`
- **Header**: `Authorization: Bearer <token>`
- **What you get back (Array)**:
  ```json
  [
    {
      "id": "payment-uuid-1",
      "amount": 500, // Alias
      "amountPaid": 500,
      "studentName": "John Doe",
      "childName": "John Doe", // Alias
      "className": "Grade 1",
      "schoolName": "Springfield Elementary",
      "receiptUrl": "https://firebase...", // The proof of payment image
      "date": "2023-10-01T10:00:00Z", // Alias
      "paymentDate": "2023-10-01T10:00:00Z",
      "type": "INSTALLMENT", // Alias
      "paymentType": "INSTALLMENT",
      "status": "SUCCESS"
    }
  ]
  ```

#### 7. Get All Students (Search & Filter)

- **Method**: `GET`
- **URL**: `/school-payments/students`
- **Header**: `Authorization: Bearer <token>`
- **Query Params**:
  - `?className=Grade 1` (Optional: Filter by class)
  - `?search=John` (Optional: Search by student name, parent email, or phone)
- **What you get back**:
  ```json
  [
    {
      "id": "enrollment-uuid",
      "studentName": "John Doe", // Alias
      "childName": "John Doe",
      "className": "Grade 1",
      "parentName": "Jane Doe",
      "parentEmail": "jane@example.com",
      "parentPhone": "08012345678",
      "remainingBalance": 50000,
      "status": "ACTIVE" // PENDING, ACTIVE, COMPLETED, DEFAULTED, FAILED
    }
  ]
  ```

#### 8. Confirm a Payment

#### 10. Update School Bank Details (Profile)

- **Method**: `PUT`
- **URL**: `/school-payments/bank-details`
- **Header**: `Authorization: Bearer <token>` (Must be School Owner)
- **What to send (Body)**:
  ```json
  {
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```
- **What you get back** (example):
  ```json
  {
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```

Use this in the School Owner profile/settings screen when they need to change their payout account.

#### 8. Confirm a Payment

#### 10. Update School Bank Details (Profile)

- **Method**: `PUT`
- **URL**: `/school-payments/bank-details`
- **Header**: `Authorization: Bearer <token>` (Must be School Owner)
- **What to send (Body)**:
  ```json
  {
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```
- **What you get back** (example):
  ```json
  {
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```

Use this in the School Owner profile/settings screen when they need to change their payout account.

#### 8. Confirm a Payment

#### 10. Update School Bank Details (Profile)

- **Method**: `PUT`
- **URL**: `/school-payments/bank-details`
- **Header**: `Authorization: Bearer <token>` (Must be School Owner)
- **What to send (Body)**:
  ```json
  {
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```
- **What you get back** (example):
  ```json
  {
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```

Use this in the School Owner profile/settings screen when they need to change their payout account.

#### 8. Confirm a Payment

#### 10. Update School Bank Details (Profile Settings)

- **Method**: `PUT`
- **URL**: `/school-payments/bank-details`
- **Header**: `Authorization: Bearer <token>` (Must be School Owner)
- **What to send (Body)**:
  ```json
  {
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```
- **What you get back** (example):
  ```json
  {
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```

Use this in the School Owner profile/settings screen when they need to change their payout account.

#### 8. Confirm a Payment

- **Method**: `POST`
- **URL**: `/school-payments/confirm`
- **Header**: `Authorization: Bearer <token>`
- **What to send (Body)**:
  ```json
  {
    "paymentId": "payment-uuid-1"
  }
  ```
- **What you get back**:
  ```json
  {
    "id": "payment-uuid-1",
    "status": "SUCCESS",
    "amount": 500,
    "amountPaid": 500,
    "studentName": "John Doe",
    "childName": "John Doe",
    "date": "2023-10-01T12:00:00Z",
    "type": "INSTALLMENT"
  }
  ```

#### 9. Reject a Payment

- **Method**: `POST`
- **URL**: `/school-payments/reject`
- **Header**: `Authorization: Bearer <token>`
- **What to send (Body)**:
  ```json
  {
    "paymentId": "payment-uuid-1"
  }
  ```
- **What you get back**:
  ```json
  {
    "id": "payment-uuid",
    "status": "FAILED",
    "amount": 500,
    "amountPaid": 500,
    "studentName": "John Doe",
    "childName": "John Doe",
    "type": "INSTALLMENT"
  }
  ```

---

### 👨‍👩‍👧 Parent Actions

#### 8. Get All Schools (For Dropdown)

- **Method**: `GET`
- **URL**: `/schools`
- **Header**: `None` (Public Endpoint)
- **Query**: `?search=Name` (Optional)
- **What you get back**:
  ```json
  [
    {
      "id": "school-uuid",
      "name": "Springfield Elementary",
      "email": "school@example.com",
      "address": "123 Lane",
      "phone": "080..."
    }
  ]
  ```

#### 9. Get School Fees (Public/Read-Only)

- **Method**: `GET`
- **URL**: `/school-payments/fees/:schoolId`
- **What you get back**:
  ```json
  [
    {
      "className": "Grade 1",
      "feeAmount": 50000
    }
  ]
  ```

#### 10. Get School Bank Details (For Installment Payments)

- **Method**: `GET`
- **URL**: `/school-payments/bank-details/:schoolId`
- **Header**: `None` (Public/Parent access)
- **What you get back**:
  ```json
  {
    "bankName": "Springfield Bank",
    "accountName": "Springfield Elementary School",
    "accountNumber": "1234567890"
  }
  ```

> Use this when building the parent installment payment screen so you can display the correct school account details.

#### 11. Get My Children

- **Method**: `GET`
- **URL**: `/enrollments/my-children`
- **Header**: `Authorization: Bearer <token>`
- **What you get back (Array)**:
  ```json
  [
    {
      "id": "enrollment-uuid",
      "childId": "child-uuid",
      "studentName": "Little Timmy", // Alias
      "childName": "Little Timmy",
      "schoolName": "Springfield Elementary",
      "schoolId": "school-uuid",
      "className": "Grade 1",
      "remainingBalance": 1500,
      "paymentStatus": "ACTIVE", // PENDING, ACTIVE, COMPLETED, DEFAULTED, FAILED
      "nextDueDate": "2023-11-01", // Standardized date format (YYYY-MM-DD)
      "payments": [
        {
           "amount": 500,
           "amountPaid": 500,
           "date": "2023-10-01",
           "paymentDate": "2023-10-01",
           "type": "INSTALLMENT",
           "paymentType": "INSTALLMENT"
        }
      ]
    }
  ]
  ```

#### 12. Enroll a Child

- **Method**: `POST`
- **URL**: `/enrollments`
- **Header**: `Authorization: Bearer <token>`
- **What to send (Body)**:
  ```json
  {
    "childId": "uuid-string", // Optional: If enrolling existing child
    "childName": "Little Timmy", // Optional: If creating new child
    "schoolId": "school-uuid",
    "className": "JSS1",
    "installmentFrequency": "MONTHLY", // or "WEEKLY" (Case-insensitive)
    "firstPaymentPaid": 41250, // Should match totalInitialPayment from calculation
    "termStartDate": "2023-09-01T00:00:00Z",
    "termEndDate": "2023-12-01T00:00:00Z",
    "receiptUrl": "https://firebase..." // Optional
  }
  ```
- **What you get back**:
  ```json
  {
    "enrollment": { ... },
    "payment": { ... },
    "calculation": { ... },
    "school": {
       "id": "...",
       "name": "Springfield Elementary",
       "bankName": "...",
       "accountNumber": "..."
    }
  }
  ```

#### 13. Calculate Payment Structure (New)

- **Method**: `POST`
- **URL**: `/payment/calculate-structure`
- **Header**: `Authorization: Bearer <token>`
- **What to send (Body)**:
  ```json
  {
    "schoolId": "uuid-string",
    "totalAmount": 150000,
    "feeType": "Semester",
    "grade": "JSS1"
  }
  ```
- **What you get back**:
  ```json
  {
    "originalAmount": 150000,
    "platformFeeAmount": 3750,
    "totalPayable": 153750,
    "depositAmount": 37500,
    "totalInitialPayment": 41250,
    "depositPercentage": 0.25,
    "remainingBalance": 112500,
    "platformFeePercentage": 0.025,
    "plans": [
      {
        "type": "Weekly",
        "frequencyLabel": "/ week",
        "numberOfPayments": 12,
        "baseAmount": 9375,
        "totalAmount": 9375
      },
      {
        "type": "Monthly",
        "frequencyLabel": "/ month",
        "numberOfPayments": 3,
        "baseAmount": 37500,
        "totalAmount": 37500
      }
    ]
  }
  ```

#### 14. Pay an Installment

- **Method**: `POST`
- **URL**: `/enrollments/pay-installment`
- **Header**: `Authorization: Bearer <token>`
- **What to send (Body)**:
  ```json
  {
    "enrollmentId": "enrollment-uuid",
    "amountPaid": 200,
    "receiptUrl": "https://firebase..." // Optional
  }
  ```

### 🔔 Notifications

#### 15. Get My Notifications

- **Method**: `GET`
- **URL**: `/notifications`
- **Header**: `Authorization: Bearer <token>`
- **What you get back (Array)**:
  ```json
  [
    {
      "id": "notification-uuid",
      "title": "Payment Confirmed",
      "message": "Your payment of 5000 for Little Timmy (Grade 1) at Springfield Elementary has been confirmed.",
      "link": "/school/pending-payments",
      "isRead": false,
      "createdAt": "2023-10-01T12:00:00Z"
    }
  ]
  ```

#### 16. Mark Notification as Read

- **Method**: `PATCH`
- **URL**: `/notifications/:id/read`
- **Header**: `Authorization: Bearer <token>`
- **What you get back**:
  ```json
  {
    "id": "notification-uuid",
    "isRead": true
  }
  ```

---

## 6. Troubleshooting (When things break) 💥

- **401 Unauthorized**: "I don't know who you are."
  - _Fix:_ Did you forget the `Authorization: Bearer ...` header? Is the token expired? Log in again.
- **403 Forbidden**: "You aren't allowed to do this."
  - _Fix:_ You are logged in as a **Parent** but trying to access a **School Owner** page.
- **400 Bad Request**: "You sent me garbage."
  - _Fix:_ You are probably missing a field in the Body (like sending `email` instead of `username`). Check the [Swagger Docs](http://localhost:3000/api).

---

## 7. End-to-End Payment Flow (From First Payment to Completion)

This section shows the full payment journey: from the very first deposit to the final installment.

### Step 1: Parent checks school and fees

1. **List schools** (for dropdown)
   - `GET /schools`
2. **Get fees for a school**
   - `GET /school-payments/fees/:schoolId`
3. **Calculate structure (optional UI helper)**
   - `POST /payment/calculate-structure`

### Step 2: Parent starts an enrollment (First Payment)

1. **Create enrollment + first payment**
   - `POST /enrollments`
   - Body includes: `schoolId`, `className`, `childId` or `childName`, `firstPaymentPaid`, dates, `receiptUrl`.
   - Backend creates:
     - `ChildEnrollment` with `paymentStatus = "PENDING"`.
     - `Payment` record with:
       - `paymentType = "FIRST_PAYMENT"`
       - `status = "PENDING"`
       - `isConfirmed = false`
       - `receiver = "PLATFORM"`

2. **What parent sees after this**
   - On `GET /enrollments/my-children` the enrollment appears with:
     - `paymentStatus = "PENDING"`
     - `remainingBalance` set
     - First payment visible in `payments[]` with `type = "FIRST_PAYMENT"` and `status = "PENDING"`.

### Step 3: First payment confirmation (activate enrollment)

There are two supported ways to confirm the first payment. The recommended flow for LoPay is that the **platform admin (SUPER_ADMIN)** settles it.

1. **Platform admin settles the first payment (recommended)**
   - List pending first payments:
     - `GET /admin/pending-first-payments`
   - When the admin clicks "Settle" for a payment:
     - `POST /admin/settle-first-payment/:paymentId`
   - Backend updates:
     - The first `Payment` → `status = "SUCCESS"`, `isConfirmed = true`.
     - The `ChildEnrollment` → `paymentStatus = "ACTIVE"`.

2. **Alternative: School owner confirms first payment**
   - `POST /enrollments/confirm-first-payment`
   - Body: `{ "enrollmentId": "..." }`
   - Backend performs equivalent updates for that enrollment.

3. **After confirmation (either path)**
   - Parent’s `GET /enrollments/my-children` now shows:
     - `paymentStatus = "ACTIVE"`
     - First payment in `payments[]` with `status = "SUCCESS"`.

### Step 4: Ongoing installment payments (go to the school)

1. **Parent pays an installment**
   - `POST /enrollments/pay-installment`
   - Body: `{ "enrollmentId", "amountPaid", "receiptUrl" }`
   - Backend creates `Payment` with:
     - `paymentType = "INSTALLMENT"`
     - `status = "PENDING"`
     - `isConfirmed = false`
     - `receiver = "SCHOOL"`

2. **School owner sees pending installments**
   - `GET /school-payments/pending`
   - Returns an array of pending **installment** payments only:
     - `paymentType = "INSTALLMENT"`
     - `isConfirmed = false`

3. **School approves or rejects an installment**
   - Approve: `POST /school-payments/confirm` with `{ "paymentId" }`
     - Payment → `status = "SUCCESS"`, `isConfirmed = true`.
     - Enrollment → `remainingBalance` reduced; if balance ≤ 0, `paymentStatus = "COMPLETED"`.
   - Reject: `POST /school-payments/reject` with `{ "paymentId" }`
     - Payment → `status = "FAILED"` (still `isConfirmed = false`).
     - If it was a first payment (edge case), enrollment may become `FAILED`.

### Step 5: History and reconciliation

- **Parent view (per child)**
  - `GET /enrollments/my-children`
  - Shows each child’s enrollment, `paymentStatus`, `remainingBalance`, and all `payments[]` (first + installments), each with:
    - `status` (`PENDING`, `SUCCESS`, `FAILED`)
    - `type` (`FIRST_PAYMENT`, `INSTALLMENT`)
    - `amount` / `amountPaid`, `date` / `paymentDate`.

- **School view (per school)**
  - `GET /school-payments/history`
  - Shows confirmed payments for that school (mostly installments) for their own records.

- **Platform/Admin view (global)**
  - `GET /transactions`
  - Shows all payments (first + installments) across all schools and parents for audit and dispute resolution.
  - `GET /admin/pending-first-payments` – queue of first payments waiting for SUPER_ADMIN settlement.
  - `GET /admin/pending-installments` – read-only list of pending installment payments across all schools.
  - `GET /admin/schools/:schoolId/students` – read-only view of students/enrollments for a specific school.

This flow ensures:
- First payments are controlled and tracked by the platform (onboarding and activation) via the admin endpoints.
- Installments are controlled by the school (ongoing collections) via `/school-payments/*`.
- Every payment is recorded and can be audited through the history and transactions endpoints.
