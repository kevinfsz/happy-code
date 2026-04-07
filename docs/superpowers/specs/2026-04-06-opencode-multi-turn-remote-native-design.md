# OpenCode Multi-Turn Remote-Native Design

## Goal

Make `happy opencode` remote-native mode handle continuous mobile interaction more like `happy claude`:

- remote-native mode should not stop after a single queued mobile message
- new mobile messages should be processed promptly while remote-native mode remains active
- if a new mobile message arrives while a native `opencode` run is still active, Happy should interrupt that run and restart with fresher context
- short bursts of mobile messages should be coalesced to avoid restart thrash
- partial output already emitted before interruption should be preserved in terminal output and session context

## Current State

Current `opencodeRemoteNativeLauncher()` is a one-shot handoff:

1. wait for the first queued message
2. build one reconstructed prompt
3. run one native `opencode` process
4. return `'exit'` or `'switch'`

This means remote-native mode does not behave like a sustained remote session. If additional mobile messages arrive while the native run is active, they remain queued until that process ends and the launcher returns to the outer loop.

## Product Decisions

The user explicitly accepted:

- remote-native multi-turn behavior does not need to reuse one exact native `opencode` process
- each mobile interaction may start a fresh native `opencode` run
- if a new mobile message arrives during an active remote-native run, Happy should interrupt the current run and restart with updated context
- partial output from the interrupted run should be preserved, not rolled back
- short bursts of mobile messages should use a small coalescing window, recommended at 300-500ms

## Non-Goals

- Do not implement a single long-lived native `opencode` stdin conversation protocol
- Do not change `loop.ts` external contracts beyond continuing to return `'switch' | 'exit'`
- Do not redesign `runOpenCode()` session setup/cleanup flow
- Do not change CLI argument parsing for `happy opencode`
- Do not require true session migration inside OpenCode internals

## Chosen Approach

Use a restart-based multi-turn remote-native loop inside `opencodeRemoteNativeLauncher()`.

Each remote-native turn is one native `opencode` process:

1. collect the latest mobile message batch
2. reconstruct prompt from accumulated Happy-side context
3. start a native `opencode` run
4. if a newer mobile message arrives while that run is active, abort it
5. preserve any output already produced
6. start a fresh native run with the updated message batch and expanded context

This preserves Claude-like responsiveness without relying on undocumented multi-turn stdin semantics from `opencode`.

## Architecture

### Unchanged Boundaries

- `loop.ts` still treats remote mode as a launcher returning `'switch' | 'exit'`
- `runOpenCode.ts` still owns Happy session creation, shared queue wiring, reconnection setup, and final cleanup
- `OpenCodeSession` remains the source of ordered recent context used for continuation prompts

### Main Implementation Surface

Primary changes are isolated to:

- `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.ts`
- `packages/happy-cli/src/opencode/opencodeRemoteNativeLauncher.test.ts`

Secondary changes are allowed only if required by tests:

- `packages/happy-cli/src/opencode/opencodeRemoteNative.ts`
- one higher-level smoke test in `runOpenCode.test.ts` or `loop.test.ts`

## Remote-Native State Machine

`opencodeRemoteNativeLauncher()` becomes a small internal loop with these states:

- `idle`
  - wait for queued mobile input
- `coalescing`
  - briefly gather more queued mobile input before starting a run
- `starting`
  - build a continuation prompt from ordered recent context plus the current aggregated user batch
- `running`
  - native `opencode` is active; stdout/stderr continue flowing into terminal output and session context
- `restarting`
  - newer mobile input arrived while running; current native run is being aborted so a fresher run can start
- `switching`
  - terminal requested switch back to local mode; launcher must return `'switch'`
- `exiting`
  - terminal/session requested exit; launcher must return `'exit'`

The launcher still appears as one remote-mode invocation to the outer loop. The multi-turn behavior happens entirely inside the launcher.

## Queue and Coalescing Semantics

### Initial Batch

When remote-native mode is entered:

1. wait for the first available batch from `MessageQueue2`
2. enter a short coalescing window, default `400ms`
3. merge any additional queued mobile input that arrives in that window
4. use the merged text as the next `latestUserMessage`

### While Running

If additional mobile input arrives while a native run is already active:

1. mark `pendingRestart = true`
2. capture the freshest pending message batch
3. abort the active native run
4. preserve all output already emitted
5. after that run closes, enter a fresh coalescing window
6. start the next native run with the newest merged mobile batch

### Merge Policy

- merge only queued user-message batches, not assistant output
- use one short coalescing window before each native run
- if multiple new messages arrive during the active run, they collapse into the next restart cycle instead of causing repeated immediate restarts

This gives responsive behavior without restarting on every keystroke-sized burst.

## Prompt Reconstruction

Each new native run uses:

- `OpenCodeSession.buildRecentContext()` timeline
- the newest aggregated mobile message batch as `latestUserMessage`
- working directory from the session

The existing remote-native prompt builder remains the continuation mechanism:

- prior local and remote outputs stay in the ordered timeline
- partial assistant output from interrupted runs remains part of the context
- new native runs continue from the latest Happy-side understanding, not from an empty session

## Interrupt Semantics

### Newer Mobile Input

If the current native run is interrupted because newer mobile input arrived:

- this is not a failure
- `ExitCodeError(130)` and `ExitCodeError(143)` after restart commitment must be treated as expected interruption results
- the launcher should move into the next restart cycle, not bubble an error

### Switch / Exit Priority

`switch` and `exit` outrank restart behavior.

If terminal-side `switch` or `abort` happens while a restart is pending:

- do not start another native run
- abort the current run if needed
- return `'switch'` or `'exit'` as requested

This preserves mode-control guarantees from the current loop contract.

## Output and Context Handling

During each native run:

- stdout is written to terminal output and appended to assistant context
- stderr is written to terminal output and also appended to assistant context

If a run is interrupted by newer mobile input:

- previously emitted output remains visible
- previously emitted output remains in session context
- no rollback or deletion is attempted

This matches the accepted requirement that interrupted output should be preserved, only implicitly superseded by later turns.

## Cleanup Guarantees

When the launcher ends for any reason:

- unregister rpc handlers
- unregister client-change callbacks
- leave no active queue listener behind
- do not leave stale remote-native state that could cause phantom online behavior

`runOpenCode()` remains the single owner of final session death, metadata archival, flush, and close.

## Testing Plan

The minimum acceptance set is:

1. multi-turn sequential behavior
   - one mobile batch starts one native run
   - a later mobile batch after completion starts a second native run

2. running-time restart behavior
   - a new mobile batch during an active native run aborts the current run
   - interrupt exit codes after restart commitment resolve into continuation, not failure
   - the next native run starts with newer input

3. coalescing window behavior
   - multiple quick mobile messages produce one native run
   - the reconstructed prompt uses the merged latest message batch

4. `switch` / `exit` priority
   - pending restart never overrides explicit `switch`
   - pending restart never overrides explicit `exit`

5. cleanup/rebinding behavior
   - rpc handlers are rebound on client swap during remote-native mode
   - callbacks and handlers are removed on launcher exit

## Acceptance Criteria

This work is complete when:

- remote-native launcher tests cover the multi-turn restart and coalescing behaviors
- focused OpenCode tests pass for:
  - `opencodeRemoteNativeLauncher.test.ts`
  - `loop.test.ts`
  - `runOpenCode.test.ts`
- full OpenCode regression passes after implementation

## Risks

### Accepted Risk: One Process Per Turn

Remote-native still does not preserve one exact OpenCode process across turns. This is intentional and accepted.

### Remaining Operational Risk

Because this design preserves interrupted partial output, the session timeline may contain assistant text from runs that were cut off and superseded. That is acceptable for this phase and preferable to losing context entirely.

## Recommendation

Implement this as a focused extension of `opencodeRemoteNativeLauncher()` rather than another architecture rewrite.

The design gives the user the desired practical behavior:

- repeated mobile interaction in remote-native mode
- prompt interruption when fresher mobile input arrives
- Claude-like responsiveness

while keeping the engineering risk constrained to one launcher and its tests.
