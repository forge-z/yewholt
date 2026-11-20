# Relay bundle

`compose.yml` is a verbatim copy of `deploy/compose/compose.yml` from
[block/buzz](https://github.com/block/buzz) at commit
`f9b18c7f3a55b5ffcef33686cd766c34257c1956` (2026-11-20).

Yewholt does not modify the Buzz relay. `yewholt install` copies this file
next to a generated `.env` and runs it with Docker Compose, which is the
single-node path documented in `deploy/compose/README.md`. The image pin
inside the file is `ghcr.io/block/buzz:0.3.0`.
