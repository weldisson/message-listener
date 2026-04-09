import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  makeWASocket,
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
app.use(express.json({ limit: '50mb' }));
app.use('/ui', express.static('public'));
app.get('/ui', (req, res) => res.sendFile(new URL('./public/index.html', import.meta.url)));

const PORT = process.env.PORT || 3000;
let N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const ENABLE_N8N = process.env.ENABLE_N8N !== 'false';

let sock;
let qrCodeData = null;
let isConnected = false;
let connectionState = 'disconnected';

function hasValidSession() {
  return !!(sock && sock.authState && sock.authState.creds && Object.keys(sock.authState.creds).length > 0);
}

// Logger
const logger = pino({
  level: process.env.LOG_LEVEL || 'info'
});

/**
 * Envia mensagem para o webhook do n8n
 */
async function sendToN8N(data) {
  if (!ENABLE_N8N) {
    logger.info('Envio para n8n está desabilitado por ENABLE_N8N=false');
    return;
  }

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
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    connectTimeoutMs: 60000,
    qrTimeout: 40000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    markOnlineOnConnect: false
  });

  // Event: atualização de credenciais
  sock.ev.on('creds.update', saveCreds);

  // Event: atualização de conexão
  sock.ev.on('connection.update', async (update) => {
    try {
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
          setTimeout(() => connectToWhatsApp().catch(error => {
            logger.error({ err: error }, 'Erro ao reconectar ao WhatsApp');
            console.error('Erro ao reconectar ao WhatsApp:', error.stack || error);
          }), 5000); // 5 segundos
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
    } catch (error) {
      logger.error('Erro no evento de atualização de conexão:', error);
    }
  });

  // Event: recebimento de mensagens
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Apenas processar novas mensagens reais (ignorar sincronizações antigas)
    if (type !== 'notify') return;

    for (const message of messages) {
      // Ignora mensagens sem conteúdo ou mensagens enviadas por mim
      if (!message.message || message.key.fromMe) continue;

      logger.info('📨 Nova mensagem recebida');

      // Resolve mensagens efêmeras (temporárias) ou visualização única
      const msgContent = message.message?.ephemeralMessage?.message || 
                         message.message?.viewOnceMessage?.message || 
                         message.message;
                         
      const messageType = Object.keys(msgContent)[0];

      // Extrai o texto da mensagem com base no tipo
      const text = msgContent.conversation || 
                   msgContent.extendedTextMessage?.text ||
                   msgContent.imageMessage?.caption ||
                   msgContent.videoMessage?.caption ||
                   msgContent.documentMessage?.caption ||
                   msgContent.buttonsResponseMessage?.selectedButtonId ||
                   msgContent.listResponseMessage?.title ||
                   '';

      // Extrai informações da mensagem
      const messageData = {
        id: message.key.id,
        remoteJid: message.key.remoteJid,
        fromMe: message.key.fromMe,
        timestamp: message.messageTimestamp,
        pushName: message.pushName || 'Desconhecido',
        message: message.message,
        messageType: messageType,
        text: text,
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
    }
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
    hasSession: hasValidSession(),
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

  if (!hasValidSession()) {
    return res.status(503).json({
      error: 'Nenhuma sessão ativa. Escaneie o QR Code e aguarde a conexão.'
    });
  }

  const rawTo = req.body.to?.toString().trim();
  const message = req.body.message?.toString();

  if (!rawTo || !message) {
    return res.status(400).json({
      error: 'Parâmetros "to" e "message" são obrigatórios'
    });
  }

  let jid = rawTo;
  try {
    if (!rawTo.includes('@')) {
      if (rawTo.includes('-')) {
        jid = `${rawTo}@g.us`;
      } else {
        jid = `${rawTo}@s.whatsapp.net`;
      }
    }

    logger.info(`\n=== Enviando mensagem ===`);
    logger.info(`Para: ${jid}`);

    if (jid.endsWith('@g.us')) {
      logger.info(`Carregando metadata do grupo...`);
      const groupData = await sock.groupMetadata(jid);
      logger.info(`Grupo tem ${groupData?.participants?.length || 0} participantes`);
      
      logger.info(`Sincronizando estado...`);
      try {
        await sock.uploadPreKeysToServerIfRequired();
        await sock.resyncAppState(['critical_block', 'critical_unblock_low', 'regular_high', 'regular_low', 'regular'], false);
        await sock.cleanDirtyBits('groups');
      } catch (e) {
        logger.warn('Erro na sincronização (não crítico):', e.message);
      }
      
      logger.info(`Estabelecendo sessões com participantes...`);
      if (groupData?.participants) {
        const participantJids = groupData.participants.map(p => p.id);
        try {
          await sock.assertSessions(participantJids, true);
          logger.info(`Sessões estabelecidas`);
        } catch (sessionErr) {
          logger.warn('Erro ao estabelecer sessões:', sessionErr.message);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    } else {
      const contact = await sock.onWhatsApp(jid);
      if (!contact || !contact[0]?.exists) {
        return res.status(400).json({
          error: 'Número não está registrado no WhatsApp',
          to: jid
        });
      }
    }

    let sendError = null;
    let lastAttempt = 0;
    
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await sock.sendMessage(jid, { text: message });
        lastAttempt = attempt;
        break;
      } catch (err) {
        sendError = err;
        logger.warn(`Tentativa ${attempt} falhou:`, err.message);
        
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    if (sendError) {
      throw sendError;
    }

    logger.info(`Mensagem enviada com sucesso na tentativa ${lastAttempt}`);
    
    res.json({
      success: true,
      message: 'Mensagem enviada com sucesso',
      to: jid
    });
  } catch (error) {
    logger.error('Erro ao enviar mensagem:', error.message);

    if (error?.message?.includes('No sessions')) {
      return res.status(503).json({
        error: 'Sem sessão de criptografia para este destinatário. Verifique se o JID está correto e se o contato/grupo existe.',
        details: error.message,
        to: jid
      });
    }

    res.status(500).json({
      error: 'Erro ao enviar mensagem',
      details: error.message
    });
  }
});

/**
 * GET /groups - Lista grupos atuais que o WhatsApp está participando
 */
app.get('/groups', async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({
      error: 'WhatsApp não conectado'
    });
  }

  if (!hasValidSession()) {
    return res.status(503).json({
      error: 'Nenhuma sessão ativa. Escaneie o QR Code e aguarde a conexão.'
    });
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.entries(groups || {}).map(([jid, group]) => {
      const participants = group.participants
        ? typeof group.participants.size === 'number'
          ? group.participants.size
          : Object.keys(group.participants).length
        : 0;

      return {
        jid,
        subject: group.subject || group.name || jid,
        participants
      };
    });

    res.json({
      success: true,
      groups: groupList
    });
  } catch (error) {
    logger.error('Erro ao listar grupos:', error);
    res.status(500).json({
      error: 'Erro ao listar grupos',
      details: error.message
    });
  }
});

/**
 * GET /debug - Retorna informações básicas de debug
 */
app.get('/debug', async (req, res) => {
  try {
    const debug = {
      connected: isConnected,
      state: connectionState,
      hasValidSession: hasValidSession(),
      meId: sock?.authState?.creds?.me?.id,
      timestamp: new Date().toISOString()
    };

    res.json(debug);
  } catch (error) {
    logger.error('Erro ao gerar debug info:', error.message);
    res.status(500).json({
      error: 'Erro ao gerar debug info',
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
 * POST /send-document - Envia documento via base64 (para backups, etc)
 * Body: {
 *   "to": "5521979052877",
 *   "base64": "UEsDBBQAAAA...",
 *   "filename": "backup.dump",
 *   "caption": "Backup do banco"
 * }
 */
app.post('/send-document', async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({ error: 'WhatsApp não conectado' });
  }

  const { to, base64, filename, caption } = req.body;

  if (!to || !base64 || !filename) {
    return res.status(400).json({
      error: 'Parâmetros "to", "base64" e "filename" são obrigatórios'
    });
  }

  try {
    let jid = to.toString().trim();
    if (!jid.includes('@')) {
      jid = `${jid}@s.whatsapp.net`;
    }

    const buffer = Buffer.from(base64, 'base64');

    await sock.sendMessage(jid, {
      document: buffer,
      fileName: filename,
      caption: caption || ''
    });

    logger.info(`Documento ${filename} enviado para ${jid} (${(buffer.length / 1024).toFixed(1)}KB)`);

    res.json({
      success: true,
      message: `Documento ${filename} enviado com sucesso`,
      to: jid,
      size: `${(buffer.length / 1024).toFixed(1)}KB`
    });
  } catch (error) {
    logger.error('Erro ao enviar documento:', error);
    res.status(500).json({
      error: 'Erro ao enviar documento',
      details: error.message
    });
  }
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
  connectToWhatsApp().catch(error => {
    logger.error({ err: error }, 'Erro ao conectar ao WhatsApp');
    console.error('Erro ao conectar ao WhatsApp:', error.stack || error);
  });
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ promise, reason }, 'Unhandled Rejection');
});

process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught Exception');
  console.error('Uncaught Exception:', error.stack || error);
  process.exit(1);
});

