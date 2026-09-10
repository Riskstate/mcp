import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkTrade,
  getMarketStructure,
  getPlaybookStatus,
  getRiskPolicy,
  type Deps,
} from "./handlers.js";

// These tests exercise the REAL handlers from ./handlers.ts. They used to run
// against a copy of the handler pasted into this file, which could (and did)
// drift from the shipped code.

const API_BASE = "https://api.riskstate.ai";

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: new Headers(),
    redirected: false,
    statusText: "",
    type: "basic" as ResponseType,
    url: "",
    clone: () => mockResponse(status, body),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    bytes: async () => new Uint8Array(),
  } as Response;
}

const deps = (apiKey: string | undefined, fetchFn: typeof fetch): Deps => ({
  apiBase: API_BASE,
  apiKey,
  fetchFn,
});

/** Back-compat shim so the existing get_risk_policy suite reads unchanged. */
const handleGetRiskPolicy = (
  input: { asset: string; wallet_address?: string; protocol?: string; include_details?: boolean },
  apiKey: string | undefined,
  fetchFn: typeof fetch,
) => getRiskPolicy(input, deps(apiKey, fetchFn));

describe("get_risk_policy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error when API key is missing", async () => {
    const result = await handleGetRiskPolicy(
      { asset: "BTC" },
      undefined,
      vi.fn()
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("RISKSTATE_API_KEY");
  });

  it("returns formatted policy on successful response", async () => {
    const apiData = {
      exposure_policy: {
        max_size_fraction: 0.65,
        max_leverage: "2x",
        blocked_actions: [],
        allowed_actions: ["LONG", "SHORT", "DCA"],
      },
      policy_level: 4,
      structural_state: "MID",
      market_regime: "RANGE",
      volatility_regime: "NORMAL",
      confidence_score: 0.72,
      data_quality_score: 94,
      binding_constraint: { source: "MACRO", reason: "NEUTRAL" },
      ttl_seconds: 60,
    };

    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, apiData));
    const result = await handleGetRiskPolicy(
      { asset: "BTC" },
      "test-key",
      fetchFn
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("POLICY: Level 4 | MID");
    expect(result.content[0].text).toContain("MAX SIZE: 65.0%");
    expect(result.content[0].text).toContain("LEVERAGE: 2x");
    expect(result.content[0].text).toContain("BLOCKED: none");
    expect(result.content[0].text).toContain("CONFIDENCE: 0.72");
    expect(result.content[0].text).toContain("DATA QUALITY: 94%");
    expect(result.content[0].text).toContain("BINDING: MACRO (NEUTRAL)");
    // Verify JSON is appended
    expect(result.content[0].text).toContain('"policy_level"');
  });

  it("returns auth error on 401", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(401, {}));
    const result = await handleGetRiskPolicy(
      { asset: "ETH" },
      "bad-key",
      fetchFn
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Authentication failed");
  });

  it("returns rate limit message on 429", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(429, {}));
    const result = await handleGetRiskPolicy(
      { asset: "BTC" },
      "test-key",
      fetchFn
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Rate limited");
    expect(result.content[0].text).toContain("60 seconds");
  });

  it("returns server error message on 500", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(500, {}));
    const result = await handleGetRiskPolicy(
      { asset: "BTC" },
      "test-key",
      fetchFn
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Server error (500)");
    expect(result.content[0].text).toContain("Retry in 30 seconds");
  });

  it("returns bad request message on 400", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(mockResponse(400, "invalid asset"));
    const result = await handleGetRiskPolicy(
      { asset: "BTC" },
      "test-key",
      fetchFn
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Bad request");
  });

  it("handles network timeout", async () => {
    const timeoutError = new Error("timeout");
    timeoutError.name = "TimeoutError";
    const fetchFn = vi.fn().mockRejectedValue(timeoutError);

    const result = await handleGetRiskPolicy(
      { asset: "BTC" },
      "test-key",
      fetchFn
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("timed out after 30s");
  });

  it("handles generic network error", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await handleGetRiskPolicy(
      { asset: "BTC" },
      "test-key",
      fetchFn
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Network error: ECONNREFUSED");
  });

  it("sends correct request body with all parameters", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      mockResponse(200, {
        exposure_policy: {},
        policy_level: 3,
        ttl_seconds: 60,
      })
    );

    await handleGetRiskPolicy(
      {
        asset: "ETH",
        wallet_address: "0x1234567890abcdef1234567890abcdef12345678",
        protocol: "aave",
        include_details: true,
      },
      "test-key",
      fetchFn
    );

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, options] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.riskstate.ai/v1/risk-state");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      asset: "ETH",
      wallet_address: "0x1234567890abcdef1234567890abcdef12345678",
      protocol: "aave",
      include_details: true,
    });
    expect(options.headers.Authorization).toBe("Bearer test-key");
  });

  it("handles blocked actions in summary", async () => {
    const apiData = {
      exposure_policy: {
        max_size_fraction: 0,
        max_leverage: "1x",
        blocked_actions: ["NEW_TRADES", "LEVERAGE_GT_2X"],
        allowed_actions: ["REDUCE", "HEDGE"],
      },
      policy_level: 1,
      structural_state: "BOTTOM",
      market_regime: "PANIC",
      volatility_regime: "EXTREME",
      confidence_score: 0.40,
      data_quality_score: 80,
      binding_constraint: { source: "RULES", reason: "3 critical" },
      ttl_seconds: 60,
    };

    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, apiData));
    const result = await handleGetRiskPolicy(
      { asset: "BTC" },
      "test-key",
      fetchFn
    );

    expect(result.content[0].text).toContain("BLOCKED: NEW_TRADES, LEVERAGE_GT_2X");
    expect(result.content[0].text).toContain("REGIME: PANIC | VOLATILITY: EXTREME");
  });
});

describe("get_market_structure", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("requires an API key", async () => {
    const r = await getMarketStructure({ asset: "BTC" }, deps(undefined, vi.fn()));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("RISKSTATE_API_KEY");
  });

  it("summarises headline, triggers, events and friction", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      mockResponse(200, {
        asset: "BTC",
        headline: "BUYABLE FEAR",
        subhead: "Fear dislocation, regime gate clear",
        watch: { breakout: 71200, breakdown: 58400 },
        asymmetry: { label: "POSITIVE" },
        events: [
          { event: "Extreme Fear Reversal", direction: "bullish", status: "confirmed", validated: true },
          { event: "Breakout Continuation", direction: "bullish", status: "forming", validated: false },
          { event: "Old Thing", status: "suppressed" },
        ],
        friction_levels: { summary: "2 walls to the 40d-high trigger" },
        structure_version: "structure_v0.7",
        state_hash: "abc123",
      }),
    );
    const r = await getMarketStructure({ asset: "BTC" }, deps("k", fetchFn));

    expect(r.isError).toBeUndefined();
    const t = r.content[0].text;
    expect(t).toContain("STRUCTURE BTC: BUYABLE FEAR");
    expect(t).toContain("ASYMMETRY: POSITIVE");
    expect(t).toContain("breakout 71200");
    expect(t).toContain("EVENTS (2 active)");     // suppressed one excluded
    expect(t).toContain("accruing");               // validated:false surfaced
    expect(t).toContain("FRICTION: 2 walls");
  });

  it("omits the friction line on an older response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, { asset: "ETH", events: [] }));
    const r = await getMarketStructure({ asset: "ETH" }, deps("k", fetchFn));
    expect(r.content[0].text).not.toContain("FRICTION:");
  });
});

describe("get_playbook_status", () => {
  beforeEach(() => vi.restoreAllMocks());

  const feed = {
    schema: "playbook_view_v2",
    count: 10,
    firing: {
      BTC: [
        { playbook_id: "pb-fires", would_fire: true, suppressed: false, structure_blocked: false, fire_blocked_by: null, gate_status: "ALLOW" },
        { playbook_id: "pb-cooling", would_fire: true, suppressed: false, structure_blocked: false, fire_blocked_by: "cooldown", gate_status: "ALLOW" },
        { playbook_id: "pb-vetoed", would_fire: true, suppressed: false, structure_blocked: true, fire_blocked_by: null, gate_status: "BLOCK" },
      ],
      ETH: [],
    },
  };

  it("works WITHOUT an API key (public endpoint)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, feed));
    const r = await getPlaybookStatus({}, deps(undefined, fetchFn));
    expect(r.isError).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledOnce();
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("does not report a cooldown-locked setup as actionable", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, feed));
    const r = await getPlaybookStatus({ asset: "BTC" }, deps(undefined, fetchFn));
    const t = r.content[0].text;
    expect(t).toContain("BTC: 1 actionable");
    expect(t).toContain("pb-fires");
    expect(t).not.toContain("pb-cooling (gate");        // not in the actionable list
    expect(t).toContain("1 matching but in cooldown");  // but still surfaced
    expect(t).not.toContain("pb-vetoed (gate");         // structure-blocked excluded
  });

  it("covers both assets when none is given", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, feed));
    const r = await getPlaybookStatus({}, deps(undefined, fetchFn));
    expect(r.content[0].text).toContain("BTC:");
    expect(r.content[0].text).toContain("ETH: 0 actionable");
  });
});

describe("check_trade", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("requires an API key", async () => {
    const r = await checkTrade(
      { positions: [{ asset: "BTC", size_usd: 1000, side: "long" }] },
      deps(undefined, vi.fn()),
    );
    expect(r.isError).toBe(true);
  });

  it("reports per-position verdicts and keeps advisories separate from blockers", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      mockResponse(200, {
        portfolio: { portfolio_allowed: false, gross_exposure_usd: 330000, net_exposure_usd: 330000 },
        positions: [
          { index: 0, asset: "BTC", side: "long", size_usd: 250000, allowed: false,
            policy_level: 4, max_size_fraction: 0.42, max_size_usd: 138600,
            reason_codes: ["POSITION_OVER_MAX_SIZE"], advisories: ["ALL_IN_BLOCKED_BY_ENGINE"] },
          { index: 1, asset: "ETH", side: "long", size_usd: 80000, allowed: true,
            policy_level: 4, max_size_fraction: 0.48, max_size_usd: 158400,
            reason_codes: [], advisories: [] },
        ],
      }),
    );
    const r = await checkTrade(
      { positions: [
        { asset: "BTC", size_usd: 250000, side: "long" },
        { asset: "ETH", size_usd: 80000, side: "long" },
      ] },
      deps("k", fetchFn),
    );

    const t = r.content[0].text;
    expect(t).toContain("PORTFOLIO: NOT ALLOWED");
    expect(t).toContain("[0] BTC long 250000 → BLOCKED");
    expect(t).toContain("cap 42.0%");
    expect(t).toContain("blocked_by: POSITION_OVER_MAX_SIZE");
    expect(t).toContain("note: ALL_IN_BLOCKED_BY_ENGINE");
    expect(t).toContain("[1] ETH long 80000 → ALLOWED");
    expect(t).toContain("pre-trade assessment, not an order");
  });

  it("sends the positions array to /v2/portfolio-risk-state", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mockResponse(200, { portfolio: {}, positions: [] }));
    await checkTrade(
      { positions: [{ asset: "BTC", size_usd: 500, side: "short", venue_type: "perp" }] },
      deps("k", fetchFn),
    );
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/v2/portfolio-risk-state");
    expect(JSON.parse(init.body)).toEqual({
      positions: [{ asset: "BTC", size_usd: 500, side: "short", venue_type: "perp" }],
    });
  });
});
