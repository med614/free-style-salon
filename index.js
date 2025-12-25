require('dotenv').config();
const express = require('express');

const PORT = process.env.PORT || 3000;



const cron = require('node-cron');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

// ================== CONSTANTES ==================
const SERVICE_DURATION_MINUTES = 20;
const NOTIFICATION_THRESHOLD_MINUTES = 15;

// ================== TWILIO ==================
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ================== SUPABASE ==================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ================== EXPRESS ==================
const app = express();
app.listen(PORT, () => {
    console.log('Server running on port', PORT);
  });
  
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static('public'));

// ================== BOT STATUS ==================
async function isBotActive() {
    const { data, error } = await supabase
      .from('settings')
      .select('bot_active')
      .eq('id', 1)
      .single();
  
    // 🛟 Sécurité MVP : si problème, on ACTIVE le bot
    if (error || !data) {
      console.warn('⚠️ settings manquant → bot actif par défaut');
      return true;
    }
  
    return data.bot_active === true;
  }

  // ================== Admin ==================
  function requireAdmin(req, res, next) {
    const adminCode = req.headers['x-admin-code'];
  
    if (!adminCode) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  
    supabase
      .from('settings')
      .select('admin_code')
      .eq('id', 1)
      .single()
      .then(({ data }) => {
        if (!data || data.admin_code !== adminCode) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
      });
  }
  

// ================== WHATSAPP SEND ==================
async function sendWhatsAppMessage(to, body) {
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body
    });
  } catch (err) {
    console.error('❌ WhatsApp error:', err.message);
  }
}

// ================== BOT LOGIC ==================
async function handleIncomingMessage(message, phone) {
  const botActive = await isBotActive();

  if (!botActive) {
    return `⛔ Le salon n’accepte plus de nouvelles entrées pour le moment.
Merci de repasser plus tard 🙏`;
  }

  if (message === '1') {
    await supabase.from('clients').upsert({ phone });

    await supabase.from('queue_entries').insert({
      phone,
      status: 'waiting',
      priority: 0
    });

    const { data: waitingClients } = await supabase
      .from('queue_entries')
      .select('id')
      .eq('status', 'waiting');

    const position = waitingClients.length;
    const estimatedMinutes =
      Math.max(0, (position - 1) * SERVICE_DURATION_MINUTES);

    return `✅ C’est noté !

📍 Position : ${position}
⏳ Attente estimée : ~${estimatedMinutes} minutes

Nous vous préviendrons quand votre tour approche 😊`;
  }

  return `Bonjour 👋
Bienvenue au salon ✂️

Répondez :
1️⃣ pour prendre une place`;
}

// ================== RECALCUL + NOTIFICATION ==================
async function recalcAndNotifyNow() {
  const botActive = await isBotActive();
  if (!botActive) return;

  const { data: waitingClients } = await supabase
    .from('queue_entries')
    .select('id, phone, created_at, notified_at, priority')
    .eq('status', 'waiting');

  if (!waitingClients || waitingClients.length === 0) return;

  waitingClients.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  for (let i = 0; i < waitingClients.length; i++) {
    const client = waitingClients[i];
    if (client.notified_at) continue;

    const estimatedMinutes = i * SERVICE_DURATION_MINUTES;

    if (estimatedMinutes <= NOTIFICATION_THRESHOLD_MINUTES) {
      await sendWhatsAppMessage(
        client.phone,
        `⏰ Votre tour approche !
Merci de vous présenter dans ~15 minutes ✂️
Rak qrib 😊`
      );

      await supabase
        .from('queue_entries')
        .update({ notified_at: new Date() })
        .eq('id', client.id);
    }
  }
}

// ================== ROUTES ==================
app.get('/', (req, res) => {
  res.send('🚀 Salon Queue est en marche !');
});

app.get('/queue', requireAdmin, async (req, res) => {
    try {
      const { data: waitingClients, error } = await supabase
        .from('queue_entries')
        .select('id, phone, created_at, notified_at, priority')
        .eq('status', 'waiting');
  
      if (error) {
        console.error('❌ Erreur chargement queue:', error);
        return res.json([]);
      }
  
      if (!waitingClients || waitingClients.length === 0) {
        return res.json([]);
      }
  
      // 🔧 NORMALISATION DES DONNÉES
      const normalized = waitingClients.map(c => ({
        ...c,
        priority: c.priority === 1 ? 1 : 0 // null → 0
      }));
  
      // 🔁 TRI ROBUSTE
      normalized.sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return new Date(a.created_at) - new Date(b.created_at);
      });
  
      const SERVICE_DURATION_MINUTES = 20;
  
      const result = normalized.map((client, index) => {
        const position = index + 1;
        const estimatedMinutes = Math.max(
          0,
          (position - 1) * SERVICE_DURATION_MINUTES
        );
  
        return {
          id: client.id,
          phone: client.phone,
          position,
          estimatedMinutes,
          notified: !!client.notified_at,
          priority: client.priority === 1
        };
      });
  
      res.json(result);
  
    } catch (err) {
      console.error('❌ Erreur serveur /queue:', err);
      res.json([]);
    }
  });
  

  app.get('/bot/status', requireAdmin, async (req, res) => {
  const active = await isBotActive();
  res.json({ bot_active: active });
});

app.post('/admin/login', async (req, res) => {
    const { code } = req.body;
  
    const { data } = await supabase
      .from('settings')
      .select('admin_code')
      .eq('id', 1)
      .single();
  
    if (!data || data.admin_code !== code) {
      return res.status(401).json({ success: false });
    }
  
    res.json({ success: true });
  });
  

  app.post('/bot/toggle', requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from('settings')
    .select('bot_active')
    .eq('id', 1)
    .single();

  const newStatus = !data.bot_active;

  await supabase
    .from('settings')
    .update({ bot_active: newStatus })
    .eq('id', 1);

  res.json({ bot_active: newStatus });
});

app.post('/whatsapp', async (req, res) => {
  try {
    const message = req.body.Body;
    const phone = req.body.From.replace('whatsapp:', '');

    const reply = await handleIncomingMessage(message, phone);

    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);
  } catch (err) {
    console.error(err);
    res.send(`
      <Response>
        <Message>❌ Erreur technique</Message>
      </Response>
    `);
  }
});

app.post('/next', requireAdmin, async (req, res) => {
  const { data } = await supabase
    .from('queue_entries')
    .select('*')
    .eq('status', 'waiting')
    .order('created_at', { ascending: true })
    .limit(1);

  if (!data || data.length === 0) {
    return res.json({ reply: '❌ Aucun client' });
  }

  const current = data[0];

  await supabase
    .from('queue_entries')
    .update({ status: 'done' })
    .eq('id', current.id);

  await recalcAndNotifyNow();

  const { data: remaining } = await supabase
    .from('queue_entries')
    .select('id')
    .eq('status', 'waiting');

  res.json({
    reply: `⏭️ Client suivant : ${current.phone}
Clients restants : ${remaining.length}`
  });
});

app.post('/priority/:id', requireAdmin, async (req, res) => {
  const clientId = Number(req.params.id);

  await supabase
    .from('queue_entries')
    .update({ priority: 1 })
    .eq('id', clientId);

  await recalcAndNotifyNow();

  res.json({ reply: '⚡ Client passé en priorité' });
});

// ================== CRON ==================
cron.schedule('*/2 * * * *', () => {
  recalcAndNotifyNow();
});

// ================== SERVER ==================
app.listen(3000, () => {
  console.log('✅ Serveur lancé sur http://localhost:3000');
});
