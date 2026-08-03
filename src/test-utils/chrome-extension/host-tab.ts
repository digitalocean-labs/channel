/** Gives the tab id of the Playwright host page that contains the content script. */
export async function hostTabId(): Promise<number> {
  const hosts = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
  const id = hosts[0]?.id;
  if (id == null) {
    throw new Error("no host tab found");
  }
  return id;
}
