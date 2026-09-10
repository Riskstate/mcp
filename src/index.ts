#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  checkTrade,
  getMarketStructure,
  getPlaybookStatus,
  getRiskPolicy,
  type Deps,
} from "./handlers.js";

const API_BASE = process.env.RISKSTATE_API_URL || "https://api.riskstate.ai";

/** Read at call time, not module load, so tests and hosts can vary it. */
const deps = (): Deps => ({
  apiBase: API_BASE,
  apiKey: process.env.RISKSTATE_API_KEY,
  fetchFn: fetch,
});

const server = new McpServer({
  name: "riskstate",
  version: "1.1.0",
});

const asset = z.enum(["BTC", "ETH"]);

server.tool(
  "get_risk_policy",
  "Get the current risk governance policy for a crypto asset. Returns policy level (BLOCK/CAUTIOUS/GREEN), max position size, leverage limits, allowed and blocked actions, and confidence score. Call this BEFORE every trade to determine how much risk is allowed.",
  {
    asset: asset.describe("Asset to get risk policy for"),
    wallet_address: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid Ethereum address (0x + 40 hex chars)")
      .optional()
      .describe("DeFi wallet address for on-chain position data (LTV, health factor)"),
    protocol: z
      .enum(["spark", "aave"])
      .optional()
      .describe("DeFi lending protocol (default: spark)"),
    include_details: z
      .boolean()
      .optional()
      .describe(
        "Include detailed breakdown: composite subscores, macro data, risk flags, data sources",
      ),
  },
  (input) => getRiskPolicy(input, deps()),
);

server.tool(
  "get_market_structure",
  "Get the structural picture for a crypto asset from the Market Structure Engine: where price sits in its cycle and range, which structural events are forming or confirmed, the breakout/breakdown triggers, and the friction zones (price walls) in between. Answers 'are we near an inflection?' — it does NOT say how much you may risk; use get_risk_policy for that.",
  {
    asset: asset.describe("Asset to get the structural read for"),
  },
  (input) => getMarketStructure(input, deps()),
);

server.tool(
  "get_playbook_status",
  "List the locked trading playbooks and which setups are actionable right now, per asset. A setup is actionable only when its conditions match, no engine vetoed it, and it is not in alert cooldown — setups that match but already alerted are reported separately, so you do not act on the same signal twice. This endpoint is public and needs no API key.",
  {
    asset: asset.optional().describe("Restrict to one asset (default: both)"),
  },
  (input) => getPlaybookStatus(input, deps()),
);

server.tool(
  "check_trade",
  "Assess one or more PROPOSED positions against the engine's limits before placing them. Returns, per position, whether it is allowed, the policy level, the size cap in percent and dollars, and the reason codes when it is not — plus portfolio-level gross/net exposure and concentration. Read-only: it evaluates a hypothetical book and places no orders. Send the position(s) you are considering, including any you already hold, since the caps are portfolio-aware.",
  {
    positions: z
      .array(
        z.object({
          asset: asset,
          size_usd: z.number().positive().describe("Notional size in USD"),
          side: z.enum(["long", "short"]),
          venue_type: z
            .enum(["spot", "perp"])
            .optional()
            .describe("Venue (default: spot). A spot+perp pair is read as a hedge."),
        }),
      )
      .min(1)
      .max(20)
      .describe("The book to assess: proposed position(s) plus anything already held"),
  },
  (input) => checkTrade(input, deps()),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start RiskState MCP server:", err);
  process.exit(1);
});
