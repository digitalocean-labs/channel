import { ChromeHandshake } from "../../chrome.js";

/** The host page, the content relay, and the background handshake share this instance. */
export const handshake = new ChromeHandshake<"popup" | "sidepanel">({
  namespace: "browser-channel-test",
});
