## ADDED Requirements

### Requirement: PluginSetup onPost hook

The sandbox package SHALL extend `PluginSetup` with an optional `onPost` hook invoked against every `WorkerToMain` message before it is posted from the worker to the main thread.

```ts
type PluginSetup = {
  // ... existing fields
  onPost?: (msg: WorkerToMain, ctx: RunContext) => WorkerToMain;
};
```

The sandbox core SHALL invoke every plugin's `onPost` (if defined) inside `post()` in `packages/sandbox/src/worker.ts`, in plugin topological order (same order as other lifecycle hooks). Each hook receives the (possibly already transformed) message from the previous hook, may transform it, and returns the message to pass to the next hook or to the actual postMessage call.

Plugins implementing `onPost` SHALL have a documented cross-cutting rationale; this hook is a scarce resource because it sees every outbound message.

#### Scenario: onPost runs against events

- **GIVEN** a plugin with `onPost: (msg) => ({ ...msg, marker: "touched" } as any)`
- **WHEN** any `event` message is posted from the worker
- **THEN** the plugin's `onPost` SHALL be invoked with the message
- **AND** the returned message SHALL be the one actually posted to main

#### Scenario: onPost runs against done messages

- **GIVEN** the same plugin
- **WHEN** the handler settles and the worker posts a `done` message
- **THEN** the plugin's `onPost` SHALL be invoked with the done message
- **AND** the returned message SHALL be posted

#### Scenario: onPost runs against log messages

- **GIVEN** the same plugin
- **WHEN** a `log` message is posted from the worker
- **THEN** the plugin's `onPost` SHALL be invoked with the log message
- **AND** the returned message SHALL be posted

#### Scenario: Multiple onPost plugins run in topological order

- **GIVEN** plugins A, B, C with `A → B → C` topological order by `dependsOn` and each implementing `onPost` that records the message
- **WHEN** a message is posted
- **THEN** A's `onPost` SHALL be invoked first with the original message
- **AND** B's `onPost` SHALL be invoked with A's returned message
- **AND** C's `onPost` SHALL be invoked with B's returned message

#### Scenario: Plugin without onPost is skipped

- **GIVEN** a plugin that does not define `onPost`
- **WHEN** a message is posted
- **THEN** the sandbox SHALL skip that plugin in the `onPost` pipeline
- **AND** message posting SHALL not throw

#### Scenario: onPost not invoked for ready or init-error

- **GIVEN** any plugin with `onPost` defined
- **WHEN** the worker posts a `ready` or `init-error` message during sandbox init
- **THEN** `onPost` MAY or MAY NOT run; the sandbox core SHALL document whether it applies these hooks to init-time messages, and MUST be consistent across implementations. (Recommended: `onPost` applies to all `WorkerToMain` messages for uniformity.)
