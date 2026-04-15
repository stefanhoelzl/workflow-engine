const noop = () => {};
const handler = { get: () => selfProxy, apply: () => selfProxy };
const selfProxy = new Proxy(noop, handler);

export const z = selfProxy;
export function http() { return selfProxy; }
export function env() { return ""; }
export function createWorkflow() {
  const b = {
    trigger: () => b,
    event: () => b,
    // Mirrors @workflow-engine/sdk's action(): wraps the author's handler
    // so ctx.emit dispatches to the per-run globalThis.emit installed by the
    // runtime. Authors write `await ctx.emit(type, payload)`; this shim makes
    // that work inside the bundled sandbox code.
    action: (config) => {
      const userHandler = config.handler;
      return (ctx) => {
        const boundCtx = {
          ...ctx,
          emit: (type, payload) => {
            const g = globalThis;
            if (typeof g.emit !== "function") {
              throw new Error(
                "emit is not installed; the runtime must register it as an extraMethod",
              );
            }
            return g.emit(type, payload);
          },
        };
        return userHandler(boundCtx);
      };
    },
    compile: noop,
  };
  return b;
}
export const ENV_REF = Symbol("env");
export const ManifestSchema = selfProxy;
