# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-10

### Added

- **Three new tools**, bringing the stdio server to parity with the hosted remote server at `api.riskstate.ai/mcp` (which had exposed three tools since July while this package still shipped one):
  - `get_market_structure` — the Market Structure Engine read (`POST /v1/market-structure`): structural events, triggers, and the friction zones between spot and them.
  - `get_playbook_status` — the Trading Playbook Engine feed (`GET /api/playbook-data`). **Public: needs no API key.** Reports a setup as actionable only when its conditions match, no engine vetoed it, and it is not in alert cooldown; matching-but-cooling setups are counted separately so an agent does not act twice on one signal.
  - `check_trade` — assess proposed position(s) against the caps (`POST /v2/portfolio-risk-state`). Read-only; returns per-position `allowed`, the size cap, and `reason_codes` when blocked. Portfolio-aware, so send held positions too.
- README: the keyless remote connector (`api.riskstate.ai/mcp`, Claude/ChatGPT setup), and an explicit "Why there are no write tools" section — the governed system must not be able to move its own limits, or `policy_hash` stops meaning anything.

### Changed

- Tool handlers extracted to `src/handlers.ts`. The test suite previously ran against a copy of the handler pasted into the test file; it now exercises the shipped code. All 10 pre-existing tests pass unchanged against the extracted handler, plus 9 new ones.
- Server version string was pinned at `1.0.0` while the package was at `1.0.8`; it now tracks the package version.
- Canonical URLs moved to the `Riskstate` GitHub org (`github.com/Riskstate/mcp`).

## [1.0.8] - 2026-06-04

### Changed

- Canonical package URLs now point to GitHub (the `likidodefi` account flag was lifted 2026-06-04, so the public repos are visible again): `homepage` → `github.com/likidodefi/riskstate-mcp#readme`, added `repository` → `github.com/likidodefi/riskstate-mcp`, `bugs.url` → GitHub Issues. Previously these pointed at `riskstate.ai` while the GitHub account was flagged.

## [1.0.4] - 2026-03-26

### Fixed

- Summary field mapping aligned with real API v1.2.0 response structure (was reading from non-existent nested objects → showed UNKNOWN/?)
- API timeout increased from 15s to 30s to handle Netlify cold starts (function fetches 9+ data sources)

## [1.0.2] - 2026-03-24

### Fixed

- `npx` binary resolution: added `riskstate-mcp` as the primary bin name. Use `npx -p @riskstate/mcp-server riskstate-mcp` for npx, or `npm install -g @riskstate/mcp-server` then `riskstate-mcp` for global install.

## [1.0.0] - 2026-03-22

### Added

- Initial release: MCP server wrapping the RiskState `/v1/risk-state` API
- One tool: `get_risk_policy` — returns policy level, max position size, leverage limits, allowed/blocked actions
- Support for BTC and ETH assets
- Optional DeFi wallet integration (Spark Protocol, Aave V3)
- Human-readable summary prepended to JSON response for quick agent parsing
- Error handling for auth failures, rate limits, timeouts, and server errors
- Claude Desktop and Claude Code integration via `npx -p @riskstate/mcp-server riskstate-mcp`
- Dockerfile for containerized deployment
- MIT License
