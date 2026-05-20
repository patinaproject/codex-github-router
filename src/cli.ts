import { clearLocalState, readConfig, sanitizeConfig } from "./config.js";
import { DeliveryCache } from "./dedupe-cache.js";
import { doctor } from "./doctor.js";
import { githubGet } from "./github-request.js";
import { createWebhookServer, listen } from "./listener.js";
import { parseRouterMode } from "./mode.js";
import { colorize, fail, ok, writeJson } from "./output.js";
import { attachRuntimeCommands } from "./runtime-commands.js";
import { findExistingNgrokTunnel, startNgrokTunnel } from "./tunnel.js";
import { localWebhookUrl, normalizeWebhookUrl } from "./url.js";
import type { RouterOptions } from "./mode.js";
import type { RuntimeContext } from "./types.js";

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
    await clearLocalState({ env: context.env });
    const result = ok({ cleared: true });
    options.json ? writeJson(context.stdout, result) : context.stdout.write("Cleared local router settings and cache.\n");
    return 0;
  }

  const cache = DeliveryCache.persistent({ env: context.env });
  await cache.load();
  let server = createWebhookServer({
    mode: mode.kind,
    secret: context.env.CODEX_GITHUB_ROUTER_WEBHOOK_SECRET,
    deliveryCache: cache,
    onEvent: ({ event, deliveryId, payload }) => {
      const repository = payload.repository;
      const repo =
        repository && typeof repository === "object" && "full_name" in repository && typeof repository.full_name === "string"
          ? repository.full_name
          : "unknown repository";
      context.stderr.write(`Received ${event} delivery ${deliveryId ?? "unknown"} for ${repo}; routing is pending configuration.\n`);
    },
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
            secret: context.env.CODEX_GITHUB_ROUTER_WEBHOOK_SECRET,
            deliveryCache: cache,
            onEvent: ({ event, deliveryId, payload }) => {
              const repository = payload.repository;
              const repo =
                repository && typeof repository === "object" && "full_name" in repository && typeof repository.full_name === "string"
                  ? repository.full_name
                  : "unknown repository";
              context.stderr.write(`Received ${event} delivery ${deliveryId ?? "unknown"} for ${repo}; routing is pending configuration.\n`);
            },
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
    context.stdout.write(`${colorize("codex-github-router ready", "green", { env: context.env, stream: context.stdout })}\n`);
    context.stdout.write(`local listener: ${localUrl}\n`);
    context.stdout.write(`public webhook URL: ${publicWebhookUrl}\n`);
    if (attachedToExistingTunnel) {
      context.stdout.write("attached to existing ngrok tunnel\n");
    }
    context.stdout.write("Press Ctrl-C to quit.\n");
  } catch (error) {
    tunnel?.process?.kill();
    server.close();
    throw error;
  }

  const close = async (): Promise<void> => {
    tunnel?.process?.kill();
    server.close();
  };
  const runtimeCommands = attachRuntimeCommands({
    stdin: context.stdin,
    stdout: context.stdout,
    onReload: async () => {
      context.stdout.write("Reload webhooks is not configured until setup stores hook IDs.\n");
    },
    onSettings: async () => {
      const config = await readConfig({ env: context.env });
      context.stdout.write(`${JSON.stringify(sanitizeConfig(config), null, 2)}\n`);
    },
    onQuit: close,
  });
  server.once("close", () => runtimeCommands.close());

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await new Promise<void>((resolve) => server.once("close", resolve));
  return 0;
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
      writeJson(context.stdout, ok({ reloaded: false, warnings: ["webhook reload requires stored hook IDs and secure credentials"] }));
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
