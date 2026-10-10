# High-Concurrency Train Ticketing Backend Platform

A production-grade, event-driven backend system engineered to handle high-throughput flash-sale traffic, multi-segment seat allocations (e.g., Delhi–Kanpur–Patna), and distributed transaction lifecycles with zero race conditions.

---

## 📸 Architecture Overview

```
                                  [ Passenger / Client ]
                                     /             \
                                checks seats    submits booking
                                   /                 \
        +-------------------------+                   +-------------------------+
        |  Availability API       |                   |  Booking API            |
        |  (availability.ts)      |                   |  (bookings.ts)          |
        +------------+------------+                   +------------+------------+
                     |                                             |
                     |                                     resolves journey
                     |                                             v
                     |                                +-------------------------+
                     |                                |  Journey Resolution     |
                     |                                |  (journey.ts)           |
                     |                                +------------+------------+
                     |                                             |
                     +----------------------+----------------------+
                                            |
                                  reads / writes / locks
                                            v
        +-----------------------------------------------------------------------+
        |                          SHARED INFRASTRUCTURE                        |
        |  +-----------------------+  +------------------+  +-----------------+  |
        |  | Shared API Types      |  | Postgres Seats   |  | Redis Lock      |  |
        |  | (index.ts)            |  | (003_bookings)   |  | (lock.ts)       |  |
        |  +-----------------------+  +------------------+  +-----------------+  |
        +-----------------------------------------------------------------------+
                                            ^
                                            | guards jobs / updates booking
                                            v
        +-----------------------------------------------------------------------+
        |                          BACKGROUND OPERATIONS                        |
        |  +-----------------------+  +------------------+  +-----------------+  |
        |  | Job Scheduler         |  | Outbox Worker    |  | Hold Sweeper    |  |
        |  | (scheduler.ts)        |  | (queue.ts)       |  | (sweeper.ts)    |  |
        |  +-----------------------+  +------------------+  +-----------------+  |
        +-----------------------------------------------------------------------+
                                            ^
                                            | updates / promotes / reconciles
                                            v
        +-----------------------------------------------------------------------+
        |                            BOOKING LIFECYCLE                          |
        |  +------------------+  +---------------------+  +-------------------+  |
        |  | Cancellations    |  | Waitlist Promotion  |  | Payment Webhooks  |  |
        |  | & Refunds        |  | (waitlist.ts)       |  | & Signatures      |  |
        |  +------------------+  +---------------------+  +-------------------+  |
        +-----------------------------------------------------------------------+
```

---

## 🌟 Key Features

* **Multi-Segment Inventory Model:** Correctly calculates and reserves seat availability across overlapping leg segments along a train's route rather than treating seats as binary all-or-nothing allocations.
* **Dual-Layer Concurrency Strategy:**
  * **Fast Temporary Holds:** Uses atomic Redis operations (`SETNX` with TTL) for rapid seat reservations during peak demand.
  * **Final Consistency:** Enforces strict transactional integrity in PostgreSQL using row-level locking (`SELECT FOR UPDATE SKIP LOCKED`).
* **Transactional Outbox Pattern:** Guarantees notification reliability (SMS/Email) by persisting outbound messages inside the primary booking transaction before processing through background workers.
* **Asynchronous Background Processing:** Uses Redis-backed BullMQ workers for job scheduling, notification dispatching, expired hold sweeps, and automated waitlist promotions.
* **Idempotent Payment Engine:** Built-in payment lifecycle supporting cryptographic webhook signature verification, automatic reconciliation jobs, and state-machine-driven refund flows.

---

## 🛠️ Tech Stack

* **Language & Runtime:** TypeScript, Node.js
* **Framework & Validation:** NestJS / Fastify, Zod
* **Database & ORM:** PostgreSQL, Drizzle ORM / Prisma
* **Caching & Distributed Locks:** Redis, ioredis
* **Queue & Scheduler:** BullMQ
* **Infrastructure & Proxy:** Docker, Kubernetes, Nginx

---

## 📁 Repository Structure

```text
src/
├── booking/                  # Core Booking Subsystem
│   ├── availability.ts       # Seat availability check routes & logic
│   ├── bookings.ts           # Primary booking request controller & handlers
│   └── journey.ts            # Route resolution and leg segment mapping
├── lifecycle/                # Lifecycle Operations
│   ├── cancel.ts             # Cancellation logic & refund triggers
│   ├── refund.ts             # Refund workflow handlers
│   ├── waitlist.ts           # Automated waitlist promotion engine
│   ├── stages.ts             # Booking state machine transitions
│   ├── payments.ts           # Payment processing & status updates
│   ├── fakebank.ts           # Payment provider sandbox simulator
│   └── signature.ts          # Cryptographic signature verification for webhooks
├── background/               # Background Operations & Queues
│   ├── scheduler.ts          # Cron and scheduled task orchestration
│   ├── sweeper.ts            # Expired hold cleaner sweep job
│   ├── queue.ts              # BullMQ notification consumer/worker
│   ├── outbox.ts             # Transactional outbox reader/writer
│   └── providers.ts          # Email and SMS delivery service integration
└── infrastructure/           # Shared Utilities & Data Layer
    ├── index.ts              # Shared DTOs and API types
    ├── lock.ts               # Distributed locking wrappers
    ├── redis.ts              # Redis connection client setup
    └── migrations/
        └── 003_bookings.sql  # Schema definitions & database constraints
```

---

## 🚀 Getting Started

### Prerequisites

* Node.js >= 18.x
* PostgreSQL >= 14.x
* Redis >= 6.x
* Docker & Docker Compose (optional for local infra)

### Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/your-username/train-ticketing-backend.git
   cd train-ticketing-backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   Create a `.env` file in the root directory:
   ```env
   PORT=3000
   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ticketing_db
   REDIS_URL=redis://localhost:6379
   JWT_SECRET=your_jwt_secret
   PAYMENT_WEBHOOK_SECRET=your_webhook_secret
   ```

4. **Run Database Migrations:**
   ```bash
   npm run db:migrate
   ```

5. **Start Development Server:**
   ```bash
   npm run dev
   ```

---

## ⚡ Concurrency & Lock Mechanism

When thousands of users attempt to book the same seat simultaneously:

1. **Redis Hold:** An atomic multi-key script evaluates seat-segment availability and sets a short TTL lock key (`hold:train:date:seat:segment`).
2. **Postgres Reserve:** On payment initiation, a database transaction validates the hold and commits the record with row-level locks:
   ```sql
   SELECT * FROM seat_inventory 
   WHERE train_id = $1 AND seat_number = $2 AND segment_id = ANY($3) 
   FOR UPDATE SKIP LOCKED;
   ```
3. **Automatic Cleanup:** If a user abandons checkout, Redis expires the key automatically, while `sweeper.ts` clears any orphaned database holds.

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
