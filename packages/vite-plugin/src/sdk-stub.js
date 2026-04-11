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
    action: (config) => config.handler,
    compile: noop,
  };
  return b;
}
export const ENV_REF = Symbol("env");
export const ManifestSchema = selfProxy;
