import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReply } from '../../client/src/services/reply.ts';

const me = 'me@delpat.test';
const base = {
  from: { address: 'alice@x.test' },
  to: [{ address: me }, { address: 'bob@x.test' }],
  cc: [{ address: 'carol@x.test' }],
  subject: 'Hello',
  messageId: '<m1@x.test>',
  references: ['<root@x.test>']
};

test('reply goes to From and sets threading ids', () => {
  const p = planReply(base, me, false);
  assert.deepEqual(p.to, ['alice@x.test']);
  assert.deepEqual(p.cc, []);
  assert.equal(p.subject, 'Re: Hello');
  assert.equal(p.inReplyTo, '<m1@x.test>');
  assert.deepEqual(p.references, ['<root@x.test>', '<m1@x.test>']);
});

test('reply prefers Reply-To', () => {
  const p = planReply({ ...base, replyTo: [{ address: 'list@x.test' }] }, me, false);
  assert.deepEqual(p.to, ['list@x.test']);
});

test('reply-all excludes my own address, case-insensitively', () => {
  const p = planReply({ ...base, to: [{ address: 'ME@Delpat.test' }, { address: 'bob@x.test' }] }, me, true);
  assert.deepEqual(p.to, ['alice@x.test']);
  assert.deepEqual(p.cc, ['bob@x.test', 'carol@x.test']);
});

test('replying to a mail I sent goes to its original recipients', () => {
  const sent = { ...base, from: { address: me }, to: [{ address: 'bob@x.test' }], cc: [{ address: 'carol@x.test' }] };
  const p = planReply(sent, me, false);
  assert.deepEqual(p.to, ['bob@x.test']);
  const all = planReply(sent, me, true);
  assert.deepEqual(all.to, ['bob@x.test']);
  assert.deepEqual(all.cc, ['carol@x.test']);
});

test('subject already starting with Re: is kept', () => {
  assert.equal(planReply({ ...base, subject: 'RE: Hello' }, me, false).subject, 'RE: Hello');
});
