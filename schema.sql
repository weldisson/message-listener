-- Criação da tabela para armazenar mensagens do WhatsApp
-- Use este script se quiser salvar mensagens no PostgreSQL

CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id SERIAL PRIMARY KEY,
    message_id VARCHAR(255) NOT NULL,
    remote_jid VARCHAR(255) NOT NULL,
    push_name VARCHAR(255),
    message_text TEXT,
    message_type VARCHAR(50),
    is_group BOOLEAN DEFAULT FALSE,
    participant VARCHAR(255),
    timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Índices para performance
    CONSTRAINT unique_message UNIQUE (message_id)
);

-- Índices para buscas rápidas
CREATE INDEX IF NOT EXISTS idx_remote_jid ON whatsapp_messages(remote_jid);
CREATE INDEX IF NOT EXISTS idx_timestamp ON whatsapp_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_is_group ON whatsapp_messages(is_group);
CREATE INDEX IF NOT EXISTS idx_created_at ON whatsapp_messages(created_at);

-- Índice para busca de texto (opcional, para busca full-text)
CREATE INDEX IF NOT EXISTS idx_message_text ON whatsapp_messages USING gin(to_tsvector('portuguese', message_text));

-- Comentários
COMMENT ON TABLE whatsapp_messages IS 'Tabela para armazenar mensagens recebidas do WhatsApp via Baileys';
COMMENT ON COLUMN whatsapp_messages.message_id IS 'ID único da mensagem no WhatsApp';
COMMENT ON COLUMN whatsapp_messages.remote_jid IS 'Identificador do remetente (número@s.whatsapp.net)';
COMMENT ON COLUMN whatsapp_messages.push_name IS 'Nome do contato conforme aparece no WhatsApp';
COMMENT ON COLUMN whatsapp_messages.message_text IS 'Conteúdo da mensagem';
COMMENT ON COLUMN whatsapp_messages.message_type IS 'Tipo da mensagem (conversation, imageMessage, etc)';
COMMENT ON COLUMN whatsapp_messages.is_group IS 'Indica se a mensagem veio de um grupo';
COMMENT ON COLUMN whatsapp_messages.participant IS 'Participante que enviou (apenas para grupos)';
COMMENT ON COLUMN whatsapp_messages.timestamp IS 'Timestamp da mensagem no WhatsApp';
COMMENT ON COLUMN whatsapp_messages.created_at IS 'Timestamp de quando foi inserido no banco';

-- View para estatísticas
CREATE OR REPLACE VIEW whatsapp_stats AS
SELECT 
    DATE(timestamp) as date,
    COUNT(*) as total_messages,
    COUNT(DISTINCT remote_jid) as unique_contacts,
    COUNT(*) FILTER (WHERE is_group = true) as group_messages,
    COUNT(*) FILTER (WHERE is_group = false) as private_messages
FROM whatsapp_messages
GROUP BY DATE(timestamp)
ORDER BY date DESC;

COMMENT ON VIEW whatsapp_stats IS 'Estatísticas diárias de mensagens do WhatsApp';

-- Tabela para contatos (opcional)
CREATE TABLE IF NOT EXISTS whatsapp_contacts (
    id SERIAL PRIMARY KEY,
    jid VARCHAR(255) NOT NULL UNIQUE,
    push_name VARCHAR(255),
    is_group BOOLEAN DEFAULT FALSE,
    first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    message_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_contacts_jid ON whatsapp_contacts(jid);
CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON whatsapp_contacts(last_seen);

COMMENT ON TABLE whatsapp_contacts IS 'Tabela para rastrear contatos do WhatsApp';

-- Função para atualizar contatos automaticamente
CREATE OR REPLACE FUNCTION update_contact_on_message()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO whatsapp_contacts (jid, push_name, is_group, last_seen, message_count)
    VALUES (NEW.remote_jid, NEW.push_name, NEW.is_group, NEW.timestamp, 1)
    ON CONFLICT (jid) 
    DO UPDATE SET
        push_name = COALESCE(EXCLUDED.push_name, whatsapp_contacts.push_name),
        last_seen = EXCLUDED.last_seen,
        message_count = whatsapp_contacts.message_count + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger para atualizar contatos
CREATE TRIGGER trg_update_contacts
AFTER INSERT ON whatsapp_messages
FOR EACH ROW
EXECUTE FUNCTION update_contact_on_message();

-- Query de exemplo: Contatos mais ativos
-- SELECT * FROM whatsapp_contacts ORDER BY message_count DESC LIMIT 10;

-- Query de exemplo: Mensagens recentes
-- SELECT * FROM whatsapp_messages ORDER BY timestamp DESC LIMIT 50;

-- Query de exemplo: Estatísticas por contato
-- SELECT 
--     push_name,
--     COUNT(*) as total_messages,
--     MAX(timestamp) as last_message
-- FROM whatsapp_messages
-- GROUP BY push_name, remote_jid
-- ORDER BY total_messages DESC;

