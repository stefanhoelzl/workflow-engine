// Private dispatcher descriptor name — the guest IIFE captures it into the
// locked `__mail` global, then Phase-3 deletion removes it from globalThis
// so tenant code never sees the raw bridge.
const MAIL_DISPATCHER_NAME = "$mail/send";

export { MAIL_DISPATCHER_NAME };
