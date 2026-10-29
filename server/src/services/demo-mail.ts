import type { MailboxFolder, MessageHeader, ParsedEmailMessage, SendEmailPayload } from '../types.js';

interface StoredDemoMessage extends ParsedEmailMessage {
  folder: string;
}

class DemoMailService {
  private folders: MailboxFolder[] = [
    { path: 'INBOX', name: 'Inbox', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: 'Inbox', unreadCount: 3, totalCount: 6 },
    { path: 'Starred', name: 'Starred', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: 'All', unreadCount: 0, totalCount: 2 },
    { path: 'Sent', name: 'Sent', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: 'Sent', unreadCount: 0, totalCount: 2 },
    { path: 'Drafts', name: 'Drafts', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: 'Drafts', unreadCount: 0, totalCount: 1 },
    { path: 'Trash', name: 'Trash', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: 'Trash', unreadCount: 0, totalCount: 1 },
    { path: 'Junk', name: 'Spam', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: 'Junk', unreadCount: 0, totalCount: 0 },
    { path: 'Archive', name: 'Archive', delimiter: '/', flags: ['\\HasNoChildren'], specialUse: 'Archive', unreadCount: 0, totalCount: 1 }
  ];

  private messages: StoredDemoMessage[] = [
    {
      uid: 101,
      id: '<msg-101@apexinfra.example>',
      folder: 'INBOX',
      subject: 'URGENT: Purchase Order Approved for M12 Hex Bolts (Ref: AIP-PO-2026-088)',
      from: { name: 'Kishan Patel (Apex Infra)', address: 'kishan@apexinfra.example' },
      to: [{ name: 'Sales Dept', address: 'sales@poojafasteners.example' }],
      cc: [{ name: 'Project Lead', address: 'lead@apexinfra.example' }],
      date: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
      flags: [],
      isSeen: false,
      isFlagged: true,
      text: `Hello Sales Team,\n\nOur management has approved the quotation for 2,000 pcs of Hex Bolts M12 x 50mm (Grade 8.8) and matching Nyloc nuts.\n\nPlease find attached the official Purchase Order document. Kindly expedite delivery to our Ahmedabad site.\n\nBest regards,\nKishan Patel\nProcurement Manager | Apex Infra Projects Ltd`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1e293b;">
          <p>Hello Sales Team,</p>
          <p>Our management has approved quotation <strong>QT/26-27/0042</strong> for:</p>
          <ul>
            <li><strong>2,000 pcs</strong> — Hex Bolt M12 x 50mm (Grade 8.8, Zinc Plated)</li>
            <li><strong>2,000 pcs</strong> — Nylon Insert Lock Nut M12</li>
            <li><strong>2,000 pcs</strong> — Flat Plain Hardened Washer M12</li>
          </ul>
          <p>Please find attached our official Purchase Order document <code>AIP-PO-2026-088</code>.</p>
          <div style="margin: 20px 0; padding: 15px; background: #f8fafc; border-left: 4px solid #0284c7; border-radius: 4px;">
            <strong>Delivery Address:</strong><br/>
            Apex Signature Tower, SG Highway, Ahmedabad, Gujarat - 380054<br/>
            <strong>Required Delivery Date:</strong> Tomorrow by 4:00 PM
          </div>
          <p>Kindly acknowledge receipt and issue the delivery challan.</p>
          <br/>
          <p style="color: #64748b; font-size: 13px;">
            Best regards,<br/>
            <strong>Kishan Patel</strong><br/>
            Procurement Lead | Apex Infra Projects Ltd<br/>
            Phone: +91 98250 11223
          </p>
        </div>
      `,
      attachments: [
        {
          partId: '1.2',
          filename: 'Apex_Purchase_Order_AIP-088.pdf',
          contentType: 'application/pdf',
          size: 245760,
          isInline: false
        },
        {
          partId: '1.3',
          filename: 'Fastener_Specs_Sheet.xlsx',
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 112400,
          isInline: false
        }
      ]
    },
    {
      uid: 102,
      id: '<msg-102@vtrans.example>',
      folder: 'INBOX',
      subject: 'Shipment Dispatched: LR #VT-VAD-98421 (Vehicle GJ-06-AX-4821)',
      from: { name: 'V-Trans Logistics', address: 'dispatch@vtrans.example' },
      to: [{ name: 'Logistics Desk', address: 'logistics@poojafasteners.example' }],
      date: new Date(Date.now() - 1000 * 60 * 120).toISOString(),
      flags: [],
      isSeen: false,
      isFlagged: false,
      text: `Dear Customer, Your consignment has been loaded into Tempo GJ-06-AX-4821 and dispatched from Vadodara Central Depot. Driver: Rajesh Bhai (9825123456). E-way bill: 241890283741. Tracking available online.`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1e293b;">
          <h2 style="color: #0369a1; margin-top: 0;">Consignment Dispatched</h2>
          <p>Your shipment has been picked up from <strong>Vadodara Central Depot</strong> and is in transit.</p>
          <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
            <tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 8px 0; color: #64748b;">Consignment / Bilty No:</td><td style="padding: 8px 0; font-weight: bold;">VT-VAD-98421</td></tr>
            <tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 8px 0; color: #64748b;">Vehicle Number:</td><td style="padding: 8px 0; font-weight: bold;">GJ-06-AX-4821 (Tata 407)</td></tr>
            <tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 8px 0; color: #64748b;">Driver Contact:</td><td style="padding: 8px 0;">Rajesh Bhai (+91 98251 23456)</td></tr>
            <tr style="border-bottom: 1px solid #e2e8f0;"><td style="padding: 8px 0; color: #64748b;">e-Way Bill Number:</td><td style="padding: 8px 0;">241890283741</td></tr>
          </table>
          <p style="font-size: 13px; color: #64748b;">Thank you for partnering with V-Trans Express Logistics.</p>
        </div>
      `,
      attachments: [
        {
          partId: '2.2',
          filename: 'Lorry_Receipt_VT98421.pdf',
          contentType: 'application/pdf',
          size: 184320,
          isInline: false
        }
      ]
    },
    {
      uid: 103,
      id: '<msg-103@tatasteel.example>',
      folder: 'INBOX',
      subject: 'Price Revision Notice: Wire Rod & Structural Fasteners (Nov 2026)',
      from: { name: 'Tata Steel Wire Division', address: 'wire.sales@tatasteel.example' },
      to: [{ name: 'Procurement Dept', address: 'purchase@poojafasteners.example' }],
      date: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
      flags: [],
      isSeen: false,
      isFlagged: true,
      text: `Dear Channel Partners, Please take note of raw material price revisions effective 1st November 2026. High tensile cold forging wire rod prices revised by +₹1,200/MT. Revised price circular attached.`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1e293b;">
          <p>Dear Channel Partners,</p>
          <p>Due to surging global coking coal prices and scrap input costs, base rates for <strong>Cold Forging Quality (10B21 / 15B25) Wire Rods</strong> have been adjusted by <strong>+₹1,200 per Metric Tonne</strong> effective 1st November 2026.</p>
          <p>All pending confirmed purchase orders scheduled prior to 31st October will be honored at current contracted rates.</p>
          <p>Please find the official price matrix and circular attached.</p>
          <br/>
          <p>Warm regards,<br/><strong>Commercial Sales Division</strong><br/>Tata Steel Ltd</p>
        </div>
      `,
      attachments: [
        {
          partId: '3.2',
          filename: 'Tata_Steel_Circular_Nov2026.pdf',
          contentType: 'application/pdf',
          size: 389120,
          isInline: false
        }
      ]
    },
    {
      uid: 104,
      id: '<msg-104@indiamart.example>',
      folder: 'INBOX',
      subject: 'New Buyer Inquiry: Wedge Anchors M12 & Self-Drilling Screws',
      from: { name: 'IndiaMART Buyer Leads', address: 'leads@indiamart.example' },
      to: [{ name: 'Sales Inquiries', address: 'leads@poojafasteners.example' }],
      date: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
      flags: ['\\Seen'],
      isSeen: true,
      isFlagged: false,
      text: `Inquiry details: Buyer Name: Adani Solar Projects Khavda. Requirement: Tek Screws 4.8 x 25mm (50,000 pcs), Wedge Anchors M12 x 100mm SS304 (5,000 pcs). Click here to view contact details.`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1e293b;">
          <div style="background: #0284c7; color: white; padding: 12px 16px; border-radius: 6px;">
            <h3 style="margin: 0;">Verified Buyer Inquiry — Solar Energy Sector</h3>
          </div>
          <div style="padding: 16px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 6px 6px;">
            <p><strong>Buyer:</strong> Adani Solar Projects (Khavda Site)</p>
            <p><strong>Location:</strong> Kutch, Gujarat</p>
            <p><strong>Requirement:</strong></p>
            <ul>
              <li>50,000 pcs — Self Drilling Tek Screws 4.8 x 25mm (Ruspert Coated)</li>
              <li>5,000 pcs — SS 304 Wedge Anchors M12 x 100mm</li>
            </ul>
            <p><strong>Status:</strong> Immediate Requirement for Module Mounting Structures.</p>
          </div>
        </div>
      `,
      attachments: []
    },
    {
      uid: 105,
      id: '<msg-105@hdfcbank.example>',
      folder: 'INBOX',
      subject: 'NEFT Credit Alert: ₹35,000.00 received from Apex Infra Projects',
      from: { name: 'HDFC Bank Alerts', address: 'alerts@hdfcbank.net' },
      to: [{ name: 'Accounts Dept', address: 'accounts@poojafasteners.example' }],
      date: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
      flags: ['\\Seen'],
      isSeen: true,
      isFlagged: false,
      text: `Your account **482 has been credited with ₹35,000.00 on 28-OCT-26 via NEFT UTR HDFCR2026101800912 from APEX INFRA PROJECTS LTD.`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1e293b; padding: 16px; border: 1px solid #cbd5e1; border-radius: 8px;">
          <h3 style="color: #1e3a8a; margin-top: 0;">Transaction Alert</h3>
          <p>Dear Customer,</p>
          <p>Your Current Account ending in <strong>482</strong> has been credited with <strong>₹35,000.00</strong> on 28-OCT-2026.</p>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="color: #64748b; padding: 6px 0;">Remitter:</td><td>APEX INFRA PROJECTS LTD</td></tr>
            <tr><td style="color: #64748b; padding: 6px 0;">Reference / UTR:</td><td><code>HDFCR2026101800912</code></td></tr>
            <tr><td style="color: #64748b; padding: 6px 0;">Payment Mode:</td><td>NEFT</td></tr>
          </table>
          <p style="font-size: 12px; color: #94a3b8; margin-top: 20px;">This is an automated alert from HDFC Bank.</p>
        </div>
      `,
      attachments: []
    },
    {
      uid: 106,
      id: '<msg-106@marutifab.example>',
      folder: 'INBOX',
      subject: 'Inspection Report & Gate Pass Request (MFI-PUR-26-119)',
      from: { name: 'Maruti Fabtech Quality Desk', address: 'qc@marutifab.example' },
      to: [{ name: 'Pooja Fasteners', address: 'sales@poojafasteners.example' }],
      date: new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(),
      flags: ['\\Seen'],
      isSeen: true,
      isFlagged: false,
      text: `Dear Team, High tensile bolts lot M16 x 75mm (500 pcs) received and passed hardness test (32-38 HRC). Requesting revised gate pass copy for factory gate entry.`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1e293b;">
          <p>Dear Team,</p>
          <p>We completed quality acceptance testing on the 500 pcs lot of High Tensile Bolts (M16 x 75mm, Grade 10.9) received against Order <code>MFI-PUR-26-119</code>.</p>
          <p>Hardness tests confirmed 32–38 HRC meeting DIN 933 compliance. Please send over the final duplicate gate pass stamped copy.</p>
          <br/>
          <p>Regards,<br/><strong>Harish Sharma</strong><br/>Head of QA/QC, Maruti Fabtech</p>
        </div>
      `,
      attachments: []
    },
    // Sent folder messages
    {
      uid: 201,
      id: '<msg-sent-201@poojafasteners.example>',
      folder: 'Sent',
      subject: 'Quotation QT/26-27/0042 for Industrial Hex Fasteners',
      from: { name: 'Pooja Fasteners Sales', address: 'sales@poojafasteners.example' },
      to: [{ name: 'Kishan Patel', address: 'kishan@apexinfra.example' }],
      date: new Date(Date.now() - 1000 * 60 * 60 * 36).toISOString(),
      flags: ['\\Seen'],
      isSeen: true,
      isFlagged: false,
      text: `Dear Kishanji, Please find attached our formal quotation QT/26-27/0042 for Hex Bolts M12 and Nyloc Nuts. Rates valid for 15 days.`,
      html: `
        <div style="font-family: Arial, sans-serif;">
          <p>Dear Kishanji,</p>
          <p>Thank you for your inquiry. Please find attached our formal quotation <strong>QT/26-27/0042</strong> for industrial structural fasteners.</p>
          <p>All items are manufactured from tested cold-forging wire with EN 10204 3.1 certification.</p>
          <br/>
          <p>Warm regards,<br/><strong>Ramesh Dave</strong><br/>Sales Manager, Pooja Enterprise LLP</p>
        </div>
      `,
      attachments: [
        {
          partId: '1.2',
          filename: 'Quotation_QT_2026_0042.pdf',
          contentType: 'application/pdf',
          size: 198400,
          isInline: false
        }
      ]
    },
    {
      uid: 202,
      id: '<msg-sent-202@poojafasteners.example>',
      folder: 'Sent',
      subject: 'Tax Invoice INV/26-27/0129 — Apex Infra Projects Ltd',
      from: { name: 'Pooja Enterprise Accounts', address: 'accounts@poojafasteners.example' },
      to: [{ name: 'Accounts Payable', address: 'accounts@apexinfra.example' }],
      date: new Date(Date.now() - 1000 * 60 * 60 * 12).toISOString(),
      flags: ['\\Seen'],
      isSeen: true,
      isFlagged: false,
      text: `Dear Sirs, Attached please find Tax Invoice INV/26-27/0129 for ₹63,082.80 against delivery challan DN/26-27/0081.`,
      html: `
        <div style="font-family: Arial, sans-serif;">
          <p>Dear Sirs,</p>
          <p>Attached please find official GST Tax Invoice <strong>INV/26-27/0129</strong> for ₹63,082.80 (CGST 9% + SGST 9%) against delivery challan DN/26-27/0081.</p>
          <p>Kindly arrange NEFT/RTGS payment as per agreed 45-day credit period.</p>
        </div>
      `,
      attachments: [
        {
          partId: '2.2',
          filename: 'Tax_Invoice_INV-0129.pdf',
          contentType: 'application/pdf',
          size: 215000,
          isInline: false
        }
      ]
    },
    // Trash
    {
      uid: 301,
      id: '<msg-trash-301@spam.example>',
      folder: 'Trash',
      subject: 'Promotional: Unbeatable discounts on industrial air compressors',
      from: { name: 'Marketing Hub', address: 'promo@machinerydeals.example' },
      to: [{ name: 'Pooja Fasteners', address: 'info@poojafasteners.example' }],
      date: new Date(Date.now() - 1000 * 60 * 60 * 72).toISOString(),
      flags: ['\\Seen'],
      isSeen: true,
      isFlagged: false,
      text: `Get 25% off industrial compressors this week only.`,
      html: `<p>Get 25% off industrial compressors this week only.</p>`,
      attachments: []
    }
  ];

  getMailboxes(): MailboxFolder[] {
    // Recalculate counts dynamically
    return this.folders.map((f) => {
      let msgs: StoredDemoMessage[] = [];
      if (f.specialUse === 'All' && f.name === 'Starred') {
        msgs = this.messages.filter((m) => m.isFlagged && m.folder !== 'Trash');
      } else {
        msgs = this.messages.filter((m) => m.folder === f.path);
      }
      const unreadCount = msgs.filter((m) => !m.isSeen).length;
      return {
        ...f,
        unreadCount,
        totalCount: msgs.length
      };
    });
  }

  getMessages(folderPath: string, page = 1, limit = 50, search = ''): { messages: MessageHeader[]; total: number } {
    let matched: StoredDemoMessage[];
    if (folderPath.toLowerCase() === 'starred') {
      matched = this.messages.filter((m) => m.isFlagged && m.folder !== 'Trash');
    } else {
      matched = this.messages.filter((m) => m.folder.toLowerCase() === folderPath.toLowerCase());
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      matched = matched.filter(
        (m) =>
          m.subject.toLowerCase().includes(q) ||
          m.from.name.toLowerCase().includes(q) ||
          m.from.address.toLowerCase().includes(q) ||
          (m.text && m.text.toLowerCase().includes(q))
      );
    }

    // Sort newest first
    matched.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const start = (page - 1) * limit;
    const pageItems = matched.slice(start, start + limit);

    const headers: MessageHeader[] = pageItems.map((m) => ({
      uid: m.uid,
      id: m.id,
      from: m.from,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      date: m.date,
      flags: m.flags,
      isSeen: m.isSeen,
      isFlagged: m.isFlagged,
      hasAttachments: m.attachments.length > 0,
      size: (m.text?.length || 0) + (m.html?.length || 0) + m.attachments.reduce((acc, a) => acc + a.size, 0),
      snippet: (m.text || '').replace(/\s+/g, ' ').slice(0, 100)
    }));

    return { messages: headers, total: matched.length };
  }

  getMessageDetail(folderPath: string, uid: number): ParsedEmailMessage | null {
    const msg = this.messages.find((m) => m.uid === uid);
    if (!msg) return null;
    // Auto mark seen
    msg.isSeen = true;
    if (!msg.flags.includes('\\Seen')) msg.flags.push('\\Seen');
    return msg;
  }

  toggleFlag(uid: number, flag: 'isSeen' | 'isFlagged', value?: boolean): boolean {
    const msg = this.messages.find((m) => m.uid === uid);
    if (!msg) return false;
    if (flag === 'isSeen') {
      msg.isSeen = value !== undefined ? value : !msg.isSeen;
      if (msg.isSeen && !msg.flags.includes('\\Seen')) msg.flags.push('\\Seen');
      if (!msg.isSeen) msg.flags = msg.flags.filter((f) => f !== '\\Seen');
    } else if (flag === 'isFlagged') {
      msg.isFlagged = value !== undefined ? value : !msg.isFlagged;
      if (msg.isFlagged && !msg.flags.includes('\\Flagged')) msg.flags.push('\\Flagged');
      if (!msg.isFlagged) msg.flags = msg.flags.filter((f) => f !== '\\Flagged');
    }
    return true;
  }

  moveMessage(uid: number, targetFolder: string): boolean {
    const msg = this.messages.find((m) => m.uid === uid);
    if (!msg) return false;
    msg.folder = targetFolder;
    return true;
  }

  deleteMessage(uid: number): boolean {
    const msgIndex = this.messages.findIndex((m) => m.uid === uid);
    if (msgIndex === -1) return false;
    const msg = this.messages[msgIndex]!;
    if (msg.folder !== 'Trash') {
      msg.folder = 'Trash';
    } else {
      this.messages.splice(msgIndex, 1);
    }
    return true;
  }

  sendEmail(payload: SendEmailPayload, senderEmail: string, senderName = 'Me'): MessageHeader {
    const newUid = Math.max(...this.messages.map((m) => m.uid), 999) + 1;
    const dateStr = new Date().toISOString();
    const attachments = (payload.attachments || []).map((att, i) => ({
      partId: `sent.${i}`,
      filename: att.filename,
      contentType: att.contentType || 'application/octet-stream',
      size: Buffer.from(att.content, 'base64').length,
      isInline: false
    }));

    const newMsg: StoredDemoMessage = {
      uid: newUid,
      id: `<sent-${newUid}@poojafasteners.example>`,
      folder: 'Sent',
      subject: payload.subject,
      from: { name: senderName, address: senderEmail },
      to: payload.to.map((addr) => ({ name: addr.split('@')[0]!, address: addr })),
      cc: payload.cc ? payload.cc.map((addr) => ({ name: addr.split('@')[0]!, address: addr })) : [],
      bcc: payload.bcc ? payload.bcc.map((addr) => ({ name: addr.split('@')[0]!, address: addr })) : [],
      date: dateStr,
      flags: ['\\Seen'],
      isSeen: true,
      isFlagged: false,
      text: payload.text || '',
      html: payload.html || payload.text || '',
      attachments
    };

    this.messages.unshift(newMsg);

    return {
      uid: newMsg.uid,
      id: newMsg.id,
      from: newMsg.from,
      to: newMsg.to,
      subject: newMsg.subject,
      date: newMsg.date,
      flags: newMsg.flags,
      isSeen: true,
      isFlagged: false,
      hasAttachments: attachments.length > 0,
      size: (payload.text?.length || 0) + (payload.html?.length || 0),
      snippet: (payload.text || '').slice(0, 100)
    };
  }

  getAttachmentData(uid: number, partId: string): { buffer: Buffer; filename: string; contentType: string } | null {
    const msg = this.messages.find((m) => m.uid === uid);
    if (!msg) return null;
    const att = msg.attachments.find((a) => a.partId === partId);
    if (!att) return null;

    // Generate sample PDF/file content on the fly
    const sampleText = `Sample attachment content for file: ${att.filename}\nOriginal email: ${msg.subject}\nFrom: ${msg.from.name} <${msg.from.address}>\nDate: ${msg.date}`;
    return {
      buffer: Buffer.from(sampleText, 'utf-8'),
      filename: att.filename,
      contentType: att.contentType
    };
  }
}

export const demoMailService = new DemoMailService();
