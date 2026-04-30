import { register } from "node:module";

// Custom loader for non-standard import attributes / stubbed file types
// (.scm grammars, .wasm binaries imported by @opentui/core, etc.).
// tsx is registered separately via the --import flag in bin/ash because
// it requires --import (not register()) to install its hooks.
register("./loader.mjs", import.meta.url);
