/**
 * Tool handlers, kept separate from the MCP wiring so the test suite can
 * exercise the real code path instead of a copy that drifts.
 *
 * Every handler is READ-ONLY by design. See README — the governed system must
 * not be able to move its own limits, or `policy_hash` stops meaning anything.
 */

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export const MISSING_KEY_TEXT =
  "Error: RISKSTATE_API_KEY environment variable is required. Get a free API key at https://riskstate.ai";

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function httpErrorText(status: number, body: string): string {
  if (status === 401) return "Authentication failed. Check your RISKSTATE_API_KEY is valid.";
  if (status === 429)
    return "Rate limited. Wait 60 seconds before retrying. Limit: 60 requests/minute.";
  if (status === 400) return `Bad request: ${body || "check parameters"}`;
  if (status === 503)
    return `Core data unavailable upstream (503). ${body || "Retry in 30 seconds."}`;
  if (status >= 500) return `Server error (${status}). Retry in 30 seconds.`;
  return `HTTP ${status}: ${body || "Unknown error"}`;
}

export function networkErrorText(e: unknown): string {
  if (e instanceof Error) {
    return e.name === "TimeoutError" || e.name === "AbortError"
      ? "Request timed out after 30s. The API may be under heavy load — retry in 30s."
      : `Network error: ${e.message}`;
  }
  return "Unknown error";
}

export interface Deps {
  apiBase: string;
  apiKey?: string;
  fetchFn: typeof fetch;
}

/** One request + uniform error handling. `auth: false` for the keyless endpoints. */
async function call(
  deps: Deps,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; auth: boolean },
): Promise<{ data: unknown } | { error: ToolResult }> {
  if (init.auth && !deps.apiKey) return { error: err(MISSING_KEY_TEXT) };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.auth && deps.apiKey) headers.Authorization = `Bearer ${deps.apiKey}`;

  try {
    const res = await deps.fetchFn(`${deps.apiBase}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: err(httpErrorText(res.status, text)) };
    }
    return { data: await res.json() };
  } catch (e) {
    return { error: err(networkErrorText(e)) };
  }
}

const num = (v: unknown, d = 1) => (typeof v === "number" ? v.toFixed(d) : "?");
const pct = (v: unknown) => (typeof v === "number" ? (v * 100).toFixed(1) + "%" : "?");

/* ------------------------------------------------------------------ */

export interface RiskPolicyInput {
  asset: string;
  wallet_address?: string;
  protocol?: string;
  include_details?: boolean;
}

export async function getRiskPolicy(input: RiskPolicyInput, deps: Deps): Promise<ToolResult> {
  const body: Record<string, unknown> = { asset: input.asset };
  if (input.wallet_address) body.wallet_address = input.wallet_address;
  if (input.protocol) body.protocol = input.protocol;
  if (input.include_details) body.include_details = input.include_details;

  const r = await call(deps, "/v1/risk-state", { method: "POST", body, auth: true });
  if ("error" in r) return r.error;
  const data = r.data as Record<string, any>;

  const policy = data.exposure_policy || {};
  const maxSizePct =
    policy.max_size_fraction != null ? (policy.max_size_fraction * 100).toFixed(1) : "?";

  const summary = [
    `POLICY: Level ${data.policy_level ?? "?"} | ${data.structural_state ?? "?"}`,
    `MAX SIZE: ${maxSizePct}%`,
    `LEVERAGE: ${policy.max_leverage ?? "?"}`,
    `BLOCKED: ${(policy.blocked_actions || []).join(", ") || "none"}`,
    `REGIME: ${data.market_regime || "?"} | VOLATILITY: ${data.volatility_regime || "?"}`,
    `CONFIDENCE: ${data.confidence_score ?? "?"} | DATA QUALITY: ${data.data_quality_score ?? "?"}%`,
    `BINDING: ${data.binding_constraint?.source ?? "?"} (${data.binding_constraint?.reason ?? "?"})`,
    `TTL: ${data.ttl_seconds ?? 60}s`,
  ].join("\n");

  return ok(summary + "\n\n" + JSON.stringify(data, null, 2));
}

/* ------------------------------------------------------------------ */

export async function getMarketStructure(
  input: { asset: string },
  deps: Deps,
): Promise<ToolResult> {
  const r = await call(deps, "/v1/market-structure", {
    method: "POST",
    body: { asset: input.asset },
    auth: true,
  });
  if ("error" in r) return r.error;
  const d = r.data as Record<string, any>;

  const events: any[] = Array.isArray(d.events) ? d.events : [];
  const active = events.filter((e) => e && e.status && e.status !== "suppressed");
  const fr = d.friction_levels;

  const summary = [
    `STRUCTURE ${d.asset ?? "?"}: ${d.headline ?? "?"}`,
    d.subhead ? `  ${d.subhead}` : null,
    `ASYMMETRY: ${d.asymmetry?.label ?? "?"}`,
    `TRIGGERS: breakout ${d.watch?.breakout ?? "?"} | breakdown ${d.watch?.breakdown ?? "?"}`,
    `EVENTS (${active.length} active): ` +
      (active
        .slice(0, 5)
        .map(
          (e) =>
            `${e.event} [${e.direction ?? "neutral"}/${e.status}` +
            (e.validated === false ? ", accruing" : "") +
            `]`,
        )
        .join("; ") || "none"),
    fr ? `FRICTION: ${fr.summary ?? "?"}` : null,
    `STATE: ${d.structure_version ?? "?"} | state_hash ${d.state_hash ?? "?"}`,
  ]
    .filter(Boolean)
    .join("\n");

  return ok(summary + "\n\n" + JSON.stringify(d, null, 2));
}

/* ------------------------------------------------------------------ */

export async function getPlaybookStatus(
  input: { asset?: string },
  deps: Deps,
): Promise<ToolResult> {
  // Public endpoint — deliberately no key required.
  const r = await call(deps, "/api/playbook-data", { method: "GET", auth: false });
  if ("error" in r) return r.error;
  const d = r.data as Record<string, any>;

  const assets = input.asset ? [input.asset] : ["BTC", "ETH"];
  const lines: string[] = [`PLAYBOOKS: ${d.count ?? "?"} active | schema ${d.schema ?? "?"}`];

  for (const a of assets) {
    const rows: any[] = (d.firing || {})[a] || [];
    // A setup that already alerted is NOT actionable, even though its
    // predicate still matches — mirrors firingNow() in the engine client.
    const actionable = rows.filter(
      (f) => f.would_fire && !f.suppressed && !f.structure_blocked && !f.fire_blocked_by,
    );
    const cooling = rows.filter((f) => f.would_fire && f.fire_blocked_by === "cooldown");
    lines.push(
      `${a}: ${actionable.length} actionable` +
        (actionable.length
          ? ` — ${actionable
              .map((f) => `${f.playbook_id} (gate ${f.gate_status ?? "?"})`)
              .join(", ")}`
          : "") +
        (cooling.length ? ` · ${cooling.length} matching but in cooldown` : ""),
    );
  }

  return ok(lines.join("\n") + "\n\n" + JSON.stringify(d, null, 2));
}

/* ------------------------------------------------------------------ */

export interface CheckTradeInput {
  positions: Array<{
    asset: string;
    size_usd: number;
    side: string;
    venue_type?: string;
  }>;
}

export async function checkTrade(input: CheckTradeInput, deps: Deps): Promise<ToolResult> {
  const r = await call(deps, "/v2/portfolio-risk-state", {
    method: "POST",
    body: { positions: input.positions },
    auth: true,
  });
  if ("error" in r) return r.error;
  const d = r.data as Record<string, any>;

  const p = d.portfolio || {};
  const rows: any[] = Array.isArray(d.positions) ? d.positions : [];

  const lines = [
    `PORTFOLIO: ${p.portfolio_allowed ? "ALLOWED" : "NOT ALLOWED"}` +
      ` | gross ${num(p.gross_exposure_usd, 0)} | net ${num(p.net_exposure_usd, 0)}`,
    ...rows.map(
      (x) =>
        `  [${x.index}] ${x.asset} ${x.side} ${num(x.size_usd, 0)} → ` +
        `${x.allowed ? "ALLOWED" : "BLOCKED"} | level ${x.policy_level ?? "?"}` +
        ` | cap ${pct(x.max_size_fraction)} (${num(x.max_size_usd, 0)})` +
        (x.reason_codes?.length ? ` | blocked_by: ${x.reason_codes.join(", ")}` : "") +
        (x.advisories?.length ? ` | note: ${x.advisories.join(", ")}` : ""),
    ),
  ];

  return ok(
    lines.join("\n") +
      "\n\nThis is a pre-trade assessment, not an order. `reason_codes` are blocking; " +
      "`advisories` are informational and do not affect `allowed`.\n\n" +
      JSON.stringify(d, null, 2),
  );
}
