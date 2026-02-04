# 📘 LoPay API: The "Human-Friendly" Guide

**Welcome!** If you are connecting the frontend to the backend for the first time, this guide is for you. Don't worry—it's just like sending messages between two phones.

---

## 1. The "Dictionary" (Read this first!)

Before we start, let's agree on some words:

*   **Endpoint**: Think of this as a specific "webpage" or "address" for data. Instead of `google.com`, we have `.../auth/login`.
*   **Method (GET, POST)**: The *action* you want to do.
    *   `GET`: "Hey, **give me** some data." (Like loading a page).
    *   `POST`: "Hey, **take this** data and save it." (Like submitting a form).
*   **Payload (Body)**: The actual data you are sending (like the username and password in a form).
*   **Header**: Hidden information sent with the request. This is where we put the "ID Card" (Token) to prove who we are.

---

## 2. Getting Started

*   **Base URL**: `http://localhost:3000`
    *   *Every request starts with this.*
*   **The "Playground" (Swagger)**: [http://localhost:3000/api](http://localhost:3000/api)
    *   **Go here first!** It's a website where you can click buttons to test every single endpoint without writing code.

---

## 3. The "Golden Rule": Authentication 🔐

Almost every action in this app requires you to be logged in. We use a **Token** (like a digital ID card).

**How it works:**
1.  **Log In**: You send a username/password.
2.  **Get Token**: The backend sends back a long text string called `accessToken`.
3.  **Keep it**: Save this in your browser's `localStorage`.
4.  **Show it**: For *every single request* after that, you must show this token in the **Header**.

**❌ WRONG:**
`axios.get('http://localhost:3000/school-payments/stats')` -> *401 Unauthorized (Who are you?)*

**✅ RIGHT:**
```javascript
axios.get('http://localhost:3000/school-payments/stats', {
  headers: {
    Authorization: `Bearer YOUR_SAVED_TOKEN_HERE` // Don't forget the space after "Bearer"!
  }
})
```

---

## 4. "Recipes" (How to build the pages)

Here are the exact steps to build the main pages of the app.

### 🏫 Recipe A: The School Owner Dashboard

**Goal:** Show the owner how much money they've made.

1.  **Login**: `POST /auth/login`
    *   *Save the `accessToken`.*
2.  **Get Stats**: `GET /school-payments/stats`
    *   *What you get:* Total revenue, number of students, pending payments.
3.  **Get Recent Payments**: `GET /school-payments/pending`
    *   *What you get:* A list of parents who say they paid but need confirmation.

### 🎓 Recipe B: The Parent "My Kids" Page

**Goal:** Show a parent their children and payment status.

1.  **Login**: `POST /auth/login`
2.  **Get Kids**: `GET /enrollments/my-children`
    *   *What you get:* List of children, their class, and if they owe money.

### 💰 Recipe C: Confirming a Payment (School Owner)

**Goal:** A parent paid cash, and the owner wants to mark it as "Received".

1.  **Action**: `POST /school-payments/confirm`
2.  **Data to send (Body)**:
    ```json
    {
      "paymentId": "the-id-of-the-payment"
    }
    ```

---

## 5. 📚 The "Big Book" of Endpoints (Reference)

Here is every single route in the app, exactly what you need to send, and what you will get back.

### 🔑 Authentication

#### 1. Login
*   **Method**: `POST`
*   **URL**: `/auth/login`
*   **What to send (Body)**:
    ```json
    {
      "idToken": "eyJhbGciOiJSUzI1NiIs..." // The token from Firebase on frontend
    }
    ```
*   **What you get back**:
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
*   **Method**: `POST`
*   **URL**: `/auth/register`
*   **What to send (Body)**:
    ```json
    {
      "email": "newuser@example.com",
      "password": "secretpassword",
      "confirmPassword": "secretpassword",
      "fullName": "John Parent", // Required for parents
      "phoneNumber": "08012345678" // Required for parents
    }
    ```
*   **What you get back**:
    ```json
    {
      "id": "user-uuid",
      "email": "newuser@example.com",
      "role": "PARENT" // or SCHOOL_OWNER
    }
    ```

---

### 🏫 School Owner Actions

#### 3. Get Dashboard Stats
*   **Method**: `GET`
*   **URL**: `/school-payments/stats`
*   **Header**: `Authorization: Bearer <token>`
*   **What you get back**:
    ```json
    {
      "totalRevenue": 50000,
      "pendingRevenue": 2000,
      "totalStudents": 150,
      "activeStudents": 145
    }
    ```

#### 4. Get Pending Payments
*   **Method**: `GET`
*   **URL**: `/school-payments/pending`
*   **Header**: `Authorization: Bearer <token>`
*   **What you get back (Array)**:
    ```json
    [
      {
        "id": "payment-uuid-1",
        "amountPaid": 500,
        "studentName": "John Doe",
        "receiptUrl": "https://firebase...", // The proof of payment image
        "date": "2023-10-01T10:00:00Z"
      },
      {
        "id": "payment-uuid-2",
        "amountPaid": 300,
        "studentName": "Jane Smith",
        "date": "2023-10-02T11:00:00Z"
      }
    ]
    ```

#### 5. Confirm a Payment
*   **Method**: `POST`
*   **URL**: `/school-payments/confirm`
*   **Header**: `Authorization: Bearer <token>`
*   **What to send (Body)**:
    ```json
    {
      "paymentId": "payment-uuid-1"
    }
    ```
*   **What you get back**:
    ```json
    {
      "status": "success",
      "message": "Payment confirmed"
    }
    ```

---

### 👨‍👩‍👧 Parent Actions

#### 6. Get My Children
*   **Method**: `GET`
*   **URL**: `/enrollments/my-children`
*   **Header**: `Authorization: Bearer <token>`
*   **What you get back (Array)**:
    ```json
    [
      {
        "id": "enrollment-uuid",
        "childName": "Little Timmy",
        "schoolName": "Springfield Elementary",
        "className": "Grade 1",
        "remainingBalance": 1500,
        "paymentStatus": "ACTIVE"
      }
    ]
    ```

#### 7. Enroll a Child
*   **Method**: `POST`
*   **URL**: `/enrollments`
*   **Header**: `Authorization: Bearer <token>`
*   **What to send (Body)**:
    ```json
    {
      "childId": "child-uuid", // Optional (if child already exists)
      "childName": "Little Timmy", // Required if childId is missing (creates new child)
      "schoolId": "school-uuid",
      "className": "Grade 1",
      "installmentFrequency": "MONTHLY",
      "firstPaymentPaid": 500,
      "receiptUrl": "https://firebase...", // Optional proof of payment
      "termStartDate": "2023-09-01T00:00:00Z",
      "termEndDate": "2023-12-01T00:00:00Z"
    }
    ```

#### 8. Pay an Installment
*   **Method**: `POST`
*   **URL**: `/enrollments/pay-installment`
*   **Header**: `Authorization: Bearer <token>`
*   **What to send (Body)**:
    ```json
    {
      "enrollmentId": "enrollment-uuid",
      "amountPaid": 200,
      "receiptUrl": "https://firebase..." // Optional
    }
    ```

---

## 6. Troubleshooting (When things break) 💥

*   **401 Unauthorized**: "I don't know who you are."
    *   *Fix:* Did you forget the `Authorization: Bearer ...` header? Is the token expired? Log in again.
*   **403 Forbidden**: "You aren't allowed to do this."
    *   *Fix:* You are logged in as a **Parent** but trying to access a **School Owner** page.
*   **400 Bad Request**: "You sent me garbage."
    *   *Fix:* You are probably missing a field in the Body (like sending `email` instead of `username`). Check the [Swagger Docs](http://localhost:3000/api).