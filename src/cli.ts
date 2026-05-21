import { clearLocalState, readConfig, sanitizeConfig, writeConfig } from "./config.js";
import { deliverToCodexInbox } from "./codex-inbox.js";
import { DeliveryCache } from "./dedupe-cache.js";
import { doctor, preflightStartup } from "./doctor.js";
import { githubGet } from "./github-request.js";
import { createWebhookServer, listen } from "./listener.js";
import { parseRouterMode } from "./mode.js";
import { colorize, fail, ok, writeJson } from "./output.js";
import { attachRuntimeCommands } from "./runtime-commands.js";
import { generateWebhookSecret } from "./security.js";
import { SETUP_TITLE, runInteractiveSettings, runInteractiveSetup } from "./setup.js";
import { findExistingNgrokTunnel, startNgrokTunnel } from "./tunnel.js";
import { localWebhookUrl, normalizeWebhookUrl } from "./url.js";
import { deleteGitHubWebhooks, syncGitHubWebhooks } from "./webhooks.js";
import type { RouterOptions } from "./mode.js";
import type { RouterConfig, RuntimeContext } from "./types.js";
import type { SetupSelection } from "./setup.js";
import type { WebhookEvent } from "./listener.js";

interface ParsedArgs {
  options: RouterOptions;
  positionals: string[];
}

function parseArgs(args: string[]): ParsedArgs {
  const options: RouterOptions = { json: false, clear: false, localhost: false, port: 3000 };
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }
    if (arg === "--json") options.json = true;
    else if (arg === "--clear" || arg === "-c") options.clear = true;
    else if (arg === "--localhost") options.localhost = true;
    else if (arg === "--url") {
      const value = args[++index];
      if (!value) throw new Error("--url requires a value");
      options.url = value;
    } else if (arg === "--port") {
      const value = args[++index];
      if (!value) throw new Error("--port requires a value");
      options.port = Number(value);
    }
    else if (arg === "--help" || arg === "-h") options.help = true;
    else positionals.push(arg);
  }
  return { options, positionals };
}

function printHelp(stdout: RuntimeContext["stdout"]): void {
  stdout.write(`codex-github-router\n\n`);
  stdout.write(`Usage:\n`);
  stdout.write(`  codex-github-router [--url <https-url> | --localhost] [--port <port>]\n`);
  stdout.write(`  codex-github-router --clear\n`);
  stdout.write(`  codex-github-router [--json] doctor\n`);
  stdout.write(`  codex-github-router [--json] settings show\n`);
  stdout.write(`  codex-github-router [--json] webhooks reload\n`);
  stdout.write(`  codex-github-router [--json] request get <api-path>\n\n`);
  stdout.write(`Options:\n`);
  stdout.write(`  --json              Emit machine-readable JSON.\n`);
  stdout.write(`  --url <https-url>   Use an existing public webhook URL or base URL.\n`);
  stdout.write(`  --localhost         Start only the local listener and skip GitHub updates.\n`);
  stdout.write(`  --clear, -c         Delete local settings and cache, then exit.\n`);
  stdout.write(`  --port <port>       Local listener port. Defaults to 3000.\n`);
}

async function runStart(options: RouterOptions, context: RuntimeContext): Promise<number> {
  const mode = parseRouterMode(options);
  if (mode.kind === "clear") {
    const existingConfig = await readConfig({ env: context.env });
    if (existingConfig) {
      await deleteGitHubWebhooks({ config: existingConfig });
    }
    await clearLocalState({ env: context.env });
    const result = ok({ cleared: true });
    options.json ? writeJson(context.stdout, result) : context.stdout.write("Cleared local router settings and cache.\n");
    return 0;
  }

  const cache = DeliveryCache.persistent({ env: context.env });
  await cache.load();
  if (!options.json) {
    context.stdout.write(`${SETUP_TITLE}\n`);
  }
  const existingConfig = await readConfig({ env: context.env });
  const envWebhookSecret = context.env.CODEX_GITHUB_ROUTER_WEBHOOK_SECRET;
  const webhookSecret = envWebhookSecret ?? existingConfig?.webhookSecret ?? generateWebhookSecret();
  const firstRunSetup = mode.kind !== "localhost" && (!existingConfig || existingConfig.setupRequired);
  if (mode.kind !== "localhost") {
    await preflightStartup({ env: context.env, requireTunnel: mode.kind === "tunnel" });
  }
  const setupSelection = firstRunSetup && !options.json
    ? await runInteractiveSetup({ context })
    : {
        repositories: existingConfig?.repositories ?? [],
        organizations: existingConfig?.organizations ?? [],
        setupRequired: Boolean(firstRunSetup),
      };
  if (firstRunSetup && !options.json && setupSelection.setupRequired) {
    return 1;
  }
  let activeConfig: RouterConfig | null = existingConfig;
  const onEvent = async ({ event, deliveryId, payload }: WebhookEvent) => {
    const repository = payload.repository;
    const repo =
      repository && typeof repository === "object" && "full_name" in repository && typeof repository.full_name === "string"
        ? repository.full_name
        : "unknown repository";
    if (event === "ping") {
      context.stderr.write(`Received ping delivery ${deliveryId ?? "unknown"} from ${describePingSource(payload)}; webhook is reachable.\n`);
      return;
    }
    const route = resolveRoutingTarget(activeConfig, repo);
    if (route) {
      context.stderr.write(`Received ${event} delivery ${deliveryId ?? "unknown"} for ${repo}; using ${route.kind} settings ${route.name}.\n`);
      try {
        const result = await deliverToCodexInbox({ event, deliveryId, payload, route }, {
          cwd: context.cwd,
          env: context.env,
          appServerLog: (message) => context.stderr.write(`${message}\n`),
        });
        if (result.delivered) {
          const appServer = result.appServerVersion
            ? `${result.appServerBin ?? "unknown"} (${result.appServerVersion})`
            : result.appServerBin ?? "unknown";
          context.stderr.write(`Completed Codex turn ${result.turnId ?? "unknown"} in thread ${result.threadId} for ${event} delivery ${deliveryId ?? "unknown"} using ${appServer}.\n`);
          if (result.agentMessage) {
            context.stderr.write(`Codex response: ${result.agentMessage}\n`);
          }
        } else {
          writeWarning(context, `Could not deliver ${event} delivery ${deliveryId ?? "unknown"} to Codex: ${result.reason ?? "unknown reason"}.`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeWarning(context, `Could not deliver ${event} delivery ${deliveryId ?? "unknown"} to Codex: ${message}`);
      }
      return;
    }
    context.stderr.write(`Received ${event} delivery ${deliveryId ?? "unknown"} for ${repo}; no matching router settings found.\n`);
  };
  let server = createWebhookServer({
    mode: mode.kind,
    secret: webhookSecret,
    deliveryCache: cache,
    onEvent,
  });
  let address = await listen(server, { port: options.port });
  let tunnel: Awaited<ReturnType<typeof startNgrokTunnel>> | undefined;
  let attachedToExistingTunnel = false;

  try {
    let localUrl = localWebhookUrl(address.port);
    let publicWebhookUrl = mode.kind === "url" ? mode.publicWebhookUrl : localUrl;

    if (mode.kind === "localhost") {
      context.stderr.write(colorize("Localhost mode is for local replay only; GitHub.com cannot reach this listener directly.\n", "yellow", { env: context.env, stream: context.stderr }));
    }
    if (mode.kind === "tunnel") {
      try {
        tunnel = await startNgrokTunnel({ port: address.port, stderr: context.stderr, env: context.env });
        publicWebhookUrl = normalizeWebhookUrl(tunnel.publicUrl);
      } catch (error) {
        if (!isNgrokEndpointConflict(error)) {
          throw error;
        }
        const existingTunnel = await findExistingNgrokTunnel();
        if (!existingTunnel) {
          throw error;
        }
        if (existingTunnel.localPort !== address.port) {
          server.close();
          server = createWebhookServer({
            mode: mode.kind,
            secret: webhookSecret,
            deliveryCache: cache,
            onEvent,
          });
          try {
            address = await listen(server, { port: existingTunnel.localPort });
          } catch {
            throw new Error(`ngrok endpoint is already online for local port ${existingTunnel.localPort}, but that port is already used by another process. Stop that process, stop ngrok, use --localhost, or pass --url <https-url>.`);
          }
          localUrl = localWebhookUrl(address.port);
        }
        publicWebhookUrl = normalizeWebhookUrl(existingTunnel.publicUrl);
        attachedToExistingTunnel = true;
      }
    }
    const nextConfig: RouterConfig = {
      version: 1,
      mode: mode.kind,
      localWebhookUrl: localUrl,
      publicWebhookUrl,
      setupRequired: setupSelection.setupRequired,
      attachedToExistingTunnel,
      repositories: setupSelection.repositories,
      organizations: setupSelection.organizations,
      hasStoredSecrets: !envWebhookSecret,
    };
    if (!envWebhookSecret) {
      nextConfig.webhookSecret = webhookSecret;
    }
    if (mode.kind !== "localhost" && !setupSelection.setupRequired) {
      await syncGitHubWebhooks({ config: nextConfig, publicWebhookUrl, env: context.env });
    }
    await writeConfig(nextConfig, { env: context.env });
    activeConfig = nextConfig;
    context.stdout.write(`${colorize("codex-github-router ready", "green", { env: context.env, stream: context.stdout })}\n`);
    context.stdout.write(`${colorize("local", "dim", { env: context.env, stream: context.stdout })}  ${localUrl}\n`);
    context.stdout.write(`${colorize("public", "dim", { env: context.env, stream: context.stdout })} ${publicWebhookUrl}\n`);
    for (const hookUrl of hookSettingsUrls(nextConfig)) {
      context.stdout.write(`${colorize("hook", "dim", { env: context.env, stream: context.stdout })}   ${hookUrl}\n`);
    }
    if (attachedToExistingTunnel) {
      context.stdout.write(`${colorize("tunnel", "dim", { env: context.env, stream: context.stdout })} attached to existing ngrok tunnel\n`);
    }
  } catch (error) {
    tunnel?.process?.kill();
    server.close();
    throw error;
  }

  const close = async (): Promise<void> => {
    tunnel?.process?.kill();
    await closeServer(server);
  };
  const runtimeCommands = attachRuntimeCommands({
    stdin: context.stdin,
    stdout: context.stdout,
    onReload: async () => {
      const config = await readConfig({ env: context.env });
      if (!config?.publicWebhookUrl) {
        context.stdout.write("No public webhook URL is configured yet.\n");
        return;
      }
      const result = await syncGitHubWebhooks({ config, publicWebhookUrl: config.publicWebhookUrl, env: context.env, createMissing: false });
      await writeConfig(config, { env: context.env });
      context.stdout.write(`Reloaded webhooks: ${result.organizations.length} organizations, ${result.repositories.length} repositories.\n`);
      for (const warning of result.warnings) {
        context.stdout.write(`${colorize("warning", "yellow", { env: context.env, stream: context.stdout })} ${warning.message}\n`);
      }
    },
    onSettings: async () => {
      const config = await readConfig({ env: context.env });
      const selection = configToSetupSelection(config);
      if (!config || !selection) {
        context.stdout.write("No router settings found. Setup has not completed yet.\n");
        return;
      }
      const updatedSelection = await runInteractiveSettings({ context, selection });
      if (!updatedSelection) {
        return;
      }
      const nextConfig = {
        ...config,
        repositories: updatedSelection.repositories,
        organizations: updatedSelection.organizations,
        setupRequired: updatedSelection.setupRequired,
      };
      if (nextConfig.publicWebhookUrl && nextConfig.mode !== "localhost") {
        await syncGitHubWebhooks({ config: nextConfig, publicWebhookUrl: nextConfig.publicWebhookUrl, env: context.env });
      }
      await writeConfig(nextConfig, { env: context.env });
      activeConfig = nextConfig;
    },
    onQuit: close,
  });
  server.once("close", () => runtimeCommands.close());

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await new Promise<void>((resolve) => server.once("close", resolve));
  return 0;
}

function configToSetupSelection(config: RouterConfig | null): SetupSelection | null {
  if (!config) {
    return null;
  }
  return {
    repositories: (config.repositories ?? []).flatMap((target) => {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        return [];
      }
      const record = target as Record<string, unknown>;
      if (typeof record.fullName !== "string") {
        return [];
      }
      return [{
        fullName: record.fullName,
        enabled: typeof record.enabled === "boolean" ? record.enabled : true,
        issueAutomationEnabled: typeof record.issueAutomationEnabled === "boolean" ? record.issueAutomationEnabled : false,
        issueAutomationLabel: typeof record.issueAutomationLabel === "string" ? record.issueAutomationLabel : "ready-for-agent",
        issueAutomationPrompt: typeof record.issueAutomationPrompt === "string"
          ? record.issueAutomationPrompt
          : "Develop this issue using TDD, open a pull request, and report verification steps.",
      }];
    }),
    organizations: (config.organizations ?? []).flatMap((target) => {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        return [];
      }
      const record = target as Record<string, unknown>;
      if (typeof record.login !== "string") {
        return [];
      }
      return [{
        login: record.login,
        enabled: typeof record.enabled === "boolean" ? record.enabled : true,
        issueAutomationEnabled: typeof record.issueAutomationEnabled === "boolean" ? record.issueAutomationEnabled : false,
        issueAutomationLabel: typeof record.issueAutomationLabel === "string" ? record.issueAutomationLabel : "ready-for-agent",
        issueAutomationPrompt: typeof record.issueAutomationPrompt === "string"
          ? record.issueAutomationPrompt
          : "Develop this issue using TDD, open a pull request, and report verification steps.",
      }];
    }),
    setupRequired: Boolean(config.setupRequired),
  };
}

function closeServer(server: ReturnType<typeof createWebhookServer>): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function hookSettingsUrls(config: RouterConfig): string[] {
  return [
    ...(config.organizations ?? []).flatMap((target) => {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        return [];
      }
      const record = target as Record<string, unknown>;
      if (typeof record.login !== "string" || !isHookId(record.hookId)) {
        return [];
      }
      return [`https://github.com/organizations/${record.login}/settings/hooks/${record.hookId}`];
    }),
    ...(config.repositories ?? []).flatMap((target) => {
      if (!target || typeof target !== "object" || Array.isArray(target)) {
        return [];
      }
      const record = target as Record<string, unknown>;
      if (typeof record.fullName !== "string" || !isHookId(record.hookId)) {
        return [];
      }
      return [`https://github.com/${record.fullName}/settings/hooks/${record.hookId}`];
    }),
  ];
}

export function describePingSource(payload: Record<string, unknown>): string {
  const repository = objectField(payload, "repository");
  const repositoryName = stringField(repository, "full_name");
  if (repositoryName) {
    return `repository webhook ${repositoryName}`;
  }

  const organization = objectField(payload, "organization");
  const organizationLogin = stringField(organization, "login");
  if (organizationLogin) {
    return `organization webhook ${organizationLogin}`;
  }

  const hook = objectField(payload, "hook");
  const hookType = stringField(hook, "type");
  if (hookType) {
    return `${hookType} webhook`;
  }

  return "GitHub webhook";
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const field = value[key];
  return field && typeof field === "object" && !Array.isArray(field) ? field as Record<string, unknown> : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

export function resolveRoutingTarget(config: RouterConfig | null, fullName: string): { kind: "repository" | "organization"; name: string } | null {
  if (!config || fullName === "unknown repository") {
    return null;
  }
  const repository = (config.repositories ?? []).find((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return false;
    }
    const record = target as Record<string, unknown>;
    return record.fullName === fullName && hasActiveRouting(record);
  });
  if (repository && typeof (repository as Record<string, unknown>).fullName === "string") {
    return { kind: "repository", name: (repository as Record<string, unknown>).fullName as string };
  }

  const [owner] = fullName.split("/");
  if (!owner) {
    return null;
  }
  const organization = (config.organizations ?? []).find((target) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return false;
    }
    const record = target as Record<string, unknown>;
    return record.login === owner && hasActiveRouting(record);
  });
  if (organization && typeof (organization as Record<string, unknown>).login === "string") {
    return { kind: "organization", name: (organization as Record<string, unknown>).login as string };
  }
  return null;
}

function hasActiveRouting(record: Record<string, unknown>): boolean {
  return record.enabled === true;
}

function isHookId(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

export function writeWarning(context: Pick<RuntimeContext, "env" | "stderr">, message: string): void {
  context.stderr.write(`${colorize("warning", "yellow", { env: context.env, stream: context.stderr })} ${message}\n`);
}

function isNgrokEndpointConflict(error: unknown): boolean {
  return error instanceof Error && error.message.includes("ngrok endpoint is already online");
}

export async function runCli(args: string[], context: RuntimeContext): Promise<number> {
  const { options, positionals } = parseArgs(args);

  try {
    if (options.help) {
      printHelp(context.stdout);
      return 0;
    }

    const [command, subcommand, value] = positionals;
    if (command === "doctor") {
      writeJson(context.stdout, await doctor({ env: context.env }));
      return 0;
    }
    if (command === "settings" && subcommand === "show") {
      const config = await readConfig({ env: context.env });
      const result = ok({ settings: sanitizeConfig(config) });
      options.json ? writeJson(context.stdout, result) : context.stdout.write(`${JSON.stringify(sanitizeConfig(config), null, 2)}\n`);
      return 0;
    }
    if (command === "webhooks" && subcommand === "reload") {
      const config = await readConfig({ env: context.env });
      if (!config) {
        writeJson(context.stdout, fail("config_missing", "Run the router once to create settings before reloading webhooks."));
        return 1;
      }
      if (!config.publicWebhookUrl) {
        writeJson(context.stdout, fail("public_url_missing", "Run the router once with a public URL before reloading webhooks."));
        return 1;
      }
      const result = await syncGitHubWebhooks({ config, publicWebhookUrl: config.publicWebhookUrl, env: context.env, createMissing: false });
      await writeConfig(config, { env: context.env });
      writeJson(context.stdout, ok({ reloaded: true, ...result }));
      return 0;
    }
    if (command === "request" && subcommand === "get") {
      writeJson(context.stdout, ok({ response: await githubGet(value) }));
      return 0;
    }
    if (positionals.length > 0) {
      throw new Error(`Unknown command: ${positionals.join(" ")}`);
    }

    return await runStart(options, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) {
      writeJson(context.stdout, fail("command_failed", message));
    } else {
      context.stderr.write(`${message}\n`);
    }
    return 1;
  }
}

export { parseArgs };
