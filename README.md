# BetterDB Monitor

A monorepo application for monitoring Valkey/Redis databases with a NestJS backend and React frontend.

## Project Structure

```
betterdb-monitor/
├── apps/
│   ├── api/                 # NestJS backend (Fastify)
│   └── web/                 # React frontend (Vite)
├── packages/
│   └── shared/              # Shared TypeScript types
├── docker-compose.yml       # Local Valkey and Redis for testing on 6380 and 6381 respectively
└── package.json             # Workspace root
```

## Tech Stack

### Backend
- **NestJS** with Fastify adapter
- **iovalkey** for Valkey/Redis connections
- TypeScript with strict mode
- Runs on port **3001**

### Frontend
- **React** with TypeScript
- **Vite** for build tooling
- **TailwindCSS** for styling
- **shadcn/ui** for component library
- **Recharts** for data visualization
- Runs on port **5173**

### Monorepo
- **pnpm workspaces** for dependency management
- **Turborepo** for build orchestration

## Quick Start

### Prerequisites
- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Docker (for local Valkey instance)

### Installation

1. Install dependencies:
```bash
pnpm install
```

2. Copy environment variables:
```bash
cp .env.example .env
```

3. Start local Valkey instance:
```bash
pnpm docker:up
```

4. Start development servers:
```bash
pnpm dev
```

The application will be available at:
- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

### Individual Commands

Run only the API:
```bash
pnpm dev:api
```

Run only the web frontend:
```bash
pnpm dev:web
```

Stop Docker containers:
```bash
pnpm docker:down
```

Build for production:
```bash
pnpm build
```

## Features

### Current Features
- Database connection health monitoring
- Auto-detection of Valkey vs Redis
- Version detection
- Capability detection (Command Log, Slot Stats)
- Auto-refresh every 5 seconds

### Architecture Highlights

**Port/Adapter Pattern**: The backend uses a port interface (`DatabasePort`) with separate adapters for Valkey and Redis, making it easy to extend support for other databases.

**Auto-detection**: The application automatically detects whether it's connecting to Valkey or Redis by inspecting the `INFO` response.

**Capability Detection**: Features like Command Log (Valkey 8.1+) and Slot Stats (Valkey 8.0+) are automatically detected based on database version.

## Configuration

Edit `.env` to configure database connection:

```env
DB_HOST=localhost
DB_PORT=6379
DB_USERNAME=default
DB_PASSWORD=devpassword
DB_TYPE=auto  # 'valkey' | 'redis' | 'auto'
```

## Development

### Adding New Features

The codebase is structured to make it easy to add new monitoring features:

1. Add new endpoints in `apps/api/src/`
2. Add corresponding API calls in `apps/web/src/api/`
3. Add shared types in `packages/shared/src/types/`

### Code Style

- TypeScript strict mode is enabled
- Explicit return types required on functions
- No `any` types allowed
- ESLint + Prettier configured

## License

MIT
