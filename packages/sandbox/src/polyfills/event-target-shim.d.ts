// Ambient declaration for event-target-shim@6. The package ships types at
// ./index.d.ts but its package.json `exports` field doesn't expose a `types`
// condition, so TypeScript (with moduleResolution: nodenext) fails to resolve
// them. Declaring the module here pins the surface we actually use.

declare module "event-target-shim" {
	const EventTarget: any;
	const Event: any;
	export { Event, EventTarget };
}
