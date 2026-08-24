# opencode-go-multi

`opencode-go-multi` is an OpenCode V1 plugin that selects an available OpenCode Go
API key in configured priority order. It extends the built-in `opencode-go` provider;
it does not create a replacement provider or change OpenCode's model catalog.

## Compatibility

This release is tested and supported only with OpenCode **1.18.19** and the V1
plugin API from `@opencode-ai/plugin` **1.18.19**. The package is built against
`@opencode-ai/plugin 1.18.19`.

The server target uses the supported V1 plugin API. The optional TUI target uses
the OpenCode V2 TUI plugin API and is loaded separately from the server target.

The server and TUI targets are exclusive: do not register the package root as a
TUI plugin or the `./tui` target as a server plugin.

The OpenCode V2 server/plugin API remains unsupported; only the separate `./tui`
target uses the V2 TUI API required for native modal rendering.

The usage check uses `GET /zen/go/v1/usage`. This route is source-backed but
undocumented in the public Go endpoint documentation, so an upstream route or
schema change can make a key temporarily unavailable. The plugin validates the
response before selecting a key.

## Installation

The examples below use a local directory or a local npm tarball. They do not
require a package registry.

### Local directory

From a checkout of this project, build the package:

```sh
bun install --frozen-lockfile
bun run build
```

Use the absolute path to that checkout as the string plugin entry in the
environment-only configuration below. OpenCode loads the package's built entry
point from the directory. Replace `<ABSOLUTE_PLUGIN_PATH>` with the directory
containing this package.

### npm tarball

Create a tarball locally, then install that exact file in the consumer that runs
OpenCode:

```sh
npm pack --json
mkdir -p <ABSOLUTE_CONSUMER_DIR>
cd <ABSOLUTE_CONSUMER_DIR>
npm init -y
npm install <ABSOLUTE_TARBALL_PATH>
```

Point OpenCode at the installed package directory, for example
`<ABSOLUTE_CONSUMER_DIR>/node_modules/opencode-go-multi`. The package is local in
this workflow; creating a tarball does not imply registry publication.

## Configuration (V1)

There are two supported V1 configuration tuples. The plugin entry is a string for
environment-only configuration, or a two-item tuple `[path, options]` when using
literal options.

### Environment-only (recommended)

Keep key material out of `opencode.json` and provide a comma- or newline-separated
environment variable to the OpenCode process:

```sh
export OPENCODE_GO_API_KEYS='<GO_API_KEY_1>,<GO_API_KEY_2>'
```

Then use a string plugin entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["<ABSOLUTE_PLUGIN_PATH>"]
}
```

### Explicit `options.keys`

The V1 tuple carries a non-empty string array as its second item:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "<ABSOLUTE_PLUGIN_PATH>",
      {"keys": ["<GO_API_KEY_1>", "<GO_API_KEY_2>"]}
    ]
  ]
}
```

Explicit options.keys replaces environment keys when the `keys` property is
present. It does not supplement or merge with `OPENCODE_GO_API_KEYS`. Each key must be a
string. Blank entries are removed and duplicates are de-duplicated while
preserving order. If no explicit `keys` property is present, the environment
variable is required and is split on commas and newlines. There is no automatic
key or account creation.

Literal option keys remain plaintext in `opencode.json` and may be copied into
backups, logs, or source control. Prefer the environment-only form, protect the
process environment, and rotate/revoke exposed keys through the account's normal
controls. Keys are held in memory by this plugin; selector state is not persisted.

### Plugin ordering

OpenCode evaluates the V1 `plugin` array in order. Later plugins can overwrite
headers. Put this plugin last when other plugins also modify request headers. The
plugin only changes `Authorization` for requests whose model provider is exactly
`opencode-go`; unrelated providers and other headers are left alone.

## Commands

The plugin registers two V1 commands through `config.command`:

- `/ogm-usage` probes every configured key and prints a readable section for
  each safe `key[1]`, `key[2]`, ... label. Every rolling, weekly, and monthly
  window shows both remaining and used percentage, status, and reset timestamp.
  Credentials and upstream response bodies are never included.
- `/ogm-switch` advances the manual priority cursor with wraparound. The next
  request starts at that key, then continues through the remaining keys with the
  normal automatic quota and outage failover rules.

Existing command definitions are preserved. The commands are handled by the V1
`command.execute.before` hook and publish a safe encoded event. To display the
result in a dismissable native modal, register the pinned V1 server target in
`opencode.json` and the optional V2 TUI target in `tui.json`. Both use the same
package directory; OpenCode resolves the `./tui` export for the TUI target:

`opencode.json` (V1 server target):

```json
{"plugin": ["<ABSOLUTE_PLUGIN_PATH>"]}
```

`tui.json` (optional V2 modal target):

```json
{"plugin": ["<ABSOLUTE_PLUGIN_PATH>"]}
```

Without the TUI target, the server command still probes and publishes its safe
event, but no modal is rendered. The TUI target rejects malformed or oversized
payloads and only renders redacted command output.

## Selection, cache, and quotas

Selection is proactive and ordered, not load balancing:

1. Keys are checked in the order supplied by `options.keys` or the environment.
2. The first key whose rolling, weekly, and monthly usage windows are all `ok` is
   selected and remains preferred while its snapshot is fresh.
3. A successful usage snapshot is cached for 30 seconds. Exhaustion detection can
   therefore lag by up to 30 seconds.
4. If any usage window is `rate-limited`, that key is skipped until the latest
   limited window's `resetsAt` (with a one-second safety skew), then lazily
   re-probed. A reset reopens the key; no background timer is required.
5. A previously eligible key may be used for at most five minutes during a
   transient usage-probe outage (timeout, network failure, bad status, or bad
   response). A never-probed key has no stale fallback. After that grace period,
   selection fails closed.

The Go service documents a $12 rolling (five-hour) limit, a $30 weekly limit, and
a $60 monthly limit. Request counts are estimates, not quota units.
Keys from the same OpenCode Go subscription share rolling, weekly, and monthly quotas and do not extend capacity.
More literals in a configuration therefore do
not multiply a subscription's allowance; use the account/subscription controls
provided by OpenCode.

There is no same-request or partial-stream retry. If an inference request has
started or a response is being streamed, this plugin does not splice in another
key. Rotation happens at the next request-preparation boundary after a usage
check.

When the plugin is disposed, its in-memory selector cache and reset state are
cleared. The next request starts a fresh ordered probe sequence.

## Safe errors

Credentials are never included in error text, serialized error objects, or the
key labels in aggregate diagnostics. Typical failures are:

- `OPENCODE_GO_CONFIG_INVALID`: `options.keys` is not a non-empty string array,
  or contains no non-blank key after normalization.
- `OpenCode Go key configuration error` with a missing-keys detail:
  `OPENCODE_GO_API_KEYS` was not provided or contained no usable value.
- `OPENCODE_GO_ALL_KEYS_UNAVAILABLE`: no configured key can currently be selected.
  Entries use safe labels such as `key[1]` and reasons such as
  `rate-limited`, `unauthorized`, `no-entitlement`, `probe-failed`, or
  `no-stale-snapshot`. A safe `retry-at` timestamp is included when a reset is
  known.

For usage probes, HTTP 401 means `unauthorized`, HTTP 403 means
`no-entitlement`, and timeout/network/status/JSON/schema failures mean
`probe-failed`. A rate-limited rolling, weekly, or monthly window means
`rate-limited`. These meanings describe the selection decision; they do not
expose upstream response bodies.

## Troubleshooting

### The plugin does not load

Use an absolute local plugin path, confirm `bun run build` completed, and check
that the package directory contains `dist/index.js` and `package.json`. Verify
that the plugin entry is in the V1 `plugin` array and is last if another plugin
also edits headers. This package is pinned to OpenCode 1.18.19 V1; other runtime
versions are outside the supported compatibility contract.

### Configuration is rejected

For environment configuration, inspect the environment of the OpenCode process
(not only the shell where it was configured) and ensure the variable contains at
least one non-blank value. Commas and newlines delimit keys. For a tuple, ensure
the second item is an object with `keys` as a non-empty array of strings. Remember
that an explicit `options.keys` property replaces the environment list.

### A key is skipped or all keys are unavailable

Check the safe reason and `retry-at` timestamp. Any one of the rolling, weekly, or
monthly windows can make a key ineligible. A 401 usually means the key is invalid
or revoked; 403 means the account lacks Go entitlement. A probe outage can use a
last-known-good key only for five minutes, and usage results can be up to 30
seconds old because of the cache. After a reported reset, the key is re-probed
lazily on a later request.

### Requests reach the provider but use the wrong credential

Ensure this plugin is last in the `plugin` array. Later plugins can overwrite
headers. Confirm the model's provider is exactly `opencode-go`; this plugin does
not alter other providers. Do not put real keys in diagnostics while investigating.

### The usage route fails

The `GET /zen/go/v1/usage` route is source-backed but undocumented. Confirm the
provider base URL and network access, then allow for a three-second usage probe
timeout. A route/schema change is surfaced as the safe `probe-failed` reason. The
plugin does not retry an already-started or partial stream.

## Scope and security boundaries

This package rotates credentials only at V1 request preparation for the built-in
OpenCode Go provider. It does not edit OpenCode's auth store, generate or revoke
keys, create accounts, bypass quota enforcement, persist credentials, or combine
capacity across subscriptions.
