# OpenCode Claude-Like Experience Design

## Goal

Make `happy opencode` behave much closer to `happy`/Claude:

- local terminal mode runs native `opencode`
- mobile activity can take over and switch the session into remote mode
- terminal can switch the session back to local mode
- mobile sees current mode and online/offline state clearly
- exits and reconnects use the same session lifecycle guarantees as Claude/Codex

## Current State

Today `happy opencode` is a thin command wrapper over the generic ACP runner:

- `handleOpencodeCommand()` resolves `opencode acp` and calls `runAcp()`
- `runAcp()` always behaves as a single remote-style runner
- there is no `local` vs `remote` state machine
- mobile cannot take over a native local `opencode` session because there is no local launcher to abort and hand off
- terminal cannot switch back from remote to native local mode
- mode metadata sent to the mobile app is much weaker than the Claude path

This is why OpenCode currently feels like "generic ACP integration" instead of a first-class Happy provider.

## Non-Goals

- Do not make local and remote modes share one exact native OpenCode internal session
- Do not redesign the generic ACP runner for all agents
- Do not attempt a protocol-level deep integration with undocumented OpenCode internals beyond what the current CLI and ACP entrypoints already expose

## Approach Options

### Option 1: Extend Generic ACP Runner

Keep `happy opencode -> runAcp()` and bolt on mode-switching behavior inside the generic ACP path.

Pros:

- smallest short-term diff
- reuses existing ACP code

Cons:

- local mode would still be simulated, not native
- would entangle generic ACP logic with OpenCode-specific UX
- still would not feel much like Claude

### Option 2: Dual-Track OpenCode Provider

Create an OpenCode-specific top-level runner with a Claude-style loop:

- local mode uses native `opencode` interactive CLI
- remote mode uses the existing ACP/Happy bridge
- mode switching happens at the Happy session layer

Pros:

- best Claude-like UX with acceptable risk
- keeps OpenCode-specific experience separate from generic ACP
- reuses existing remote ACP implementation instead of rewriting everything

Cons:

- larger implementation than Option 1
- local/remote modes do not share one native OpenCode backend session

### Option 3: Single Shared Native OpenCode Session

Both local and remote modes control the same native OpenCode session/process.

Pros:

- best theoretical consistency

Cons:

- depends on OpenCode capabilities we do not currently have
- much harder process/session orchestration
- high debugging cost

## Chosen Approach

Use Option 2.

This gives the closest practical match to Claude:

- native local terminal experience
- Happy-controlled remote mode
- explicit mode switching
- clear mode metadata for mobile
- bounded engineering risk

## Architecture

### New Top-Level OpenCode Flow

Replace the current direct `handleOpencodeCommand() -> runAcp()` flow with:

1. `handleOpencodeCommand()` authenticates, clears generic proxy env, ensures daemon
2. `runOpenCode()` creates the Happy session and OpenCode session metadata
3. `loopOpenCode()` runs a `local | remote` state machine
4. `opencodeLocalLauncher()` owns native terminal mode
5. `opencodeRemoteLauncher()` owns remote/mobile-controlled mode

The generic ACP runner remains available as an implementation detail for remote mode and for generic ACP commands.

### Proposed Files

- Create: `packages/happy-cli/src/opencode/runOpenCode.ts`
- Create: `packages/happy-cli/src/opencode/loop.ts`
- Create: `packages/happy-cli/src/opencode/opencodeLocalLauncher.ts`
- Create: `packages/happy-cli/src/opencode/opencodeRemoteLauncher.ts`
- Create: `packages/happy-cli/src/opencode/opencodeSession.ts`
- Create: `packages/happy-cli/src/opencode/opencodeLocal.ts`
- Create: `packages/happy-cli/src/opencode/opencodeRemote.ts`
- Create: `packages/happy-cli/src/opencode/opencodeLocalLauncher.test.ts`
- Create: `packages/happy-cli/src/opencode/opencodeRemoteLauncher.test.ts`
- Create: `packages/happy-cli/src/opencode/loop.test.ts`
- Modify: `packages/happy-cli/src/commands/opencodeCommand.ts`
- Modify: `packages/happy-cli/src/index.ts`
- Modify: `packages/happy-cli/src/agent/acp/runAcp.ts`

### Session Model

OpenCode will mirror the Claude high-level model:

- one Happy session per `happy opencode` process
- one Happy-facing mode field: `local` or `remote`
- one `controlledByUser` flag for mobile UX
- OpenCode local mode can be interrupted and switched, but is not required to share the exact same native internal conversation with ACP remote mode

This preserves the user-facing session while accepting different transport implementations underneath.

## Component Design

### `runOpenCode.ts`

Responsibilities:

- validate OpenCode CLI availability
- create API client, machine, and Happy session
- initialize session metadata with `flavor: 'opencode'`
- report session to daemon
- create shared session object used by local/remote launchers
- own process-level cleanup, signal handling, and final `session-end`

This file should be structurally similar to `runClaude.ts`, not `runAcp.ts`.

### `opencodeSession.ts`

Responsibilities:

- hold shared state for the OpenCode run
- expose `mode`, `path`, `sessionId`, queue, MCP server info, log path
- offer helpers for:
  - `onModeChange`
  - `onThinkingChange`
  - mobile message queue interaction
  - session end signaling

This is the OpenCode analogue of the Claude `Session` abstraction, but trimmed to only what OpenCode actually needs.

### `loop.ts`

Responsibilities:

- run the state machine:
  - start in `local` by default unless explicitly remote
  - `local -> remote` on mobile message or switch action
  - `remote -> local` on terminal-side switch action
  - `exit` on user exit
- invoke `onModeChange`

Expected launcher contract:

- local launcher returns `{ type: 'switch' } | { type: 'exit', code: number }`
- remote launcher returns `'switch' | 'exit'`

### `opencodeLocalLauncher.ts`

Responsibilities:

- launch native `opencode` interactive CLI in the terminal
- pass along any required Happy/OpenCode env vars
- treat incoming mobile message or explicit mobile switch request as a reason to:
  - set exit reason to `switch`
  - abort/terminate local OpenCode process
  - return control to the loop

Key behavior:

- native local OpenCode owns the terminal while active
- if a mobile message arrives, local mode does not try to process it inline
- local mode exits fast and hands off to remote mode

This mirrors Claude local mode semantics.

### `opencodeRemoteLauncher.ts`

Responsibilities:

- wrap the ACP-based remote behavior in a Claude-remote-style launcher
- provide terminal UI/status controlled by Happy
- allow terminal-side switch-back to local mode
- return `'switch'` or `'exit'`

Implementation note:

- this launcher should reuse the existing ACP remote path where possible
- OpenCode-specific mode switching should live here, not inside generic ACP behavior for all agents

## Mode Switching Rules

### Local -> Remote

Triggers:

- mobile sends a user prompt
- mobile requests a switch
- mobile requests abort while local mode is active

Behavior:

- mark exit reason as `switch`
- stop the local OpenCode process
- clear/normalize any local-only in-flight state
- update Happy session event to `switch: remote`
- update `controlledByUser = false`

### Remote -> Local

Triggers:

- terminal requests switch back to local mode

Behavior:

- stop the remote ACP runner
- return `'switch'`
- update Happy session event to `switch: local`
- update `controlledByUser = true`

### Exit

Both launchers must support full exit semantics:

- stop keepalive loop
- immediately signal session end to Happy
- flush and close the session best-effort
- stop MCP server / background process / backend resources

## Mobile State and Metadata

OpenCode should publish the same core mobile-facing state that Claude does:

- `switch` session events with `mode: local | remote`
- `controlledByUser` in agent state
- `thinking` keepalive mode updates
- archived lifecycle metadata on exit

Result:

- mobile app can show whether the session is currently local or remote
- mobile behavior during take-over is predictable
- stale online state after exit is minimized

## Error Handling

### Local Mode Failures

- if native OpenCode exits unexpectedly without a pending switch, surface a session message and return `{ type: 'exit', code }`
- if local exit was caused by an intentional switch, do not overwrite `switch` with raw process exit

### Remote Mode Failures

- keep the existing ACP shutdown protections:
  - stop keepalive immediately on exit
  - send `session-end` immediately
  - timeout abort if backend cancel hangs
  - finalize session close best-effort

### Startup Failures

- if `opencode` CLI is missing, fail fast with explicit install guidance
- if authentication/session creation fails, do not spawn local or remote launchers

## Testing Strategy

### Unit Tests

- `loop.test.ts`
  - starts in local mode
  - local message-triggered switch enters remote
  - remote switch action enters local
  - exit reasons propagate correctly

- `opencodeLocalLauncher.test.ts`
  - mobile message during local mode returns `switch`
  - local process exit during intentional switch does not override switch reason
  - explicit exit returns non-switch exit code

- `opencodeRemoteLauncher.test.ts`
  - terminal switch request returns `switch`
  - remote exit returns `exit`
  - cleanup path signals session end

- existing `runAcp.test.ts`
  - remains green for generic ACP behavior

### Integration Checks

Manual verification after implementation:

1. run `happy opencode`
2. verify terminal starts in native local mode
3. send message from mobile, verify terminal switches to remote mode
4. switch back from terminal, verify native local mode resumes
5. exit from both modes, verify mobile session goes offline

## Risks

### Session Continuity Risk

Because local native OpenCode and remote ACP do not share one native backend session, some provider-internal conversation continuity may differ across mode changes.

Mitigation:

- keep the same Happy session and metadata
- document this as an accepted limitation of phase 1
- optimize for user-facing mode behavior first

### Process Control Risk

Native OpenCode local mode may have different signal/TTY behavior than Claude.

Mitigation:

- isolate process management in `opencodeLocal.ts`
- use launcher tests to validate switch-vs-exit semantics
- add timeout-based cleanup similar to Codex/ACP shutdown hardening

## Rollout Plan

Phase 1 in this implementation:

- add OpenCode-specific top-level runner and loop
- add native local launcher
- wrap ACP remote mode in OpenCode remote launcher
- wire mode events and state
- preserve robust exit/offline semantics

Phase 2, if approved as a follow-up project:

- deeper OpenCode-specific remote UI polish
- improved continuity across local/remote switching
- richer OpenCode-native mode metadata if the provider exposes it

## Open Questions Resolved

- Use native OpenCode for local mode: yes
- Use Happy-controlled remote ACP mode: yes
- Accept dual-track implementation instead of one shared provider session: yes
- Match Claude across switching, state visibility, exits, and reconnects as closely as practical: yes
