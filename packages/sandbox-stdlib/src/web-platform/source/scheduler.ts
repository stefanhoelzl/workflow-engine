// W3C Scheduler API polyfill — provides self.scheduler + TaskController +
// TaskSignal + TaskPriorityChangeEvent via scheduler-polyfill@^1.3.0
// (GoogleChromeLabs, Apache-2.0). Side-effect import: the upstream bundle
// self-installs on globalThis when scheduler is absent.
//
// Host surface: none. The bundle feature-detects MessageChannel and
// requestIdleCallback (both absent in this sandbox) and falls back to the
// already-allowlisted setTimeout bridge. See SECURITY.md §2.

import "scheduler-polyfill";
