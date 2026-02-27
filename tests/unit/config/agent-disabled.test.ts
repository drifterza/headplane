import { dump } from "js-yaml";
import { beforeAll, describe, expect, test } from "vitest";

import { ConfigError } from "~/server/config/error";
import { loadConfig } from "~/server/config/load";

import { clearFakeFiles, createFakeFile } from "../setup/overlay-fs";

const writeYaml = (filePath: string, content: unknown) => {
  const yamlContent = dump(content);
  createFakeFile(filePath, yamlContent);
};

describe("Agent config when disabled", () => {
  beforeAll(() => {
    clearFakeFiles();
  });

  test("should not require pre_authkey when agent is disabled", async () => {
    const filePath = "/config/agent-disabled.yaml";
    writeYaml(filePath, {
      headscale: {
        url: "http://localhost:8080",
      },
      server: {
        cookie_secret: "thirtytwo-character-cookiesecret",
      },
      integration: {
        agent: {
          enabled: false,
        },
      },
    });

    const config = await loadConfig(filePath);
    expect(config.integration?.agent?.enabled).toBe(false);
    expect(config.integration?.agent?.pre_authkey).toBeUndefined();
  });

  test("should require pre_authkey when agent is enabled", async () => {
    const filePath = "/config/agent-enabled-no-key.yaml";
    writeYaml(filePath, {
      headscale: {
        url: "http://localhost:8080",
      },
      server: {
        cookie_secret: "thirtytwo-character-cookiesecret",
      },
      integration: {
        agent: {
          enabled: true,
        },
      },
    });

    await expect(loadConfig(filePath)).rejects.toEqual(
      expect.objectContaining(ConfigError.from("INVALID_REQUIRED_FIELDS", { messages: [] })),
    );
  });

  test("should accept agent config when enabled with pre_authkey", async () => {
    const filePath = "/config/agent-enabled-with-key.yaml";
    writeYaml(filePath, {
      headscale: {
        url: "http://localhost:8080",
      },
      server: {
        cookie_secret: "thirtytwo-character-cookiesecret",
      },
      integration: {
        agent: {
          enabled: true,
          pre_authkey: "my-pre-auth-key",
        },
      },
    });

    const config = await loadConfig(filePath);
    expect(config.integration?.agent?.enabled).toBe(true);
    expect(config.integration?.agent?.pre_authkey).toBe("my-pre-auth-key");
  });

  test("should work without agent config at all", async () => {
    const filePath = "/config/no-agent.yaml";
    writeYaml(filePath, {
      headscale: {
        url: "http://localhost:8080",
      },
      server: {
        cookie_secret: "thirtytwo-character-cookiesecret",
      },
    });

    const config = await loadConfig(filePath);
    expect(config.integration?.agent).toBeUndefined();
  });
});
