# BetterDB Proprietary Features

This directory contains source-available features that require a commercial license for production use.

## License Terms

The code in this directory is licensed under the [Open Core Ventures Source Available License (OCVSAL) v1.0](./LICENSE).

**You ARE permitted to:**
- Read and study the source code
- Run the software locally for testing and evaluation
- Modify the software and contribute improvements back
- Use in development and staging environments

**You are NOT permitted to (without a commercial license):**
- Use in production environments
- Offer as a hosted service to third parties

## Getting a License

Contact sales@betterdb.com for commercial licensing options.

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
