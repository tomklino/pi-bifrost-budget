import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "bifrost-daily-budget";
const REFRESH_INTERVAL_MS = 60_000;
const QUOTA_PATH = "/api/governance/virtual-keys/quota";

class BudgetError extends Error {}

function isBifrostProvider(provider: string | undefined): boolean {
	return /^bifrost(?:[-_.]|$)/i.test(provider ?? "");
}

async function readDailyBudget(ctx: ExtensionContext): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) return;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		if (isBifrostProvider(model.provider)) throw new BudgetError("could not resolve the virtual key");
		return;
	}

	// Use Pi's resolved request credentials, not a second interpretation of models.json/auth.json.
	const headers = new Headers();
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
	const vkHeader = headers.get("x-bf-vk");
	const authorization = headers.get("authorization");
	const bearer = authorization === null ? auth.apiKey : /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
	const virtualKey = vkHeader || (bearer?.startsWith("sk-bf-") ? bearer : undefined);
	if (!virtualKey) {
		if (isBifrostProvider(model.provider)) throw new BudgetError("no virtual key configured");
		return;
	}

	const url = new URL(QUOTA_PATH, auth.baseUrl ?? model.baseUrl);
	if (url.protocol !== "https:") throw new BudgetError("quota endpoint must use HTTPS");
	const response = await fetch(url, {
		headers: { "X-Bf-Vk": virtualKey },
		redirect: "error",
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new BudgetError(`quota request returned HTTP ${response.status}`);

	const body = await response.json() as { budgets?: unknown } | null;
	if (Array.isArray(body?.budgets)) {
		for (const budget of body.budgets) {
			if (typeof budget?.reset_duration !== "string" || budget.reset_duration.toLowerCase() !== "1d") continue;
			const { current_usage: used, max_limit: limit, override_amount: override } = budget;
			if (!Number.isFinite(used) || !Number.isFinite(limit) || (override != null && !Number.isFinite(override))) continue;
			const total = limit + (override ?? 0);
			if (Number.isFinite(total)) return `${used.toFixed(2)}$/${total.toFixed(2)}$`;
		}
	}
	throw new BudgetError("quota response contains no valid daily budget");
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;

	const refresh = async (ctx: ExtensionContext, manual = false) => {
		const request = ++generation;
		try {
			const budget = await readDailyBudget(ctx);
			if (request !== generation) return;
			ctx.ui.setStatus(STATUS_KEY, budget ? ctx.ui.theme.fg("dim", `Bifrost ${budget}`) : undefined);
			if (!budget && manual) ctx.ui.notify("The active model is not using a Bifrost virtual key.", "info");
		} catch (error) {
			if (request !== generation) return;
			// Do not surface arbitrary auth errors or response bodies, which may include secrets.
			const detail = error instanceof BudgetError ? error.message
				: error instanceof Error && error.name === "TimeoutError" ? "request timed out" : "unavailable";
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", `Bifrost budget: ${detail} (/bifrost-budget)`));
			if (manual) ctx.ui.notify(`Bifrost budget: ${detail}.`, "error");
		}
	};

	const refreshSelection = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(STATUS_KEY, isBifrostProvider(ctx.model?.provider)
			? ctx.ui.theme.fg("dim", "Bifrost budget: loading…") : undefined);
		void refresh(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		refreshSelection(ctx);
		timer = setInterval(() => void refresh(ctx), REFRESH_INTERVAL_MS);
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode === "tui") refreshSelection(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode === "tui") void refresh(ctx);
	});

	pi.registerCommand("bifrost-budget", {
		description: "Refresh the Bifrost daily budget status",
		handler: async (_args, ctx) => refresh(ctx, true),
	});

	pi.on("session_shutdown", () => {
		generation++;
		clearInterval(timer);
		timer = undefined;
	});
}
