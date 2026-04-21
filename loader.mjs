// Handles file types that Node.js ESM cannot load natively.
// @opentui/core imports Tree-sitter .scm grammar files and .wasm binaries
// using non-standard import attributes — stub them out so the CLI works.

const STUB_EXTENSIONS = ['.scm', '.wasm'];

export async function resolve(specifier, context, nextResolve) {
  // Strip unsupported import attributes (e.g. { type: "file" } used by @opentui/core).
  const { importAttributes: _attrs, ...rest } = context;
  return nextResolve(specifier, rest);
}

export async function load(url, context, nextLoad) {
  if (STUB_EXTENSIONS.some((ext) => url.endsWith(ext))) {
    return { format: 'module', shortCircuit: true, source: 'export default null;' };
  }
  return nextLoad(url, context);
}
