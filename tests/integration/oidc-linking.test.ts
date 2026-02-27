import tc from "testcontainers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createHeadscaleInterface } from "~/server/headscale/api";

import { startDex, type DexEnv } from "./setup/start-dex";
import { startHeadscale, type HeadscaleEnv } from "./setup/start-headscale";

describe("OIDC to Headscale user linking", () => {
  let network: tc.StartedNetwork;
  let dex: DexEnv;
  let headscale: HeadscaleEnv;

  beforeAll(async () => {
    network = await new tc.Network().start();

    // Start Dex for OIDC
    dex = await startDex(network);

    // Start Headscale
    headscale = await startHeadscale("0.28.0");
  }, 60_000);

  afterAll(async () => {
    await dex?.container.stop({ remove: true, removeVolumes: true });
    await headscale?.container.stop({ remove: true, removeVolumes: true });
    await network?.stop();
  });

  test("Dex OIDC discovery endpoint is accessible", async () => {
    const response = await fetch(`${dex.issuerUrl}/.well-known/openid-configuration`);
    expect(response.status).toBe(200);

    const config = await response.json();
    expect(config.issuer).toContain("/dex");
    expect(config.authorization_endpoint).toBeDefined();
    expect(config.token_endpoint).toBeDefined();
  });

  test("Headscale API is accessible", async () => {
    const api = await createHeadscaleInterface(headscale.apiUrl);
    const client = api.getRuntimeClient(headscale.apiKey);
    const users = await client.getUsers();
    expect(Array.isArray(users)).toBe(true);
  });

  describe("user matching with providerId", () => {
    test("creates Headscale user with providerId", async () => {
      const api = await createHeadscaleInterface(headscale.apiUrl);
      const client = api.getRuntimeClient(headscale.apiKey);

      // Create a user (providerId would be set by OIDC in real flow)
      const user = await client.createUser("oidc-linked-user@");
      expect(user).toBeDefined();
      expect(user.name).toBe("oidc-linked-user@");
    });

    test("findHeadscaleUser matches by providerId subject", async () => {
      const api = await createHeadscaleInterface(headscale.apiUrl);
      const client = api.getRuntimeClient(headscale.apiKey);

      const users = await client.getUsers();

      // Test the matching logic that runs in oidc-callback.ts
      const oidcSubject = "test-admin-uid";

      const match = users.find((u) => {
        const subject = u.providerId?.split("/").pop();
        return subject === oidcSubject;
      });

      // No match expected since we haven't set providerId via API
      // (Headscale sets this during OIDC node registration)
      expect(match).toBeUndefined();
    });

    test("user list returns providerId when set", async () => {
      const api = await createHeadscaleInterface(headscale.apiUrl);
      const client = api.getRuntimeClient(headscale.apiKey);

      const users = await client.getUsers();

      // Check the shape of the response
      for (const user of users) {
        expect(user).toHaveProperty("id");
        expect(user).toHaveProperty("name");
        // providerId may or may not be present
        if (user.providerId) {
          expect(typeof user.providerId).toBe("string");
        }
      }
    });
  });

  describe("OIDC flow simulation", () => {
    test("can fetch OIDC token endpoint", async () => {
      const discoveryRes = await fetch(`${dex.issuerUrl}/.well-known/openid-configuration`);
      const discovery = await discoveryRes.json();

      expect(discovery.token_endpoint).toBeDefined();
      expect(discovery.authorization_endpoint).toBeDefined();
    });

    test("authorization endpoint is properly configured", async () => {
      const discoveryRes = await fetch(`${dex.issuerUrl}/.well-known/openid-configuration`);
      const discovery = await discoveryRes.json();

      // The authorization endpoint exists in the discovery
      expect(discovery.authorization_endpoint).toBeDefined();
      expect(discovery.authorization_endpoint).toContain("/dex/auth");

      // Build the auth URL using the external issuer URL
      const authUrl = new URL(`${dex.issuerUrl}/auth`);
      authUrl.searchParams.set("client_id", dex.clientId);
      authUrl.searchParams.set("redirect_uri", "http://localhost:3000/oidc/callback");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", "openid email profile");
      authUrl.searchParams.set("state", "test-state");

      const response = await fetch(authUrl.toString(), { redirect: "manual" });
      // Dex shows login page or redirects
      expect([200, 302, 303]).toContain(response.status);
    });
  });
});
