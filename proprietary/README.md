# BetterDB Proprietary Features

This directory contains source-available features licensed under the [Open Core Ventures Source Available License (OCVSAL) v1.0](./LICENSE).

## License Summary

**You ARE permitted to:**
- Read and study the source code
- Modify the software and test your modifications
- Share modifications for non-production use
- Use in development, testing, and evaluation environments

**Production use requires a valid commercial agreement with BetterDB Inc.**

This includes running the software in production environments, offering it as a hosted service, or any other production deployment. See [License Terms](#getting-a-license) below.

> **Note:** You must retain the OCVSAL license on any copies of the software you share with others. Any suggestions, contributions, or feedback you provide are licensed back to BetterDB Inc. under an irrevocable, royalty-free, unlimited license.

## Getting a License

Contact sales@betterdb.com for commercial licensing options, or visit [betterdb.com/pricing](https://betterdb.com/pricing) for available tiers.

## Features in This Directory

### License (`/license`)
License validation and feature gating infrastructure.
- Provides `LicenseGuard` and `@RequiresFeature()` decorator
- Checks `BETTERDB_LICENSE_KEY` env var

### Key Analytics (`/key-analytics`)
Key pattern analysis with memory, TTL, and access frequency metrics.
- Samples keys via SCAN and groups by extracted patterns
- Tracks stale keys, hot/cold classification, expiring keys
- Tier: Pro and above

### AI Assistant (`/ai`)
Natural language interface for querying monitoring data and Valkey documentation.
- Requires: Ollama with Qwen 2.5 7B + nomic-embed-text
- Tier: Enterprise

### Entitlement Service (`/entitlement`)
Standalone NestJS service for BetterDB Cloud control plane.
- License validation and Stripe integration
- Admin APIs for customer/license management
- Tenant management for multi-tenant cloud deployments
- Runs as separate container (not imported by monitor)

## Third-Party Components

Any third-party components incorporated into this software retain their original licenses as provided by their respective authors.
