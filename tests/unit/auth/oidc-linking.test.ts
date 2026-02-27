import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { ulid } from "ulidx";
import { beforeEach, describe, expect, test } from "vitest";

import { users } from "~/server/db/schema";
import { Roles } from "~/server/web/roles";

function createTestDb() {
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client);
  return { client, db };
}

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

// Extract subject from providerId (matches the logic in oidc-callback.ts)
function extractSubject(providerId: string | undefined): string | undefined {
  return providerId?.split("/").pop();
}

describe("OIDC to Headscale user linking", () => {
  let db: ReturnType<typeof drizzle>;
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    const testDb = createTestDb();
    db = testDb.db;
    client = testDb.client;
    await setupSchema(client);
  });

  describe("providerId subject extraction", () => {
    test("extracts subject from standard oidc format", () => {
      expect(extractSubject("oidc/abc123")).toBe("abc123");
    });

    test("extracts subject from nested path", () => {
      expect(extractSubject("provider/tenant/user-456")).toBe("user-456");
    });

    test("returns full value when no slash", () => {
      expect(extractSubject("plain-subject")).toBe("plain-subject");
    });

    test("returns undefined for undefined input", () => {
      expect(extractSubject(undefined)).toBeUndefined();
    });

    test("handles empty string", () => {
      expect(extractSubject("")).toBe("");
    });

    test("handles trailing slash", () => {
      expect(extractSubject("oidc/")).toBe("");
    });
  });

  describe("headscale_user_id storage", () => {
    test("stores headscale_user_id on new user creation", async () => {
      const subject = "oidc-subject-123";
      const headscaleUserId = "hs-user-456";

      await db.insert(users).values({
        id: ulid(),
        sub: subject,
        caps: Roles.member,
        headscale_user_id: headscaleUserId,
      });

      const [user] = await db.select().from(users).where(eq(users.sub, subject));
      expect(user.headscale_user_id).toBe(headscaleUserId);
    });

    test("creates user without headscale_user_id when no match", async () => {
      const subject = "unlinked-subject";

      await db.insert(users).values({
        id: ulid(),
        sub: subject,
        caps: Roles.member,
        headscale_user_id: undefined,
      });

      const [user] = await db.select().from(users).where(eq(users.sub, subject));
      expect(user.headscale_user_id).toBeNull();
    });

    test("updates existing user with headscale_user_id", async () => {
      const subject = "existing-user";
      const headscaleUserId = "hs-newly-linked";

      // Create user without link
      await db.insert(users).values({
        id: ulid(),
        sub: subject,
        caps: Roles.member,
        headscale_user_id: undefined,
      });

      // Later login finds a match
      await db
        .update(users)
        .set({ headscale_user_id: headscaleUserId })
        .where(eq(users.sub, subject));

      const [user] = await db.select().from(users).where(eq(users.sub, subject));
      expect(user.headscale_user_id).toBe(headscaleUserId);
    });

    test("preserves existing link on subsequent logins", async () => {
      const subject = "stable-user";
      const headscaleUserId = "hs-stable-link";

      await db.insert(users).values({
        id: ulid(),
        sub: subject,
        caps: Roles.member,
        headscale_user_id: headscaleUserId,
      });

      // Simulate insert with onConflictDoNothing (login flow)
      await db
        .insert(users)
        .values({
          id: ulid(),
          sub: subject,
          caps: Roles.member,
          headscale_user_id: headscaleUserId,
        })
        .onConflictDoNothing();

      const [user] = await db.select().from(users).where(eq(users.sub, subject));
      expect(user.headscale_user_id).toBe(headscaleUserId);
    });
  });

  describe("user matching simulation", () => {
    interface MockHeadscaleUser {
      id: string;
      name: string;
      providerId?: string;
    }

    function findMatchingUser(
      hsUsers: MockHeadscaleUser[],
      oidcSubject: string,
    ): MockHeadscaleUser | undefined {
      return hsUsers.find((u) => {
        const userSubject = extractSubject(u.providerId);
        return userSubject === oidcSubject;
      });
    }

    test("matches user by providerId subject", () => {
      const hsUsers: MockHeadscaleUser[] = [
        { id: "1", name: "alice", providerId: "oidc/alice-sub" },
        { id: "2", name: "bob", providerId: "oidc/bob-sub" },
        { id: "3", name: "charlie" }, // no providerId
      ];

      const match = findMatchingUser(hsUsers, "bob-sub");
      expect(match?.id).toBe("2");
      expect(match?.name).toBe("bob");
    });

    test("returns undefined when no match", () => {
      const hsUsers: MockHeadscaleUser[] = [
        { id: "1", name: "alice", providerId: "oidc/alice-sub" },
      ];

      const match = findMatchingUser(hsUsers, "unknown-sub");
      expect(match).toBeUndefined();
    });

    test("handles users without providerId", () => {
      const hsUsers: MockHeadscaleUser[] = [
        { id: "1", name: "local-user" },
        { id: "2", name: "another-local" },
      ];

      const match = findMatchingUser(hsUsers, "any-subject");
      expect(match).toBeUndefined();
    });

    test("matches first user when multiple have same subject", () => {
      const hsUsers: MockHeadscaleUser[] = [
        { id: "1", name: "first", providerId: "oidc/dupe-sub" },
        { id: "2", name: "second", providerId: "oidc/dupe-sub" },
      ];

      const match = findMatchingUser(hsUsers, "dupe-sub");
      expect(match?.id).toBe("1");
    });

    test("handles empty user list", () => {
      const match = findMatchingUser([], "any-subject");
      expect(match).toBeUndefined();
    });
  });

  describe("full login flow simulation", () => {
    interface MockHeadscaleUser {
      id: string;
      name: string;
      providerId?: string;
    }

    async function simulateOidcLogin(
      db: ReturnType<typeof drizzle>,
      oidcSubject: string,
      hsUsers: MockHeadscaleUser[],
      integrateHeadscale: boolean,
    ) {
      let headscaleUserId: string | undefined;

      if (integrateHeadscale) {
        const match = hsUsers.find((u) => {
          const userSubject = u.providerId?.split("/").pop();
          return userSubject === oidcSubject;
        });
        headscaleUserId = match?.id;
      }

      await db
        .insert(users)
        .values({
          id: ulid(),
          sub: oidcSubject,
          caps: Roles.member,
          headscale_user_id: headscaleUserId,
        })
        .onConflictDoNothing();

      if (headscaleUserId) {
        await db
          .update(users)
          .set({ headscale_user_id: headscaleUserId })
          .where(eq(users.sub, oidcSubject));
      }

      return headscaleUserId;
    }

    test("links user when integrate_headscale enabled and match found", async () => {
      const hsUsers: MockHeadscaleUser[] = [
        { id: "hs-123", name: "alice", providerId: "oidc/alice-oidc" },
      ];

      const linkedId = await simulateOidcLogin(db, "alice-oidc", hsUsers, true);
      expect(linkedId).toBe("hs-123");

      const [user] = await db.select().from(users).where(eq(users.sub, "alice-oidc"));
      expect(user.headscale_user_id).toBe("hs-123");
    });

    test("creates user without link when integrate_headscale disabled", async () => {
      const hsUsers: MockHeadscaleUser[] = [
        { id: "hs-123", name: "alice", providerId: "oidc/alice-oidc" },
      ];

      const linkedId = await simulateOidcLogin(db, "alice-oidc", hsUsers, false);
      expect(linkedId).toBeUndefined();

      const [user] = await db.select().from(users).where(eq(users.sub, "alice-oidc"));
      expect(user.headscale_user_id).toBeNull();
    });

    test("creates user without link when no matching providerId", async () => {
      const hsUsers: MockHeadscaleUser[] = [
        { id: "hs-456", name: "bob", providerId: "oidc/bob-oidc" },
      ];

      const linkedId = await simulateOidcLogin(db, "charlie-oidc", hsUsers, true);
      expect(linkedId).toBeUndefined();

      const [user] = await db.select().from(users).where(eq(users.sub, "charlie-oidc"));
      expect(user.headscale_user_id).toBeNull();
    });

    test("updates link on returning user login", async () => {
      // First login without link
      await db.insert(users).values({
        id: ulid(),
        sub: "returning-user",
        caps: Roles.member,
        headscale_user_id: undefined,
      });

      // Headscale user created after initial login
      const hsUsers: MockHeadscaleUser[] = [
        { id: "hs-789", name: "returning", providerId: "oidc/returning-user" },
      ];

      await simulateOidcLogin(db, "returning-user", hsUsers, true);

      const [user] = await db.select().from(users).where(eq(users.sub, "returning-user"));
      expect(user.headscale_user_id).toBe("hs-789");
    });
  });
});
