import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
let N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';

let sock;
let qrCodeData = null;
let isConnected = false;
let connectionState = 'disconnected';

// Logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

/**
 * Envia mensagem para o webhook do n8n
 */
async function sendToN8N(data) {
  const webhookUrl = N8N_WEBHOOK_URL || process.env.N8N_WEBHOOK_URL;
  
  if (!webhookUrl) {
    logger.warn('N8N_WEBHOOK_URL não configurada');
    return;
  }

  try {
    logger.info(`Enviando para n8n: ${webhookUrl}`);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      logger.error(`Erro ao enviar para n8n: ${response.status} ${response.statusText}`);
    } else {
      logger.info('✅ Mensagem enviada para n8n com sucesso');
    }
  } catch (error) {
    logger.error('Erro ao enviar para n8n:', error.message);
  }
}

/**
 * Conecta ao WhatsApp usando Baileys
 */
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  
  logger.info(`Usando WA v${version.join('.')}, é a última? ${isLatest}`);

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: Browsers.ubuntu('Chrome')
  });

  // Event: atualização de credenciais
  sock.ev.on('creds.update', saveCreds);

  // Event: atualização de conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // QR Code gerado
    if (qr) {
      qrCodeData = qr;
      connectionState = 'qr';
      logger.info('QR Code gerado! Escaneie com seu WhatsApp');
      qrcode.generate(qr, { small: true });
    }

    // Status de conexão
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      logger.info('Conexão fechada devido a:', lastDisconnect?.error);

      if (shouldReconnect) {
        logger.info('Reconectando...');
        connectionState = 'reconnecting';
        isConnected = false;
        setTimeout(() => connectToWhatsApp(), 3000);
      } else {
        logger.info('Desconectado. Escaneie o QR Code novamente.');
        connectionState = 'disconnected';
        isConnected = false;
        qrCodeData = null;
      }
    } else if (connection === 'open') {
      logger.info('✅ Conectado ao WhatsApp!');
      connectionState = 'connected';
      isConnected = true;
      qrCodeData = null;
    }
  });

  // Event: recebimento de mensagens
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const message = messages[0];
    
    // Ignora mensagens antigas e mensagens próprias
    if (!message.message || message.key.fromMe) return;

    logger.info('📨 Nova mensagem recebida');

    // Extrai informações da mensagem
    const messageData = {
      id: message.key.id,
      remoteJid: message.key.remoteJid,
      fromMe: message.key.fromMe,
      timestamp: message.messageTimestamp,
      pushName: message.pushName,
      message: message.message,
      messageType: Object.keys(message.message)[0],
      text: message.message.conversation || 
            message.message.extendedTextMessage?.text ||
            '',
      isGroup: message.key.remoteJid?.endsWith('@g.us'),
      participant: message.key.participant
    };

    logger.info(`De: ${messageData.pushName} (${messageData.remoteJid})`);
    logger.info(`Texto: ${messageData.text}`);

    // Envia para o webhook do n8n
    await sendToN8N({
      event: 'message.received',
      data: messageData
    });
  });

  // Event: atualização de presença
  sock.ev.on('presence.update', async (update) => {
    logger.debug('Presença atualizada:', update);
  });
}

// ==================== API ROUTES ====================

/**
 * GET / - Status do serviço
 */
app.get('/', (req, res) => {
  res.json({
    service: 'WhatsApp Baileys API',
    version: '1.0.0',
    status: connectionState,
    connected: isConnected
  });
});

/**
 * GET /status - Status detalhado da conexão
 */
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    state: connectionState,
    hasQR: qrCodeData !== null
  });
});

/**
 * GET /qr - Retorna o QR Code (se disponível)
 */
app.get('/qr', (req, res) => {
  if (qrCodeData) {
    res.json({
      qr: qrCodeData,
      message: 'Escaneie este QR Code com seu WhatsApp'
    });
  } else if (isConnected) {
    res.json({
      message: 'Já conectado ao WhatsApp'
    });
  } else {
    res.status(404).json({
      error: 'QR Code não disponível no momento'
    });
  }
});

/**
 * POST /send - Envia mensagem
 * Body: {
 *   "to": "5511999999999@s.whatsapp.net",
 *   "message": "Olá!"
 * }
 */
app.post('/send', async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({
      error: 'WhatsApp não conectado'
    });
  }

  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({
      error: 'Parâmetros "to" e "message" são obrigatórios'
    });
  }

  try {
    // Garante que o número está no formato correto
    let jid = to;
    if (!to.includes('@')) {
      jid = `${to}@s.whatsapp.net`;
    }

    await sock.sendMessage(jid, { text: message });
    
    logger.info(`Mensagem enviada para ${jid}`);
    
    res.json({
      success: true,
      message: 'Mensagem enviada com sucesso',
      to: jid
    });
  } catch (error) {
    logger.error('Erro ao enviar mensagem:', error);
    res.status(500).json({
      error: 'Erro ao enviar mensagem',
      details: error.message
    });
  }
});

/**
 * POST /send-media - Envia mídia (imagem, vídeo, áudio, documento)
 * Body: {
 *   "to": "5511999999999@s.whatsapp.net",
 *   "url": "https://example.com/image.jpg",
 *   "type": "image",
 *   "caption": "Legenda opcional"
 * }
 */
app.post('/send-media', async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({
      error: 'WhatsApp não conectado'
    });
  }

  const { to, url, type, caption, filename } = req.body;

  if (!to || !url || !type) {
    return res.status(400).json({
      error: 'Parâmetros "to", "url" e "type" são obrigatórios'
    });
  }

  try {
    let jid = to;
    if (!to.includes('@')) {
      jid = `${to}@s.whatsapp.net`;
    }

    // Baixa o arquivo
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();

    let messageContent = {};

    switch (type) {
      case 'image':
        messageContent = {
          image: Buffer.from(buffer),
          caption: caption || ''
        };
        break;
      case 'video':
        messageContent = {
          video: Buffer.from(buffer),
          caption: caption || ''
        };
        break;
      case 'audio':
        messageContent = {
          audio: Buffer.from(buffer),
          mimetype: 'audio/mp4'
        };
        break;
      case 'document':
        messageContent = {
          document: Buffer.from(buffer),
          fileName: filename || 'document',
          caption: caption || ''
        };
        break;
      default:
        return res.status(400).json({
          error: 'Tipo de mídia inválido. Use: image, video, audio ou document'
        });
    }

    await sock.sendMessage(jid, messageContent);
    
    logger.info(`Mídia ${type} enviada para ${jid}`);
    
    res.json({
      success: true,
      message: `Mídia ${type} enviada com sucesso`,
      to: jid
    });
  } catch (error) {
    logger.error('Erro ao enviar mídia:', error);
    res.status(500).json({
      error: 'Erro ao enviar mídia',
      details: error.message
    });
  }
});

/**
 * POST /webhook - Configura URL do webhook do n8n
 */
app.post('/webhook', (req, res) => {
  const { url } = req.body;
  
  if (!url) {
    return res.status(400).json({
      error: 'Parâmetro "url" é obrigatório'
    });
  }

  N8N_WEBHOOK_URL = url;
  process.env.N8N_WEBHOOK_URL = url;
  
  logger.info(`Webhook configurado: ${url}`);
  
  res.json({
    success: true,
    message: 'Webhook configurado com sucesso',
    url
  });
});

/**
 * POST /logout - Desconecta do WhatsApp
 */
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      isConnected = false;
      connectionState = 'disconnected';
      qrCodeData = null;
      
      res.json({
        success: true,
        message: 'Desconectado com sucesso'
      });
    } else {
      res.status(400).json({
        error: 'Não há conexão ativa'
      });
    }
  } catch (error) {
    logger.error('Erro ao desconectar:', error);
    res.status(500).json({
      error: 'Erro ao desconectar',
      details: error.message
    });
  }
});

// ==================== SERVER START ====================

app.listen(PORT, () => {
  logger.info(`🚀 Servidor rodando na porta ${PORT}`);
  logger.info(`📱 Conectando ao WhatsApp...`);
  connectToWhatsApp();
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

