"use strict";

let nextPageId = 0;

class FakePage {
  constructor() {
    this.pageId = ++nextPageId;
    this.currentUrl = "about:blank";
    this.reloadCount = 0;
  }

  async goto(url) {
    this.currentUrl = String(url);
  }

  async reload() {
    this.reloadCount += 1;
  }

  url() {
    return this.currentUrl;
  }
}

class FakeBrowser {
  constructor() {
    this.pages = [];
  }

  async newPage() {
    const page = new FakePage();
    this.pages.push(page);
    return page;
  }

  async close() {}
}

async function launchBrowser() {
  return new FakeBrowser();
}

async function send({ page, fullPrompt, newChat }) {
  let conversationId = String(page.url()).match(/\/c\/([^/?#]+)/)?.[1] || "";
  if (newChat || !conversationId) {
    conversationId = "conversation-" + page.pageId + "-" + Date.now().toString(36);
    page.currentUrl = "https://chatgpt.com/g/g-test/project/c/" + conversationId;
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  return { response: conversationId + ":" + fullPrompt };
}

module.exports = { launchBrowser, send };
