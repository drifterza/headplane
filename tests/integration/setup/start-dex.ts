import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tc from "testcontainers";

export interface DexEnv {
  container: tc.StartedTestContainer;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

const cwd = fileURLToPath(import.meta.url);
const config = join(cwd, "..", "dex-config.yaml");

export async function startDex(network: tc.StartedNetwork): Promise<DexEnv> {
  const container = await new tc.GenericContainer("dexidp/dex:v2.39.1")
    .withExposedPorts(5556)
    .withNetwork(network)
    .withNetworkAliases("dex")
    .withWaitStrategy(
      tc.Wait.forHttp("/dex/.well-known/openid-configuration", 5556)
        .withStartupTimeout(30_000)
        .forStatusCode(200),
    )
    .withCopyFilesToContainer([
      {
        source: config,
        target: "/etc/dex/config.yaml",
      },
    ])
    .withCommand(["dex", "serve", "/etc/dex/config.yaml"])
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5556);
  const issuerUrl = `http://${host}:${port}/dex`;

  return {
    container,
    issuerUrl,
    clientId: "headplane-test",
    clientSecret: "headplane-test-secret",
  };
}
