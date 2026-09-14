# Generic systemd user-service templates

These templates are examples, not installed machine configuration. Copy them to
`~/.config/systemd/user/` only after reviewing the local runtime and protected
configuration paths. Never commit the resulting units, profiles, YAML, or env files.

The Gateway unit starts the packaged `firstmate-gateway-remote` entry point from the
stable `~/.local/share/firstmate-gateway/active` pointer. The tunnel unit starts the
official `tunnel-client run` command with a local profile. The profile must use the
client's `env:NAME` or `file:/path` secret-reference syntax; do not put keys in a unit
or command line.

Both services use bounded `Restart=on-failure` policies. The tunnel has an explicit
`Requires`/`After` dependency on the Gateway so it is not started against an absent
local endpoint. Stopping either unit does not invoke Gateway tools and cannot replay a
prompt.
