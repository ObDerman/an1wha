/**
 * ============================================================================
 * WhatsApp AI Bot - Node.js Bridge Server
 * ============================================================================
 * * This server acts as a bridge between WhatsApp and n8n.
 * * ARCHITECTURE:
 * 1. Receives WhatsApp messages via whatsapp-web.js
 * 2. Forwards messages to n8n Webhook for AI processing
 * 3. Exposes /send-message endpoint for n8n to send replies back
 * * CONFIGURATION:
 * - Update N8N_WEBHOOK_URL with your actual n8n webhook URL
 * - Server runs on PORT 3001 by default
 * * ============================================================================
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');

// ============================================================================
// CONFIGURATION - UPDATE THESE VALUES
// ============================================================================

const PORT = 3001;
const N8N_WEBHOOK_URL = 'http://localhost:5678/webhook/whatsapp-bot'; // <-- REPLACE WITH YOUR n8n WEBHOOK URL

// ============================================================================
// EXPRESS SERVER SETUP
// ============================================================================

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================================================
// WHATSAPP CLIENT SETUP
// ============================================================================

console.log('🚀 Initializing WhatsApp Bot...\n');

const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './whatsapp-session' // Session data will be saved here
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// ============================================================================
// WHATSAPP EVENT HANDLERS
// ============================================================================

// Generate QR Code for authentication
client.on('qr', (qr) => {
    console.log('📱 Scan this QR code with your WhatsApp:\n');
    qrcode.generate(qr, { small: true });
    console.log('\n⏳ Waiting for authentication...\n');
});

// Authentication successful
client.on('authenticated', () => {
    console.log('✅ WhatsApp authenticated successfully!\n');
});

// Authentication failed
client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
    process.exit(1);
});

// Client is ready
client.on('ready', () => {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('   🤖 WhatsApp Bot is READY and listening for messages!');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`   📡 Express server running on: http://localhost:${PORT}`);
    console.log(`   🔗 n8n Webhook URL: ${N8N_WEBHOOK_URL}`);
    console.log('═══════════════════════════════════════════════════════════════\n');
});

// Handle disconnection
client.on('disconnected', (reason) => {
    console.log('⚠️  WhatsApp client disconnected:', reason);
    console.log('🔄 Attempting to reconnect...');
    client.initialize();
});

// ============================================================================
// MESSAGE HANDLING - Forward to n8n
// ============================================================================

client.on('message', async (message) => {
    // Skip status updates and broadcast messages
    if (message.isStatus || message.from === 'status@broadcast') {
        return;
    }

    // Get contact info
    const contact = await message.getContact();
    const chat = await message.getChat();

    // ----------------------------------------------------------------------
    // 🔥 FIX FOR @LID ISSUE (تعديل هام جداً)
    // بدلاً من استخدام message.from الذي قد يحتوي على @lid
    // نستخدم contact.id._serialized الذي يحتوي دائماً على الرقم الحقيقي
    // ----------------------------------------------------------------------
    let realFrom = contact.id ? contact.id._serialized : message.from;
    
    // تأكيد إضافي: إذا كان لا يزال يحتوي على lid، نستبدله يدوياً
    if (realFrom.includes('@lid')) {
        // نحاول استخراج الرقم من الكائن
        realFrom = contact.number ? `${contact.number}@c.us` : realFrom.replace('@lid', '@c.us');
    }

    // Prepare message payload for n8n
    const payload = {
        from: realFrom,                      // استخدام الرقم الحقيقي المصحح
        chatId: realFrom,                    // استخدام الرقم الحقيقي المصحح
        message: message.body,
        notifyName: contact.pushname || 'Unknown',
        pushName: contact.pushname || 'Unknown',
        type: message.type,
        timestamp: message.timestamp,
        isGroup: message.from.endsWith('@g.us'),
        chatName: chat.name || contact.pushname || 'Unknown',
        hasMedia: message.hasMedia
    };

    console.log('\n📨 New message received:');
    console.log('   From (Original):', message.from); // للمراقبة فقط
    console.log('   From (Fixed):', payload.from);    // الرقم الذي سيصل لـ n8n
    console.log('   Message:', payload.message);

    // Forward to n8n Webhook
    try {
        if (N8N_WEBHOOK_URL === 'YOUR_N8N_WEBHOOK_URL') {
            console.log('\n⚠️  WARNING: n8n Webhook URL not configured!');
            return;
        }

        console.log('   📤 Forwarding to n8n...');

        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (response.ok) {
            console.log('   ✅ Successfully forwarded to n8n');
        } else {
            console.log('   ❌ n8n responded with error:', response.status);
        }
    } catch (error) {
        console.error('   ❌ Error forwarding to n8n:', error.message);
    }
});

// ============================================================================
// EXPRESS ENDPOINTS
// ============================================================================

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        service: 'WhatsApp AI Bot Bridge',
        endpoints: {
            health: 'GET /',
            sendMessage: 'POST /send-message'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        whatsapp: client.info ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

/**
 * POST /send-message
 */
app.post('/send-message', async (req, res) => {
    try {
        const { phone, chatId, message } = req.body;

        // Determine the recipient
        let recipient = chatId || phone;

        if (!recipient) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: phone or chatId'
            });
        }

        if (!message) {
            return res.status(400).json({
                success: false,
                error: 'Missing required field: message'
            });
        }

        // ----------------------------------------------------------------------
        // 🔥 FIX FOR OUTGOING MESSAGES (حماية إضافية عند الإرسال)
        // ----------------------------------------------------------------------
        
        // 1. تنظيف الرقم من أي رموز غير رقمية إذا لم يكن يحتوي على @
        if (!recipient.includes('@')) {
            recipient = recipient.replace(/\D/g, '');
            recipient = `${recipient}@c.us`;
        }
        
        // 2. إذا وصل عنوان ينتهي بـ @lid بالخطأ، نقوم بتحويله فوراً
        if (recipient.includes('@lid')) {
            console.log('   ⚠️ Auto-fixing @lid address to @c.us');
            recipient = recipient.replace('@lid', '@c.us');
            // ملاحظة: في بعض الحالات المعقدة قد نحتاج لاستخراج الرقم، لكن هذا التبديل يحل 99% من المشاكل الحالية
        }

        console.log('\n📤 Sending message:');
        console.log('   To:', recipient);
        console.log('   Message:', message.substring(0, 50) + (message.length > 50 ? '...' : ''));

        // Send the message via WhatsApp
        await client.sendMessage(recipient, message);

        console.log('   ✅ Message sent successfully!');

        res.json({
            success: true,
            message: 'Message sent successfully',
            recipient: recipient
        });

    } catch (error) {
        console.error('   ❌ Error sending message:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================================
// START THE SERVER
// ============================================================================

app.listen(PORT, () => {
    console.log(`\n🌐 Express server started on port ${PORT}`);
    console.log('🔧 Initializing WhatsApp client...\n');
});

client.initialize();

process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down gracefully...');
    await client.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n\n🛑 Shutting down gracefully...');
    await client.destroy();
    process.exit(0);
});