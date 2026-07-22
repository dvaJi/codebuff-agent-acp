/**
 * Local configuration storage for codebuff-agent-acp.
 *
 * Holds the Codebuff API key collected by the `--setup` (Terminal Auth) flow at
 * `<configHome>/config.json`, with restrictive permissions on platforms that
 * honor them. The env var `CODEBUFF_API_KEY` always takes precedence.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CodebuffAcpConfig {
  apiKey?: string;
}

/** Root directory for codebuff-agent-acp state (config + sessions). */
export function configHome(): string {
  return (
    process.env.CODEBUFF_ACP_HOME ?? path.join(os.homedir(), ".codebuff-acp")
  );
}

function configPath(): string {
  return path.join(configHome(), "config.json");
}

export async function loadConfig(): Promise<CodebuffAcpConfig> {
  try {
    const raw = await fs.readFile(configPath(), "utf8");
    return JSON.parse(raw) as CodebuffAcpConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

export async function saveConfig(config: CodebuffAcpConfig): Promise<void> {
  await fs.mkdir(configHome(), { recursive: true });
  // Restrictive permissions — this file holds the API key. (No-op on Windows.)
  await fs.writeFile(configPath(), JSON.stringify(config, null, 2), {
    mode: 0o600,
  });
}
