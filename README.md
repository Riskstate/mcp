# RiskState MCP Server

MCP server for [RiskState](https://riskstate.ai) — pre-trade risk permissions for BTC/USD and ETH/USD. Spot, perpetual futures (perps), and DeFi borrowing aware.

Your system asks: **"How much can I risk right now?"**
RiskState answers with: policy level, max exposure, leverage limits, blocked actions — computed from 30+ real-time signals.

## Two ways to use RiskState over MCP

**1. Remote connector — no install, no API key.** RiskState runs a hosted MCP
server (Streamable HTTP) with a free public tier:

```
https://api.riskstate.ai/mcp
```

Add it as a custom connector in [Claude](https://riskstate.ai/connect/claude) or
[ChatGPT](https://riskstate.ai/connect/chatgpt), then just ask what the risk
state of BTC is. It exposes three read-only tools — `get_risk_state`,
`get_market_structure`, `get_playbook_status` — covering all three engines, and
is listed on the official MCP registry as `ai.riskstate/mcp`.

Responses are the free public summary: the same altitude as the public
visualizer. `policy_hash`, composite subscores, positioning and macro detail
need a key.

**2. This package — stdio, keyed, full response.** Use it when you want the
complete audited payload in a local agent, or to pin a version in your own
toolchain. It needs a `RISKSTATE_API_KEY` and returns everything your key is
entitled to. That is what the rest of this README covers.

## Tools

Four read-only tools, one per question you might ask before a trade:

| Tool | Answers | Endpoint | Key |
|------|---------|----------|-----|
| `get_risk_policy` | *How much exposure is allowed?* | `POST /v1/risk-state` | yes |
| `get_market_structure` | *Are we near a structural inflection?* | `POST /v1/market-structure` | yes |
| `get_playbook_status` | *Is a setup actionable right now?* | `GET /api/playbook-data` | no |
| `check_trade` | *Would THIS position be allowed?* | `POST /v2/portfolio-risk-state` | yes |

`get_risk_policy` returns:

| Field | Description |
|-------|-------------|
| `policy_level` | 5 levels: BLOCK_SURVIVAL, BLOCK_DEFENSIVE, CAUTIOUS, GREEN_SELECTIVE, GREEN_EXPANSION |
| `max_size_pct` | Maximum position size as % of portfolio (0-100) |
| `leverage_max` | Maximum allowed leverage multiplier |
| `allowed_actions` | What the agent CAN do at this policy level |
| `blocked_actions` | What the agent CANNOT do |
| `confidence_score` | Signal agreement x data quality (0-1) |

`check_trade` evaluates a hypothetical book — send the position you are
considering **plus anything you already hold**, since the caps are
portfolio-aware. It returns per position whether it is allowed, the size cap in
percent and dollars, and `reason_codes` when it is not. Those are blocking;
`advisories` are informational and do not affect `allowed`. It places no orders.

`get_playbook_status` reports a setup as actionable only when its conditions
match, no engine vetoed it, **and** it is not in alert cooldown. Setups that
match but already alerted are counted separately, so an agent polling this tool
does not act on the same signal twice.

## Why there are no write tools

There is no `update_policy`, no `set_limit`, no exception management — and there
will not be. The premise of RiskState is that the system being governed cannot
move its own limits. Every decision is hashed (`policy_hash`) so it can be
audited afterwards against the inputs that produced it; a tool that let the
caller rewrite the policy would make that hash meaningless and the audit trail
decorative.

So the lifecycle here deliberately lives on one side: the engine computes, the
agent reads and complies. `check_trade` is the closest thing to a dynamic
per-trade operation, and it is still read-only — it answers "would this be
allowed", never "allow this".

The API aggregates 9+ real-time data sources server-side. See [API docs](https://riskstate.ai/docs/api) for details.

## What this wrapper does (and doesn't)

This is a **thin wrapper** — it translates MCP tool calls into REST API requests and returns the response. All computation (scoring, policy engine, data ingestion) happens server-side.

**This wrapper adds:**
- MCP protocol compliance (stdio transport for Claude Desktop/Code)
- Input validation via Zod schemas
- Human-readable policy summary prepended to responses
- Specific error messages (auth, rate limit, timeout) for agent recovery

**This wrapper does NOT:**
- Cache responses (the API has 60s server-side cache)
- Perform any scoring or computation locally
- Guarantee response schema stability (follows API versioning)

## Installation

```bash
npm install @riskstate/mcp-server
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `RISKSTATE_API_KEY` | Yes | API key from [riskstate.ai](https://riskstate.ai) (free during beta) |
| `RISKSTATE_API_URL` | No | Custom API base URL (default: `https://api.riskstate.ai`) |

### Claude Desktop

Add to `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "riskstate": {
      "command": "npx",
      "args": ["-p", "@riskstate/mcp-server", "riskstate-mcp"],
      "env": {
        "RISKSTATE_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add riskstate -- npx -p @riskstate/mcp-server riskstate-mcp
```

Set the API key in your environment:

```bash
export RISKSTATE_API_KEY=your-api-key
```

### Global install (alternative)

```bash
npm install -g @riskstate/mcp-server
riskstate-mcp  # starts MCP server on stdio
```

## Usage

The four tools are listed above. `get_risk_policy` takes:

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `asset` | `"BTC"` \| `"ETH"` | Yes | Asset to analyze |
| `wallet_address` | string | No | DeFi wallet for on-chain position data |
| `protocol` | `"spark"` \| `"aave"` | No | Lending protocol (default: spark) |
| `include_details` | boolean | No | Include full breakdown (subscores, macro, risk flags) |

### Example Response

```json
{
  "exposure_policy": {
    "policy_level": "CAUTIOUS",
    "max_size_pct": 35,
    "leverage_max": 1.5,
    "allowed_actions": ["DCA", "WAIT", "SPOT_LONG_CONFIRMED"],
    "blocked_actions": ["LEVERAGE_GT_2X", "NEW_POSITIONS_UNCONFIRMED"]
  },
  "classification": {
    "cycle_phase": "MID",
    "market_regime": "RANGE",
    "macro_regime": "NEUTRAL",
    "direction": "SIDEWAYS"
  },
  "auditability": {
    "composite_score": 52,
    "confidence_score": 0.72,
    "policy_hash": "a3f8c2...",
    "ttl_seconds": 60
  }
}
```

## How Agents Should Use This

Call `get_risk_policy` **before every trade**:

1. If `policy_level` starts with `BLOCK` → do not open new positions
2. Use `max_size_pct` to cap position sizing
3. Check `blocked_actions` before executing
4. Re-query after `ttl_seconds` (60s cache)

For a sized position, `check_trade` collapses steps 2-3 into one call: send the
position you intend to open along with what you already hold, and read `allowed`
plus `reason_codes`. Prefer it over re-deriving the cap yourself, since the caps
are portfolio-aware and a position that passes in isolation can still breach
concentration once aggregated.

`get_market_structure` and `get_playbook_status` are context, not permission.
Neither one authorises a trade — only the risk policy does. Use them to decide
*whether* a trade is worth proposing, then `get_risk_policy` / `check_trade` to
learn how much of it you are allowed.

## Limitations

- **v1 scope:** BTC/USD and ETH/USD only (USD-denominated assessment). More assets planned.
- **Markets:** Spot, perpetual futures, and DeFi borrowing. Same response — interpretation differs by market (see [API docs](https://riskstate.ai/docs/api)).
- **Protocols:** Spark and Aave V3 only for DeFi position data.
- **Rate limit:** 60 requests/minute per API key.
- **Latency:** ~1-3s per request (9+ upstream data source aggregation).
- **Tested with:** Claude Desktop, Claude Code. Should work with any MCP-compatible client.

## Links

- **Landing page:** [riskstate.ai](https://riskstate.ai)
- **API docs:** [riskstate.ai/docs/api](https://riskstate.ai/docs/api)
- **SKILL.md:** [agentskills.io](https://agentskills.io)

## License

MIT
