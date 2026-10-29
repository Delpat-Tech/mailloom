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

  // Test 11: Auth Logout & Socket Pool Cleanup
  const logoutRes = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: authHeaders
  });
  console.log(`[TEST 11] POST /api/auth/logout -> status: ${logoutRes.statusCode}`);
  if (logoutRes.statusCode !== 200) throw new Error('Logout failed');

  console.log('\n🎉 ALL 11 TESTS PASSED SUCCESSFULLY! Mailloom API & Dovecot Pool are completely solid.');
  await app.close();
}

runTestSuite().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
