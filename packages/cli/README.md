# BetterDB Monitor CLI

Monitor and observe your Valkey/Redis databases from the command line.

## Installation

### Quick Start (npx)

```bash
npx @betterdb/monitor
```

### Global Installation

```bash
npm install -g @betterdb/monitor
```

### Package Manager

```bash
# pnpm
pnpm dlx @betterdb/monitor

# yarn
yarn dlx @betterdb/monitor
```

## Usage

### First Run

On first run, BetterDB will launch an interactive setup wizard to configure:

- Database connection (host, port, type, credentials)
- Storage backend (SQLite, PostgreSQL, or in-memory)
- Application settings (port, anomaly detection)
- Optional security settings (encryption key, license)

Configuration is saved to `~/.betterdb/config.json`.

### Commands

```bash
# Start the monitor (runs setup if no config exists)
betterdb

# Run the setup wizard
betterdb setup
betterdb --setup

# Skip setup wizard (uses defaults or exits if no config)
betterdb --no-setup

# Show version
betterdb --version

# Show help
betterdb --help
```

### CLI Flags

Override configuration with command-line flags:

```bash
betterdb --port 8080           # Custom server port
betterdb --db-host 192.168.1.5 # Custom database host
betterdb --db-port 6380        # Custom database port
betterdb --storage-type memory # Use in-memory storage
```

## Configuration

Configuration is stored at `~/.betterdb/config.json`:

```json
{
  "database": {
    "host": "localhost",
    "port": 6379,
    "username": "default",
    "password": "",
    "type": "auto"
  },
  "storage": {
    "type": "sqlite",
    "sqlitePath": "~/.betterdb/data/audit.db"
  },
  "security": {},
  "app": {
    "port": 3001,
    "anomalyDetection": true
  }
}
```

### Storage Options

#### SQLite (Default)

Requires `better-sqlite3` to be installed:

```bash
npm install better-sqlite3
```

#### PostgreSQL

Provide a connection URL:

```json
{
  "storage": {
    "type": "postgres",
    "postgresUrl": "postgresql://user:password@localhost:5432/betterdb"
  }
}
```

#### In-Memory

No persistence, data is lost on restart:

```json
{
  "storage": {
    "type": "memory"
  }
}
```

## Access Points

After starting, the following endpoints are available:

- **Web UI**: http://localhost:3001
- **API**: http://localhost:3001/api
- **API Docs**: http://localhost:3001/api/docs

## Requirements

- Node.js >= 20.0.0
- Valkey or Redis instance to monitor
- (Optional) `better-sqlite3` for SQLite storage

## Security

When an encryption key is configured, database passwords are encrypted at rest using AES-256-GCM envelope encryption. Set the encryption key during setup or via the `ENCRYPTION_KEY` environment variable.

## Publishing (Maintainers)

The CLI is published automatically via GitHub Actions when a version tag is pushed:

```bash
# Update version in root package.json and packages/cli/package.json
# Then tag and push
git tag v0.5.0
git push origin v0.5.0
```

This will:
1. Build the CLI package
2. Publish to npm with provenance
3. Create a GitHub Release with the tarball

**Required secrets:**
- `NPM_TOKEN` - npm automation token with publish access

**Manual publishing:**
```bash
pnpm cli:build
cd packages/cli
npm publish --access public
```

## License

See LICENSE in the repository root.
