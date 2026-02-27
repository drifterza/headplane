import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { ulid } from "ulidx";
import { beforeEach, describe, expect, test } from "vitest";

import { users } from "~/server/db/schema";
import { Roles } from "~/server/web/roles";

// Create in-memory database for testing
function createTestDb() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  return { client, db };
}

// Create the users table schema
async function setupSchema(client: ReturnType<typeof createClient>) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      sub TEXT NOT NULL UNIQUE,
      caps INTEGER NOT NULL DEFAULT 0,
      onboarded INTEGER NOT NULL DEFAULT 0,
      headscale_user_id TEXT
    )
  `);
}

describe("Session role assignment", () => {
  let db: ReturnType<typeof drizzle>;
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    client = testDb.client;
    await setupSchema(client);
  });

  describe("reassignSubject upsert behavior", () => {
    test("creates user record when subject does not exist", async () => {
      const subject = "new-user-subject";
      const role = "admin";

      // Verify user doesn't exist
      const beforeInsert = await db.select().from(users).where(eq(users.sub, subject));
      expect(beforeInsert.length).toBe(0);

      // Perform upsert (simulating reassignSubject)
      await db
        .insert(users)
        .values({
          id: ulid(),
          sub: subject,
          caps: Roles[role],
          onboarded: false,
        })
        .onConflictDoUpdate({
          target: users.sub,
          set: { caps: Roles[role] },
        });

      // Verify user was created with correct role
      const afterInsert = await db.select().from(users).where(eq(users.sub, subject));
      expect(afterInsert.length).toBe(1);
      expect(afterInsert[0].caps).toBe(Roles.admin);
    });

    test("updates existing user role without creating duplicate", async () => {
      const subject = "existing-user";
      const initialRole = "member";
      const newRole = "admin";

      // Create initial user
      await db.insert(users).values({
        id: ulid(),
        sub: subject,
        caps: Roles[initialRole],
        onboarded: true,
      });

      // Verify initial state
      const beforeUpdate = await db.select().from(users).where(eq(users.sub, subject));
      expect(beforeUpdate.length).toBe(1);
      expect(beforeUpdate[0].caps).toBe(Roles.member);
      expect(beforeUpdate[0].onboarded).toBe(true);

      // Perform upsert (simulating reassignSubject)
      await db
        .insert(users)
        .values({
          id: ulid(),
          sub: subject,
          caps: Roles[newRole],
          onboarded: false,
        })
        .onConflictDoUpdate({
          target: users.sub,
          set: { caps: Roles[newRole] },
        });

      // Verify role was updated, no duplicate created
      const afterUpdate = await db.select().from(users).where(eq(users.sub, subject));
      expect(afterUpdate.length).toBe(1);
      expect(afterUpdate[0].caps).toBe(Roles.admin);
      // onboarded should remain true (not overwritten)
      expect(afterUpdate[0].onboarded).toBe(true);
    });

    test("can assign all role types", async () => {
      const roles = ["admin", "network_admin", "it_admin", "auditor", "member"] as const;

      for (const role of roles) {
        const subject = `user-${role}`;

        await db
          .insert(users)
          .values({
            id: ulid(),
            sub: subject,
            caps: Roles[role],
            onboarded: false,
          })
          .onConflictDoUpdate({
            target: users.sub,
            set: { caps: Roles[role] },
          });

        const [user] = await db.select().from(users).where(eq(users.sub, subject));
        expect(user.caps).toBe(Roles[role]);
      }
    });
  });

  describe("member role handling", () => {
    test("member role has zero capabilities", async () => {
      const subject = "member-user";

      await db.insert(users).values({
        id: ulid(),
        sub: subject,
        caps: Roles.member,
        onboarded: false,
      });

      const [user] = await db.select().from(users).where(eq(users.sub, subject));
      expect(user.caps).toBe(0);
    });

    test("upgrading from member to admin grants ui_access", async () => {
      const subject = "upgrading-user";

      // Start as member
      await db.insert(users).values({
        id: ulid(),
        sub: subject,
        caps: Roles.member,
        onboarded: false,
      });

      // Upgrade to admin
      await db
        .insert(users)
        .values({
          id: ulid(),
          sub: subject,
          caps: Roles.admin,
          onboarded: false,
        })
        .onConflictDoUpdate({
          target: users.sub,
          set: { caps: Roles.admin },
        });

      const [user] = await db.select().from(users).where(eq(users.sub, subject));
      expect(user.caps).toBe(Roles.admin);
      expect(user.caps).not.toBe(0);
    });
  });
});
