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
      "amountPaid": 5000,
      "paymentDate": "2023-10-01T12:00:00Z",
      "status": "SUCCESS", // PENDING, SUCCESS, FAILED
      "type": "INSTALLMENT",
      "studentName": "John Doe",
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
      "role": "PARENT"
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
    "user": { "id": "...", "email": "...", "role": "SCHOOL_OWNER" },
    "school": { "id": "...", "name": "..." }
  }
  ```

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
      "amountPaid": 500,
      "studentName": "John Doe",
      "className": "Grade 1",
      "schoolName": "Springfield Elementary",
      "receiptUrl": "https://firebase...", // The proof of payment image
      "paymentDate": "2023-10-01T10:00:00Z"
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
    "status": "success",
    "message": "First payment confirmed and enrollment activated"
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
    "status": "FAILED"
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
      "childName": "Little Timmy",
      "schoolName": "Springfield Elementary",
      "schoolId": "school-uuid",
      "className": "Grade 1",
      "remainingBalance": 1500,
      "paymentStatus": "ACTIVE", // PENDING, ACTIVE, COMPLETED, DEFAULTED, FAILED
      "nextPaymentDue": "2023-11-01",
      "payments": []
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
