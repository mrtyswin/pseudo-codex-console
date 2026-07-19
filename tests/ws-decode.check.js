'use strict';

// Unit test for the WebSocket delta_encoding v1 decoder (agent/ws-decode.js).
// ChatGPT streams the answer over a per-tab WebSocket, tunneling the original
// SSE events inside each frame's `encoded_item`. The decoder must rebuild the
// assistant's RAW text (markdown/code fences/diff +/-/space intact) — the very
// thing DOM scraping corrupts, which historically broke patches.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { decodeConversationFrames } = require('../agent/ws-decode');

const fixtures = JSON.parse(
  fs.readFileSync(`${__dirname}/fixtures/ws-conversation-sample.json`, 'utf8')
);

for (const fixture of fixtures) {
  if (!fixture.frames || !fixture.frames.length) continue;
  const decoded = decodeConversationFrames(fixture.frames);

  if (fixture.kind === 'raw-markdown') {
    // DOM innerText is lossy here (drops the code fence, renders a "Bash" chip),
    // so assert structurally instead of against the corrupted DOM text.
    assert.ok(decoded.text.includes('```'), `${fixture.prompt}: preserves code fence`);
    assert.ok(decoded.text.includes('echo hello'), `${fixture.prompt}: preserves code body`);
    assert.notEqual(decoded.text.trim(), fixture.domTruth.trim(), `${fixture.prompt}: differs from lossy DOM`);
    assert.equal(decoded.done, true, `${fixture.prompt}: stream complete`);
  } else {
    assert.equal(decoded.text.trim(), fixture.domTruth.trim(), fixture.prompt);
  }
}

console.log('WS_DECODE_OK');
