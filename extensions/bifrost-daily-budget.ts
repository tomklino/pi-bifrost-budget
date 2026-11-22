import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "bifrost-daily-budget";
const REFRESH_INTERVAL_MS = 60_000;
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

type JsonObject = Record<string, unknown>;

type Budget = {
	max_limit?: number;
	current_usage?: number;
	reset_duration?: string;
	override_amount?: number;
};

async function readJson(path: string): Promise<JsonObject> {
	return JSON.parse(await readFile(path, "utf8")) as JsonObject;
}

function asObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonObject)
		: undefined;
}

/** Resolve the same $ENV header reference Pi uses, including values stored in auth.json. */
async function getBifrostConnection(providerName: string): Promise<{
	quotaUrl: URL;
	virtualKey: string;
} | undefined> {
	const [modelsFile, authFile] = await Promise.all([
		readJson(join(PI_AGENT_DIR, "models.json")),
		readJson(join(PI_AGENT_DIR, "auth.json")),
	]);

	const providers = asObject(modelsFile.providers);
	const provider = asObject(providers?.[providerName]);
	const baseUrl = provider?.baseUrl;
	if (typeof baseUrl !== "string") return undefined;

	const headers = asObject(provider.headers);
	const virtualKeyHeader = Object.entries(headers ?? {}).find(
		([name]) => name.toLowerCase() === "x-bf-vk",
	);
	if (!virtualKeyHeader || typeof virtualKeyHeader[1] !== "string") return undefined;

	const auth = asObject(authFile[providerName]);
	const authEnv = asObject(auth?.env);
	const configuredValue = virtualKeyHeader[1];
	let virtualKey = configuredValue;
	if (configuredValue.startsWith("$") && configuredValue.length > 1) {
		const variable = configuredValue.slice(1);
		const storedValue = authEnv?.[variable];
		virtualKey = process.env[variable]
			?? (typeof storedValue === "string" ? storedValue : undefined)
			?? (typeof auth?.key === "string" ? auth.key : undefined)
			?? "";
	}
	if (!virtualKey) return undefined;

	const quotaUrl = new URL(baseUrl);
	quotaUrl.pathname = "/api/governance/virtual-keys/quota";
	quotaUrl.search = "";
	quotaUrl.hash = "";
	return { quotaUrl, virtualKey };
}

async function fetchDailyBudget(providerName: string): Promise<Budget | undefined> {
	const connection = await getBifrostConnection(providerName);
	if (!connection) return undefined;

	const response = await fetch(connection.quotaUrl, {
		headers: { "x-bf-vk": connection.virtualKey },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`Bifrost quota request returned HTTP ${response.status}`);
	}

	const body = asObject(await response.json());
	const budgets = Array.isArray(body?.budgets) ? (body.budgets as Budget[]) : [];
	return budgets.find(
		(budget) => budget.reset_duration?.toLowerCase() === "1d"
			&& Number.isFinite(budget.current_usage)
			&& Number.isFinite(budget.max_limit),
	);
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshGeneration = 0;
	let activeContext: ExtensionContext | undefined;

	const refresh = async (ctx: ExtensionContext, reportError = false) => {
		const generation = ++refreshGeneration;
		const provider = ctx.model?.provider;
		if (!provider) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		try {
			const budget = await fetchDailyBudget(provider);
			if (generation !== refreshGeneration) return;
			if (!budget) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
				return;
			}

			const used = budget.current_usage!;
			const total = budget.max_limit! + (budget.override_amount ?? 0);
			ctx.ui.setStatus(STATUS_KEY, `${used.toFixed(2)}$/${total.toFixed(2)}$`);
		} catch (error) {
			if (generation !== refreshGeneration) return;
			ctx.ui.setStatus(STATUS_KEY, undefined);
			if (reportError && ctx.hasUI) {
				ctx.ui.notify(
					`Could not read Bifrost daily budget: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		activeContext = ctx;
		await refresh(ctx);
		timer = setInterval(() => void refresh(ctx), REFRESH_INTERVAL_MS);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (ctx.mode === "tui") await refresh(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.mode === "tui") await refresh(ctx);
	});

	pi.registerCommand("bifrost-budget", {
		description: "Refresh the Bifrost daily budget status",
		handler: async (_args, ctx) => {
			await refresh(ctx, true);
		},
	});

	pi.on("session_shutdown", async () => {
		refreshGeneration++;
		if (timer) clearInterval(timer);
		timer = undefined;
		activeContext?.ui.setStatus(STATUS_KEY, undefined);
		activeContext = undefined;
	});
}
