# OpenCode Native Remote Design

## Goal

Make `happy opencode` behave closer to `happy claude` across both local and remote modes:

- local terminal mode runs native `opencode`
- mobile takeover switches into a remote mode that also avoids ACP
- terminal output in remote mode is still managed by Happy, similar to Claude
- switching between local and remote preserves useful context, even if it does not reuse one exact native process
- exits, cleanup, daemon state, and mode metadata remain consistent

## Current State

Today `happy opencode` has a split architecture:

- local mode runs native `opencode`
- remote mode uses the generic ACP runner
- mobile messages trigger a switch out of local mode, but remote behavior is still ACP-shaped
- the mobile takeover experience does not match Claude because the remote side is not a native OpenCode runner

This means the session looks half-native and half-generic. The user-visible result is better than pure ACP, but still not "OpenCode with Claude-like takeover semantics".

## Product Constraints

The user explicitly accepted these constraints:

- remote mode must not use ACP
- the target is Claude-like behavior, not necessarily the exact same underlying process/session
- when switching from local to remote, it is acceptable to start a new remote-native OpenCode run as long as Happy reconstructs enough context
- once in remote mode, the terminal should keep showing Happy-managed status/output rather than going mostly silent

## Non-Goals

- Do not require local and remote to share one exact native OpenCode process
- Do not require true session migration inside undocumented OpenCode internals
- Do not keep the current remote ACP runner as the main implementation path for `happy opencode`
- Do not redesign Claude, Codex, or generic ACP behavior unless required for shared infrastructure

## Approach Options

### Option 1: Keep Remote ACP and Improve the Wrapper

Continue using native local mode plus ACP remote mode, and only make the UI and mode transitions feel more Claude-like.

Pros:

- smallest change
- preserves current remote implementation

Cons:

- still violates the user requirement that remote mode should not be ACP
- still leaves OpenCode as a mixed transport integration

### Option 2: Local Native + Remote Native with Context Reconstruction

Keep local mode native. Replace remote ACP mode with a new remote-native OpenCode runner that starts its own native OpenCode process when takeover happens. Happy reconstructs recent session context and injects it into the remote-native run.

Pros:

- matches the user requirement
- gets much closer to Claude behavior
- avoids depending on undocumented shared-session process control
- fits the accepted constraint that behavior may match even if the underlying session is rebuilt

Cons:

- requires new remote-native bridge logic
- context continuity is approximate rather than a true process handoff

### Option 3: Single Shared Native OpenCode Session

Try to make local and remote operate over the same native OpenCode process or internal session.

Pros:

- best theoretical continuity

Cons:

- highest engineering risk
- likely blocked on undocumented OpenCode capabilities
- difficult to make reliable

## Chosen Approach

Use Option 2.

This is the highest-confidence design that satisfies the requirement that remote mode must not use ACP while still remaining implementable in the current codebase.

## Architecture

### Top-Level Flow

`happy opencode` should be structured as:

1. `handleOpencodeCommand()`
2. `runOpenCode()`
3. `loopOpenCode()`
4. `opencodeLocalLauncher()` for local native mode
5. `opencodeRemoteNativeLauncher()` for remote native mode

The existing `local | remote` loop remains the right abstraction. The key change is replacing the ACP-backed remote launcher with a native remote launcher.

### Shared Session Object

`OpenCodeSession` remains the shared state container for one Happy session. It should own:

- current mode: `local | remote`
- Happy session client
- message queue
- working directory and log path
- local command/args
- remote command/args
- recent conversation/context buffer used for reconstruction
- callbacks for mode changes and client swaps

The session object is the stable Happy-facing shell. Local and remote native runs are execution strategies inside that shell.

### New Remote-Native Layer

Add a new component:

- `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts`

Responsibilities:

- run a native OpenCode process for remote mode
- feed it reconstructed context and future user prompts
- translate its output into Happy session messages and terminal status lines
- support switch back to local mode
- support cleanup and failure semantics that match the loop contract

The old ACP-based remote launcher should stop being the main path for `happy opencode`. It may remain in the tree temporarily if useful during migration, but the loop must no longer select it for the user-facing OpenCode flow.

## Context Reconstruction Strategy

The design explicitly does not require preserving one exact native OpenCode session. Instead, Happy reconstructs enough context to make remote takeover feel continuous.

### Inputs to Reconstruction

When switching from local to remote-native, Happy builds a continuation payload from:

- recent user messages in the Happy session
- recent assistant-visible output captured by Happy
- working directory and relevant run metadata
- current mode/state markers
- an explicit continuation instruction telling remote-native mode that it is resuming an in-progress session after local terminal takeover

### What Not to Replay

Do not dump raw terminal output wholesale into the remote-native prompt. That would introduce too much noise and brittle UI text.

Instead use:

- structured recent messages where available
- a compact summary for local-only output when needed
- minimal system framing for continuation semantics

### Continuation Contract

Remote-native mode should receive a prompt shaped like:

- this session started in local OpenCode mode
- mobile takeover has occurred
- continue the active task
- here is the recent relevant context
- here is the latest user message to answer

This should behave like a resume, even if under the hood it is a fresh native invocation.

## Mode Semantics

### Local Mode

Local mode continues to run native `opencode` in the terminal.

Behavior:

- terminal belongs to the native process
- mobile message arrival is a takeover signal
- local process is aborted/interrupted
- if the exit happened because of a switch, the launcher must return `switch`, regardless of the exact interrupt exit code

This preserves the current local-native experience and hardens it against OpenCode-specific interrupt exit codes.

### Remote-Native Mode

Remote mode runs a native OpenCode process, but the terminal presentation is controlled by Happy.

Behavior:

- Happy owns terminal status/output in remote mode
- mobile prompts are forwarded into the remote-native runner
- terminal can request switch back to local mode
- output shown in terminal should feel similar to Claude remote mode rather than a raw ACP event stream

The terminal should remain useful and informative in remote mode, not just show "remote active".

## Switching Rules

### Local -> Remote

Trigger:

- mobile sends a prompt
- or explicit switch request occurs

Steps:

1. mark target mode as `remote`
2. interrupt local native OpenCode
3. collect continuation context
4. start remote-native launcher
5. update mode metadata and `controlledByUser`
6. continue processing mobile prompts through remote-native mode

### Remote -> Local

Trigger:

- terminal requests switch back to local mode

Steps:

1. stop the remote-native runner cleanly
2. mark target mode as `local`
3. start a fresh local native OpenCode process
4. update mode metadata and `controlledByUser`

### Exit

No matter which mode is active:

1. stop keepalive
2. send final session-end/death state
3. archive metadata
4. stop the active local or remote process
5. release daemon-visible active-session tracking

The daemon must not retain stale online sessions after exit.

## Error Handling

### Switching Interrupts

If a local or remote native process is interrupted because of a mode switch, that must not be treated as a real failure.

Rule:

- once the launcher has committed to `switch`, later interrupt-style exit codes must not overwrite that reason

This rule already matters in local mode and must also apply to the future remote-native launcher.

### Real Failures

Treat these as actual failures:

- native OpenCode startup failure
- context reconstruction failure that prevents remote-native start
- remote-native runner exits unexpectedly without an active switch reason
- message transport failure that leaves the remote-native runner unusable

These should surface clearly in terminal output and should still trigger final cleanup.

## Testing Strategy

At minimum, add or update tests for:

1. `local -> remote-native` on mobile message without CLI flash-exit
2. `remote-native -> local` on terminal switch
3. context reconstruction payload creation
4. message forwarding into remote-native mode
5. mode metadata updates for mobile UX
6. session client swap/reconnection rebinding
7. exit cleanup with no stale daemon session
8. interrupt exit codes during switch being treated as `switch`, not `exit`

## Migration Plan Shape

The likely implementation sequence is:

1. add a remote-native launcher skeleton beside the existing remote launcher
2. add context reconstruction buffer to `OpenCodeSession`
3. route the loop to remote-native instead of ACP
4. translate remote-native output into Happy terminal/mobile events
5. remove user-facing dependence on ACP for `happy opencode`
6. run cleanup and lifecycle regressions

## Risks

### Native OpenCode Surface Area

OpenCode may not expose a stable documented interface for all remote-native behaviors. The implementation should therefore bias toward:

- minimal assumptions
- explicit adapters around command invocation and output parsing
- isolated fallback points

### Continuity Quality

Because remote mode will be reconstructed rather than truly resumed, context quality depends on how well Happy captures and compresses recent state. This should be treated as a first-class design concern, not an afterthought.

### Terminal UX Drift

If remote-native terminal output is too thin or too noisy, the experience will still feel worse than Claude. The remote-native launcher should therefore define clear output formatting rules instead of dumping raw process text.

## Open Questions Deferred from This Spec

These are deliberately left to the implementation plan, not this design:

- exact wire format for reconstructed context
- exact parser/adapter for remote-native OpenCode output
- whether a small compatibility shim is needed to normalize native OpenCode interrupt exit codes

The high-level product and architecture direction is fixed by this spec. These remaining details are implementation-level choices.
