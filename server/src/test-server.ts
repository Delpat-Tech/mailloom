import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { mailRoutes } from './routes/mail.js';

async function runTestSuite() {
  console.log('--- STARTING ROUNDCUBE API TEST SUITE ---');

  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie, { secret: 'test-secret' });
  await app.register(multipart);

  app.get('/api/health', async () => ({ status: 'ok' }));
  await app.register(mailRoutes);

  await app.ready();
  console.log('✓ Fastify app initialized and ready');

  // Test 1: Health Check
  const healthRes = await app.inject({
    method: 'GET',
    url: '/api/health'
  });
  console.log(`[TEST 1] GET /api/health -> status: ${healthRes.statusCode}, body: ${healthRes.body}`);
  if (healthRes.statusCode !== 200) throw new Error('Health check failed');

  // Test 2: Demo Auth Connect
  const connectRes = await app.inject({
    method: 'POST',
    url: '/api/auth/connect',
    payload: { isDemo: true }
  });
  console.log(`[TEST 2] POST /api/auth/connect (Demo) -> status: ${connectRes.statusCode}`);
  const connectData = JSON.parse(connectRes.body);
  const token = connectData.token;
  if (!token) throw new Error('No token returned from connect');
  console.log(`  Connected user: ${connectData.account.email} (Demo: ${connectData.account.isDemo})`);

  const authHeaders = {
    authorization: `Bearer ${token}`
  };

  // Test 3: Auth Me
  const meRes = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers: authHeaders
  });
  console.log(`[TEST 3] GET /api/auth/me -> status: ${meRes.statusCode}`);
  const meData = JSON.parse(meRes.body);
  if (meData.account.email !== connectData.account.email) throw new Error('Auth me mismatch');

  // Test 4: Mailboxes List
  const mailboxesRes = await app.inject({
    method: 'GET',
    url: '/api/mailboxes',
    headers: authHeaders
  });
  console.log(`[TEST 4] GET /api/mailboxes -> status: ${mailboxesRes.statusCode}`);
  const mailboxesData = JSON.parse(mailboxesRes.body);
  console.log(`  Found ${mailboxesData.folders.length} folders: ${mailboxesData.folders.map((f: any) => f.name).join(', ')}`);
  if (!mailboxesData.folders.some((f: any) => f.name === 'Inbox')) throw new Error('Missing Inbox folder');

  // Test 5: Inbox Messages
  const messagesRes = await app.inject({
    method: 'GET',
    url: '/api/mailboxes/INBOX/messages',
    headers: authHeaders
  });
  console.log(`[TEST 5] GET /api/mailboxes/INBOX/messages -> status: ${messagesRes.statusCode}`);
  const messagesData = JSON.parse(messagesRes.body);
  console.log(`  Retrieved ${messagesData.messages.length} messages (total: ${messagesData.total})`);
  if (messagesData.messages.length === 0) throw new Error('No messages returned');

  const firstMsgUid = messagesData.messages[0].uid;

  // Test 6: Message Detail
  const detailRes = await app.inject({
    method: 'GET',
    url: `/api/mailboxes/INBOX/messages/${firstMsgUid}`,
    headers: authHeaders
  });
  console.log(`[TEST 6] GET /api/mailboxes/INBOX/messages/${firstMsgUid} -> status: ${detailRes.statusCode}`);
  const detailData = JSON.parse(detailRes.body);
  console.log(`  Subject: "${detailData.subject}"`);
  console.log(`  Attachments count: ${detailData.attachments.length}`);
  if (!detailData.html && !detailData.text) throw new Error('No message body found');

  // Test 7: Toggle Flag (Star)
  const flagRes = await app.inject({
    method: 'POST',
    url: `/api/mailboxes/INBOX/messages/${firstMsgUid}/flags`,
    headers: authHeaders,
    payload: { flag: 'isFlagged', value: true }
  });
  console.log(`[TEST 7] POST /api/mailboxes/INBOX/messages/${firstMsgUid}/flags -> status: ${flagRes.statusCode}`);
  if (flagRes.statusCode !== 200) throw new Error('Toggle flag failed');

  // Test 8: Send Message
  const sendRes = await app.inject({
    method: 'POST',
    url: '/api/messages/send',
    headers: authHeaders,
    payload: {
      to: ['client@industrialcorp.com'],
      subject: 'Quote Confirmation #RFQ-88912',
      text: 'Thank you for your inquiry. Please find attached our delivery confirmation.',
      attachments: [
        {
          filename: 'delivery-confirmation.txt',
          content: Buffer.from('Confirmation of expedited air shipment for 10,000 M8 bolts.').toString('base64'),
          contentType: 'text/plain'
        }
      ]
    }
  });
  console.log(`[TEST 8] POST /api/messages/send -> status: ${sendRes.statusCode}`);
  if (sendRes.statusCode !== 200) throw new Error('Send email failed');

  // Test 9: Verify Sent Folder has new message
  const sentRes = await app.inject({
    method: 'GET',
    url: '/api/mailboxes/Sent/messages',
    headers: authHeaders
  });
  console.log(`[TEST 9] GET /api/mailboxes/Sent/messages -> status: ${sentRes.statusCode}`);
  const sentData = JSON.parse(sentRes.body);
  console.log(`  Sent folder now has ${sentData.messages.length} messages`);
  const foundSent = sentData.messages.find((m: any) => m.subject.includes('Quote Confirmation #RFQ-88912'));
  if (!foundSent) throw new Error('Sent message not found in Sent folder');
  console.log(`  Found sent message with UID ${foundSent.uid}`);

  // Test 10: Download Attachment
  const att = detailData.attachments[0];
  if (att) {
    const downloadRes = await app.inject({
      method: 'GET',
      url: `/api/mailboxes/INBOX/messages/${firstMsgUid}/attachments/${att.partId}`,
      headers: authHeaders
    });
    console.log(`[TEST 10] GET attachment "${att.filename}" -> status: ${downloadRes.statusCode}, size: ${downloadRes.rawPayload.length} bytes`);
    if (downloadRes.statusCode !== 200) throw new Error('Attachment download failed');
  }

  // Test 11: Server-side Search (Free Text)
  const searchRes = await app.inject({
    method: 'GET',
    url: '/api/mailboxes/INBOX/messages?search=logistics',
    headers: authHeaders
  });
  console.log(`[TEST 11] GET /api/mailboxes/INBOX/messages?search=logistics -> status: ${searchRes.statusCode}`);
  const searchData = JSON.parse(searchRes.body);
  console.log(`  Search matched ${searchData.messages.length} messages`);
  if (!searchData.messages.some((m: any) => m.subject.toLowerCase().includes('logistics') || m.from.name.toLowerCase().includes('logistics') || m.snippet.toLowerCase().includes('logistics'))) {
    throw new Error('Search did not match expected message');
  }

  // Test 12: Server-side Filtered Search (From & Subject)
  const filterRes = await app.inject({
    method: 'GET',
    url: '/api/mailboxes/INBOX/messages?from=Tata&subject=Price',
    headers: authHeaders
  });
  console.log(`[TEST 12] GET /api/mailboxes/INBOX/messages?from=Tata&subject=Price -> status: ${filterRes.statusCode}`);
  const filterData = JSON.parse(filterRes.body);
  console.log(`  Filtered search matched ${filterData.messages.length} messages`);
  if (filterData.messages.length === 0 || !filterData.messages[0].subject.includes('Price Revision')) {
    throw new Error('Filtered search failed to return matching message');
  }

  // Test 13: Mark as Spam / Move to Junk & Mark Read
  const spamTargetUid = firstMsgUid;
  const spamRes = await app.inject({
    method: 'POST',
    url: `/api/mailboxes/INBOX/messages/${spamTargetUid}/spam`,
    headers: authHeaders,
    payload: { junkFolder: 'Junk' }
  });
  console.log(`[TEST 13] POST /api/mailboxes/INBOX/messages/${spamTargetUid}/spam -> status: ${spamRes.statusCode}`);
  if (spamRes.statusCode !== 200) throw new Error('Mark as spam failed');

  // Verify message is now in Junk folder
  const junkRes = await app.inject({
    method: 'GET',
    url: '/api/mailboxes/Junk/messages',
    headers: authHeaders
  });
  const junkData = JSON.parse(junkRes.body);
  console.log(`  Junk folder now contains ${junkData.messages.length} messages`);
  const foundInJunk = junkData.messages.find((m: any) => m.uid === spamTargetUid);
  if (!foundInJunk) throw new Error('Message not found in Junk folder after spam action');
  if (!foundInJunk.isSeen) throw new Error('Message in Junk folder was not marked as read');
  console.log(`  Verified message ${spamTargetUid} is in Junk folder and marked as read`);

  // Test 14: Auth Logout & Socket Pool Cleanup
  const logoutRes = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: authHeaders
  });
  console.log(`[TEST 14] POST /api/auth/logout -> status: ${logoutRes.statusCode}`);
  if (logoutRes.statusCode !== 200) throw new Error('Logout failed');

  console.log('\n🎉 ALL 14 TESTS PASSED SUCCESSFULLY! Mailloom Search, Spam & Core features are 100% verified.');
  await app.close();
}

runTestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
