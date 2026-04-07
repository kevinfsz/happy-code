# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Happy is an end-to-end encrypted remote control system for AI coding agents (Claude Code, Codex). Users control their AI coding sessions from mobile apps (iOS/Android), web, or desktop. The server stores only opaque encrypted blobs — it cannot decrypt user data.

## Monorepo Structure

Yarn workspaces monorepo with these packages:

- **happy-app** — React Native + Expo mobile/web/desktop client
- **happy-cli** — Node.js CLI wrapping Claude Code/Codex with remote control (published as `happy` on npm)
- **happy-agent** — Remote agent control CLI (published as `happy-agent` on npm)
- **happy-server** — Fastify + Prisma backend for encrypted sync
- **happy-wire** — Shared Zod schemas and wire types (published as `@slopus/happy-wire`)

Each package has its own `CLAUDE.md` with package-specific conventions and architecture — read them before working in that package.

## Common Commands

```bash
yarn install                      # Install all dependencies
yarn web                          # Run web app (shortcut)
yarn cli                          # Run CLI (shortcut)

# Environment management (local dev with coordinated server + app)
yarn env:new                      # Create new dev environment
yarn env:use                      # Switch environment
yarn env:up                       # Start all services
yarn env:down                     # Stop all services
yarn env:server                   # Run server in current env
yarn env:web                      # Run web app in current env
yarn env:cli                      # Run CLI in current env

# Per-package commands
yarn workspace happy-app start    # Expo dev server
yarn workspace happy-app typecheck # TypeScript check (run after all app changes)
yarn workspace happy-cli test     # Run CLI tests
yarn workspace happy-cli build    # Build CLI
yarn workspace happy-server standalone:dev  # Local server with embedded PGlite (no Docker needed)
yarn workspace happy-server test  # Run server tests
```

## Architecture

### Data Flow

1. **Authentication**: Keypair-based challenge-response (no passwords). Private key in `~/.happy/access.key`.
2. **Session Creation**: CLI creates encrypted session → server stores opaque blob → WebSocket established
3. **Message Flow**: User input → CLI encrypts → Server forwards → Mobile decrypts. All via Socket.IO with monotonic sequence numbers.
4. **RPC-over-WebSocket**: Remote file ops, bash, search — all via RPC, not REST.

### Key Subsystems

- **Real-time sync**: Socket.IO with monotonic per-user sequence counters. Persistent updates (with seq) and ephemeral events (presence). Clients apply updates in order.
- **E2E Encryption**: Client-side libsodium (mobile) / TweetNaCl (CLI). Per-session encryption keys. Server never sees plaintext.
- **Optimistic concurrency**: Versioned fields with `expectedVersion` on updates. Client-driven conflict resolution.
- **Daemon (CLI)**: Background process managing sessions, machine registration, and WebSocket connections.
- **Dual-mode operation**: Interactive (terminal PTY) and remote (mobile control via daemon).

### External Dependencies (production only)

- PostgreSQL + Redis + S3/MinIO. Local dev uses embedded PGlite — no Docker needed.

## Cross-Package Conventions

- **TypeScript strict mode** everywhere. No untyped code.
- **4 spaces** for indentation (not 2).
- **Absolute imports** with `@/` path alias mapping to the `src/` or `sources/` directory.
- **Functional patterns** — avoid classes, prefer functions and interfaces.
- **Vitest** for testing. Test files colocated with source (`.test.ts` or `.spec.ts`).
- **Yarn** for package management (not npm).
- **Zod** for runtime validation.

## Package-Specific Rules

### happy-app
- Use `t()` for ALL user-visible strings (9 languages). Add new strings to ALL language files in `sources/text/translations/`.
- Use `StyleSheet.create` from `react-native-unistyles` for all styling.
- Never use React Native `Alert` — use `@/modal` instead.
- Always wrap pages in `memo`. Put styles at end of file.
- Use expo-router API, not react-navigation.

### happy-cli
- ALL imports at top of file — never mid-code.
- File-based logging only (never console.log during Claude sessions).
- Tests make real API calls — no mocking.

### happy-server
- Use `inTx` for database transactions, `afterTx` for post-commit events.
- Never create Prisma migrations yourself.
- Use `privacyKit.decodeBase64/encodeBase64` instead of Buffer.
- All API operations must be idempotent.
- Validate inputs with Zod.

## Documentation

Comprehensive architecture docs in `docs/`:
- `backend-architecture.md`, `cli-architecture.md` — system design
- `protocol.md` — wire protocol and sequencing
- `encryption.md` — encryption boundaries
- `session-protocol.md` — encrypted chat event protocol
- `CONTRIBUTING.md` — PR guidelines and contribution priorities
