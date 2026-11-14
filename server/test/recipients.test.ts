import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRecipients, RecipientError } from '../src/utils/recipients.js';

test('recipients: single mailboxes become {name,address} objects', () => {
  assert.deepEqual(parseRecipients(['a@delpat.test', 'Ann B <ann@delpat.test>', '"Doe, Jo" <jo@delpat.test>', { name: 'X', address: 'x@delpat.test' }], 'To'), [
    { name: '', address: 'a@delpat.test' },
    { name: 'Ann B', address: 'ann@delpat.test' },
    { name: 'Doe, Jo', address: 'jo@delpat.test' },
    { name: 'X', address: 'x@delpat.test' }
  ]);
});

test('recipients: a string holding several addresses is refused, not reinterpreted', () => {
  for (const bad of [
    'a@delpat.test, evil@x.test',
    'a@delpat.test; evil@x.test',
    'Name <a@delpat.test>, evil@x.test',
    'Group: a@delpat.test, b@delpat.test;',
    'a@delpat.test\r\nBcc: evil@x.test',
    'not-an-address',
    '<a@b.test> <c@d.test>'
  ]) {
    assert.throws(() => parseRecipients([bad], 'Cc'), RecipientError, bad);
  }
  assert.throws(() => parseRecipients('a@delpat.test', 'To'), RecipientError);
  assert.throws(() => parseRecipients([{ address: 5 }], 'To'), RecipientError);
});

test('session send refuses a Cc string that hides a second address', async () => {
  const { buildTestApp, signIn, TESTER, resetAccount } = await import('./helpers.js');
  await resetAccount(TESTER);
  const app = await buildTestApp();
  try {
    const s = await signIn(app, TESTER);
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages/send',
      headers: s.headers,
      payload: { to: ['colleague@delpat.test'], cc: ['"x" <a@delpat.test>, evil@example.test'], subject: 's', text: 't' }
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});
