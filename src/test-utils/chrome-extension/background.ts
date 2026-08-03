/**
 * Classic MV3 service-worker entry. Registers onConnect before
 * importScripts loads the hub bundle. Thus chrome.runtime.connect calls
 * go into a queue during startup.
 */

declare const backgroundChannel: {
  onConnect: (port: chrome.runtime.Port) => void;
};

const pending: chrome.runtime.Port[] = [];
let connectHandler: (port: chrome.runtime.Port) => void = (port) => pending.push(port);

chrome.runtime.onConnect.addListener((port) => connectHandler(port));

// @ts-ignore - This is a classic MV3 service-worker entry
importScripts("background-channel.js");

connectHandler = backgroundChannel.onConnect;
for (const port of pending) {
  connectHandler(port);
}
