# pi-reversa

Pi Coding Agent integration for the [Reversa](https://www.npmjs.com/package/reversa) reverse-engineering framework.

## Install

```bash
pi install pi-reversa
```

For development from this checkout:

```bash
pi install /path/to/pi-reversa
```

The package loads:

- `extensions/reversa.js`: native aliases for the packaged `/reversa-*` skills, including `/reversa-autonomous` for unattended discovery.
- Reversa skills copied into `packaged-skills/` from the installed `reversa` dependency during tests and packaging. The Reversa CLI is installation/maintenance-only; this plugin does not invoke a nonexistent `reversa run` command.

After changing the extension or skills, run `/reload` in Pi.
