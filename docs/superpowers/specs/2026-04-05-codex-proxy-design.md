# Codex Proxy Switching Design

## Goal

Allow `happy codex` to keep Happy's own auth and app-link flow on a direct connection, while launching the Codex child process with a proxy configured through an environment variable.

## Requirements

- Happy CLI must not enable a proxy for its own requests to the Happy server during auth, machine setup, session creation, or app linking.
- When Happy launches `codex app-server`, it should read an optional `HAPPY_CODEX_PROXY` environment variable.
- If `HAPPY_CODEX_PROXY` is set to a valid proxy URL, Happy should inject it into the Codex child process environment as `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and lowercase equivalents.
- If `HAPPY_CODEX_PROXY` is missing, behavior must remain unchanged.
- If `HAPPY_CODEX_PROXY` is invalid, Happy should log a warning and continue without injecting proxy variables.

## Design

The proxy switch point will live entirely inside the Codex child-process launcher in `packages/happy-cli/src/codex/codexAppServerClient.ts`. This is the narrowest point in the call chain where Happy is finished talking to the Happy backend and is about to hand control to `codex app-server`.

The implementation will build the child environment from `process.env` as it does today, then optionally layer proxy variables on top if `HAPPY_CODEX_PROXY` passes validation. Validation will use the built-in `URL` parser and require an explicit `http:`, `https:`, `socks5:`, or `socks5h:` scheme so malformed values do not silently poison the Codex launch environment.

## Testing

- Add a test proving `HAPPY_CODEX_PROXY` is injected into the spawned Codex environment.
- Add a test proving no proxy variables are injected when `HAPPY_CODEX_PROXY` is unset.
- Add a test proving invalid proxy values are ignored and only emit a warning.

## Notes

- No user-facing config file changes are needed for this version.
- No changes are needed in auth, daemon boot, or session setup paths.
