---
title: AI Features
nav_order: 8
---

# AI Features Guide

BetterDB includes AI-powered features for intelligent assistance with Valkey/Redis operations, query optimization, and troubleshooting.

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Setup Instructions](#setup-instructions)
- [Architecture Options](#architecture-options)
- [Using the AI Assistant](#using-the-ai-assistant)
- [Troubleshooting](#troubleshooting)
- [Advanced Configuration](#advanced-configuration)

## Overview

The AI assistant provides:
- **Natural language queries** about your Valkey/Redis instance
- **Performance analysis** and optimization suggestions
- **Command help** with examples and best practices
- **Troubleshooting assistance** for common issues
- **RAG (Retrieval Augmented Generation)** using official Valkey documentation

**Note:** AI features are experimental and require a Pro or Enterprise license.

## Prerequisites

### Required Software

1. **Ollama** - Local LLM inference engine
   - Download from: [https://ollama.com](https://ollama.com)
   - Supports: Linux, macOS, Windows

2. **Required Models**
   - `qwen2.5:7b` - Chat LLM (~4.7 GB)
   - `nomic-embed-text:v1.5` - Embeddings (~274 MB)

### System Requirements

- **RAM**: Minimum 8 GB (16 GB recommended for smooth operation)
- **Storage**: ~5 GB for models
- **CPU/GPU**: GPU recommended but not required

## Quick Start

### 1. Install Ollama

#### Linux
```bash
curl -fsSL https://ollama.com/install.sh | sh
```

#### macOS
```bash
brew install ollama
```

#### Windows
Download installer from [https://ollama.com/download](https://ollama.com/download)

### 2. Start Ollama Service

```bash
# Linux/macOS (systemd)
systemctl start ollama

# Or run in foreground
ollama serve
```

Verify Ollama is running:
```bash
curl http://localhost:11434/api/tags
# Should return: {"models":[]}
```

### 3. Pull Required Models

```bash
# Pull chat model (this will take a few minutes)
ollama pull qwen2.5:7b

# Pull embedding model
ollama pull nomic-embed-text:v1.5
```

Verify models are installed:
```bash
ollama list
```

Expected output:
```
NAME                      ID              SIZE      MODIFIED
qwen2.5:7b               2bada8a74506    4.7 GB    2 minutes ago
nomic-embed-text:v1.5    970aa74c0a90    274 MB    1 minute ago
```

### 4. Enable AI in BetterDB

#### Docker
```bash
docker run -d \
  --name betterdb \
  --network host \
  -e DB_HOST=localhost \
  -e DB_PORT=6379 \
  -e BETTERDB_LICENSE_KEY=your-license-key \
  -e AI_ENABLED=true \
  -e OLLAMA_BASE_URL=http://localhost:11434 \
  betterdb/monitor:latest
```

**Important:** Use `--network host` to allow the container to access Ollama on localhost.

#### Local Development
```bash
# .env file
AI_ENABLED=true
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_KEEP_ALIVE=24h
```

## Setup Instructions

### Step-by-Step Setup

#### 1. Verify Ollama Installation

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# If not running, start it
systemctl start ollama  # Linux/macOS
# OR
ollama serve           # Run in foreground
```

#### 2. Download Models

The models will be downloaded to `~/.ollama/models` by default.

```bash
# Download chat model (4.7 GB - will take time)
ollama pull qwen2.5:7b

# Download embedding model (274 MB - faster)
ollama pull nomic-embed-text:v1.5
```

**Download Progress:**
- Models download in the background
- You can continue with other tasks
- Use `ollama list` to check when complete

#### 3. Test Models

```bash
# Test chat model
ollama run qwen2.5:7b "Hello, what can you help me with?"

# Test embedding model
curl http://localhost:11434/api/embeddings -d '{
  "model": "nomic-embed-text:v1.5",
  "prompt": "test"
}'
```

#### 4. Configure BetterDB

Add to your Docker run command or `.env` file:

```bash
AI_ENABLED=true                           # Enable AI features
OLLAMA_BASE_URL=http://localhost:11434    # Ollama endpoint
OLLAMA_KEEP_ALIVE=24h                     # Keep models loaded
```

#### 5. Verify AI is Working

Once BetterDB starts, check the logs:

```bash
docker logs betterdb | grep AI
```

Expected output:
```
[AI] Proprietary module loaded
```

Access the web UI and you should see the AI assistant icon/chat interface.

## Architecture Options

### Option 1: Host Ollama (Recommended for Development)

**Setup:**
- Ollama runs on your host machine
- BetterDB container connects via `--network host`

**Advantages:**
- Easy to set up
- Models persist between container restarts
- Can use Ollama for other projects

**Architecture:**
```
┌─────────────────────────────────┐
│  Host Machine                   │
│                                 │
│  ┌──────────────────────────┐   │
│  │ Ollama Service           │   │
│  │ Port: 11434              │   │
│  │ Models: ~/.ollama/models │   │
│  └──────────────────────────┘   │
│           ▲                     │
│           │ localhost           │
│  ┌────────┴─────────────────┐   │
│  │ BetterDB Container       │   │
│  │ --network host           │   │
│  │ OLLAMA_BASE_URL=         │   │
│  │   http://localhost:11434 │   │
│  └──────────────────────────┘   │
└─────────────────────────────────┘
```

**Docker Command:**
```bash
docker run -d \
  --name betterdb \
  --network host \
  -e DB_HOST=localhost \
  -e DB_PORT=6379 \
  -e AI_ENABLED=true \
  -e OLLAMA_BASE_URL=http://localhost:11434 \
  betterdb/monitor:latest
```

### Option 2: Ollama in Docker (Recommended for Production)

**Setup:**
- Ollama runs in its own container
- BetterDB connects via Docker networking

**Advantages:**
- Fully containerized
- Portable deployment
- Better isolation

**Architecture:**
```
┌─────────────────────────────────┐
│  Docker Network: betterdb       │
│                                 │
│  ┌──────────────────────────┐   │
│  │ Ollama Container         │   │
│  │ ollama/ollama            │   │
│  │ GPU support (optional)   │   │
│  └──────────────────────────┘   │
│           ▲                     │
│           │                     │
│  ┌────────┴─────────────────┐   │
│  │ BetterDB Container       │   │
│  │ OLLAMA_BASE_URL=         │   │
│  │   http://ollama:11434    │   │
│  └──────────────────────────┘   │
└─────────────────────────────────┘
```

**Docker Compose:**
```yaml
version: '3.8'

services:
  ollama:
    image: ollama/ollama:latest
    container_name: betterdb-ollama
    volumes:
      - ollama-data:/root/.ollama
    ports:
      - "11434:11434"
    # Uncomment for GPU support
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]

  betterdb:
    image: betterdb/monitor:latest
    container_name: betterdb
    depends_on:
      - ollama
    ports:
      - "3001:3001"
    environment:
      - DB_HOST=your-valkey-host
      - DB_PORT=6379
      - BETTERDB_LICENSE_KEY=your-license-key
      - AI_ENABLED=true
      - OLLAMA_BASE_URL=http://ollama:11434
      - OLLAMA_KEEP_ALIVE=24h

volumes:
  ollama-data:
```

**Setup Steps:**
```bash
# 1. Start containers
docker-compose up -d

# 2. Pull models into Ollama container
docker exec betterdb-ollama ollama pull qwen2.5:7b
docker exec betterdb-ollama ollama pull nomic-embed-text:v1.5

# 3. Verify models
docker exec betterdb-ollama ollama list

# 4. Restart BetterDB to initialize AI
docker-compose restart betterdb
```

### Option 3: Remote Ollama

**Setup:**
- Ollama runs on a separate server
- BetterDB connects via network

**Use Case:**
- Shared Ollama instance for multiple BetterDB instances
- Dedicated GPU server for LLM inference

**Configuration:**
```bash
docker run -d \
  --name betterdb \
  -p 3001:3001 \
  -e DB_HOST=your-valkey-host \
  -e DB_PORT=6379 \
  -e AI_ENABLED=true \
  -e OLLAMA_BASE_URL=http://ollama-server:11434 \
  betterdb/monitor:latest
```

## Using the AI Assistant

### Access the Chat Interface

1. Open BetterDB web UI: `http://localhost:3001`
2. Look for the AI assistant icon (usually in the top right or side panel)
3. Click to open the chat interface

### Example Questions

#### General Help
```
"How do I monitor memory usage?"
"What's the difference between SLOWLOG and COMMANDLOG?"
"Show me how to use the client analytics features"
```

#### Performance Analysis
```
"Why is my Valkey instance slow?"
"How can I optimize my key patterns?"
"What commands are consuming the most memory?"
```

#### Troubleshooting
```
"My Valkey instance is using too much memory, what should I check?"
"How do I identify slow queries?"
"What does 'maxmemory-policy allkeys-lru' mean?"
```

#### Command Help
```
"How do I use the SCAN command safely?"
"Show me examples of using HGETALL"
"What's the best way to check if a key exists?"
```

### RAG Documentation Search

The AI assistant has access to the official Valkey documentation through RAG (Retrieval Augmented Generation):

- Answers are grounded in official documentation
- Includes references to documentation sources
- More accurate than general LLM knowledge

## Troubleshooting

### "AI assistant unavailable. Ensure Ollama is running."

**Cause:** BetterDB cannot connect to Ollama.

**Solutions:**

1. **Check Ollama is running:**
   ```bash
   curl http://localhost:11434/api/tags
   ```

   If connection refused:
   ```bash
   systemctl start ollama  # Or: ollama serve
   ```

2. **Verify network connectivity:**

   If using `--network host`:
   ```bash
   # From inside container
   docker exec betterdb curl http://localhost:11434/api/tags
   ```

   If using Docker networking:
   ```bash
   # Check DNS resolution
   docker exec betterdb ping ollama
   ```

3. **Check OLLAMA_BASE_URL:**
   ```bash
   docker exec betterdb env | grep OLLAMA
   ```

   Should show: `OLLAMA_BASE_URL=http://localhost:11434` (or correct URL)

### Models Not Found

**Symptoms:** Ollama is running but AI gives errors about missing models.

**Solutions:**

1. **List installed models:**
   ```bash
   ollama list
   ```

2. **Pull missing models:**
   ```bash
   ollama pull qwen2.5:7b
   ollama pull nomic-embed-text:v1.5
   ```

3. **If using Ollama in Docker:**
   ```bash
   docker exec betterdb-ollama ollama pull qwen2.5:7b
   docker exec betterdb-ollama ollama pull nomic-embed-text:v1.5
   ```

### Slow Responses

**Cause:** Large models running on CPU without enough resources.

**Solutions:**

1. **Check system resources:**
   ```bash
   # Monitor CPU/Memory while using AI
   docker stats betterdb-ollama
   ```

2. **Reduce model size:**
   ```bash
   # Use smaller model variant
   ollama pull qwen2.5:3b  # Smaller, faster
   ```

   Update BetterDB code to use `qwen2.5:3b` instead of `qwen2.5:7b`.

3. **Enable GPU acceleration:**

   For Ollama in Docker:
   ```yaml
   services:
     ollama:
       deploy:
         resources:
           reservations:
             devices:
               - driver: nvidia
                 count: 1
                 capabilities: [gpu]
   ```

4. **Increase keep-alive:**
   ```bash
   # Keep models loaded in memory longer
   -e OLLAMA_KEEP_ALIVE=24h
   ```

### AI Module Not Loading

**Symptoms:** No `[AI] Proprietary module loaded` in logs.

**Solutions:**

1. **Check you're using the WITH-AI image:**
   ```bash
   docker images betterdb/monitor
   # Should be ~800MB+ (not ~370MB)
   ```

2. **Verify AI_ENABLED:**
   ```bash
   docker exec betterdb env | grep AI_ENABLED
   # Should show: AI_ENABLED=true
   ```

3. **Check logs for module loading:**
   ```bash
   docker logs betterdb 2>&1 | grep -i "proprietary\|ai"
   ```

4. **Verify license tier:**
   ```bash
   curl -b cookies.txt http://localhost:3001/api/license/status
   ```

   > **Note**: API calls need a signed-in session when user control is enabled — see [Authenticating API Requests](configuration.md#authenticating-api-requests).

   AI requires Pro or Enterprise tier.

## Advanced Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_ENABLED` | `false` | Enable AI features |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_KEEP_ALIVE` | `24h` | Keep models loaded in memory |
| `AI_USE_LLM_CLASSIFICATION` | `false` | Use LLM for anomaly classification |
| `LANCEDB_PATH` | `./data/lancedb` | Vector database path for RAG |
| `VALKEY_DOCS_PATH` | `./data/valkey-docs` | Cached Valkey documentation |

### Model Keep-Alive

Controls how long models stay loaded in memory:

```bash
# Keep models loaded for 24 hours
OLLAMA_KEEP_ALIVE=24h

# Keep models loaded indefinitely
OLLAMA_KEEP_ALIVE=-1

# Unload immediately after each request (saves memory)
OLLAMA_KEEP_ALIVE=0
```

### Custom Models

To use different models, you'll need to modify the BetterDB source code:

**Chat Model** (`proprietary/ai/chatbot.service.ts`):
```typescript
this.llm = new ChatOllama({
  model: 'qwen2.5:7b',  // Change to your preferred model
  baseUrl: ollamaUrl,
  keepAlive: keepAlive,
});
```

**Embedding Model** (`proprietary/ai/vector-store.service.ts`):
```typescript
this.embeddings = new OllamaEmbeddings({
  model: 'nomic-embed-text:v1.5',  // Change to your preferred model
  baseUrl: ollamaUrl,
});
```

### Indexing Valkey Documentation

To enable RAG with Valkey documentation:

```bash
# From the repository root
npm run docs:index:valkey

# Or manually
node proprietary/ai/scripts/index-valkey-docs.js
```

This downloads and indexes the official Valkey documentation for RAG queries.

## Performance Tips

1. **Use GPU if available** - Significantly faster inference
2. **Keep models loaded** - Set `OLLAMA_KEEP_ALIVE=24h` or `-1`
3. **Allocate enough RAM** - 8 GB minimum, 16 GB recommended
4. **Monitor resource usage** - Use `docker stats` to track consumption
5. **Consider smaller models** - If responses are too slow on CPU

## Getting Help

If you encounter issues:

1. Check the [Troubleshooting](#troubleshooting) section above
2. Verify Ollama is running: `ollama list`
3. Check BetterDB logs: `docker logs betterdb`
4. Review [Ollama documentation](https://github.com/ollama/ollama/blob/main/docs/README.md)
5. Open an issue: [GitHub Issues](https://github.com/BetterDB-inc/monitor/issues)
