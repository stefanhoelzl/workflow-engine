import "@workflow-engine/sandbox-globals-setup";
import { newMockXhr } from "mock-xmlhttprequest";
import { fetch, Headers, Request, Response } from "whatwg-fetch";
import "url-polyfill";
import "fast-text-encoding";
import "abort-controller/polyfill";
// blob-polyfill's UMD wrapper detects the CommonJS `exports` object created by
// our bundler and installs Blob/File onto that private exports rather than
// onto the IIFE's `global` argument — so a plain side-effect import leaves
// globalThis.Blob undefined. Import the names explicitly and re-export them.
import { Blob, File } from "blob-polyfill";
import { atob, btoa } from "abab";
import structuredClone from "@ungap/structured-clone";
import { ReadableStream, WritableStream, TransformStream } from "web-streams-polyfill";

var MockXhr = newMockXhr();
MockXhr.onSend = function(request) {
  var headers = request.requestHeaders.getHash();
  globalThis.__hostFetch(request.method, request.url, headers, request.body).then(
    function(result) {
      request.respond(result.status, result.headers, result.body, result.statusText);
    },
    function() {
      request.setNetworkError();
    }
  );
};
globalThis.XMLHttpRequest = MockXhr;
globalThis.fetch = fetch;
globalThis.Headers = Headers;
globalThis.Request = Request;
globalThis.Response = Response;
globalThis.atob = atob;
globalThis.btoa = btoa;
globalThis.Blob = Blob;
globalThis.File = File;
globalThis.structuredClone = structuredClone;
globalThis.ReadableStream = ReadableStream;
globalThis.WritableStream = WritableStream;
globalThis.TransformStream = TransformStream;
globalThis.queueMicrotask = function(cb) { Promise.resolve().then(cb); };
