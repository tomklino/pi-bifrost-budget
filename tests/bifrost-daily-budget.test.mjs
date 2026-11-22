import assert from "node:assert/strict";
import { test } from "node:test";
import register from "../extensions/bifrost-daily-budget.ts";

const key = "sk-bf-12345678-abcd-4abc-9def-123456789abc";
const headerKey = "sk-bf-87654321-abcd-4abc-9def-123456789abc";
const quota = {
	budgets: [
		{ reset_duration: "1h", max_limit: 2, current_usage: 0 },
		{ reset_duration: "1d", max_limit: 30, current_usage: 7.25, override_amount: null },
	],
};

async function refresh(t, auth, { provider = "bifrost-test", response = Response.json(quota) } = {}) {
	const fetch = t.mock.method(globalThis, "fetch", async () => response);
	const model = { provider, baseUrl: "https://gateway.example/v1" };
	const statuses = [];
	const notifications = [];
	let command;
	register({
		on() {},
		registerCommand(name, { handler }) {
			assert.equal(name, "bifrost-budget");
			command = handler;
		},
	});
	await command("", {
		model,
		modelRegistry: {
			async getApiKeyAndHeaders(activeModel) {
				assert.equal(activeModel, model);
				return auth;
			},
		},
		ui: {
			setStatus: (_id, text) => statuses.push(text),
			notify: (text, type) => notifications.push({ text, type }),
			theme: { fg: (_color, text) => text },
		},
	});
	return { fetch: fetch.mock, status: statuses.at(-1), notifications };
}

test("shows the daily budget using Pi's bearer key without an X-Bf-Vk config header", async (t) => {
	const { fetch, status } = await refresh(t, { ok: true, apiKey: key });
	assert.equal(status, "Bifrost 7.25$/30.00$");
	assert.equal(fetch.callCount(), 1);
	const [url, request] = fetch.calls[0].arguments;
	assert.equal(url.href, "https://gateway.example/api/governance/virtual-keys/quota");
	assert.deepEqual(request.headers, { "X-Bf-Vk": key });
	assert.equal(request.redirect, "error");
});

test("prefers an explicit X-Bf-Vk header over the bearer key", async (t) => {
	const { fetch, status } = await refresh(t, { ok: true, apiKey: key, headers: { "X-Bf-Vk": headerKey } });
	assert.equal(status, "Bifrost 7.25$/30.00$");
	assert.deepEqual(fetch.calls[0].arguments[1].headers, { "X-Bf-Vk": headerKey });
});

test("shows a warning when a Bifrost model has no usable key", async (t) => {
	const { fetch, status } = await refresh(t, { ok: false, error: `private info: ${key}` });
	assert.equal(fetch.callCount(), 0);
	assert.match(status, /could not resolve the virtual key/);
	assert.ok(!status.includes(key));
});

test("does not query quota with an unrelated provider's API key", async (t) => {
	const { fetch, status } = await refresh(t, { ok: true, apiKey: "sk-other" }, { provider: "openai" });
	assert.equal(fetch.callCount(), 0);
	assert.equal(status, undefined);
});

test("shows the quota HTTP error without revealing the response body", async (t) => {
	const response = new Response(`private info: ${key}`, { status: 401 });
	const { status, notifications } = await refresh(t, { ok: true, apiKey: key }, { response });
	assert.match(status, /HTTP 401/);
	assert.deepEqual(notifications, [{ text: "Bifrost budget: quota request returned HTTP 401.", type: "error" }]);
});
