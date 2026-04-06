#!/bin/bash

# Script de teste da API WhatsApp Baileys
# Uso: ./test-api.sh

BASE_URL="http://localhost:3000"

echo "🧪 Testando API WhatsApp Baileys"
echo "=================================="
echo ""

# Cores para output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Função para testar endpoint
test_endpoint() {
    local method=$1
    local endpoint=$2
    local description=$3
    local data=$4
    
    echo -e "${YELLOW}Testando:${NC} $description"
    echo "Endpoint: $method $endpoint"
    
    if [ -z "$data" ]; then
        response=$(curl -s -w "\n%{http_code}" -X $method "$BASE_URL$endpoint")
    else
        response=$(curl -s -w "\n%{http_code}" -X $method "$BASE_URL$endpoint" \
            -H "Content-Type: application/json" \
            -d "$data")
    fi
    
    http_code=$(echo "$response" | tail -n1)
    body=$(echo "$response" | sed '$d')
    
    if [ "$http_code" -ge 200 ] && [ "$http_code" -lt 300 ]; then
        echo -e "${GREEN}✓ Sucesso (HTTP $http_code)${NC}"
        echo "$body" | jq '.' 2>/dev/null || echo "$body"
    else
        echo -e "${RED}✗ Falha (HTTP $http_code)${NC}"
        echo "$body" | jq '.' 2>/dev/null || echo "$body"
    fi
    echo ""
}

# 1. Teste de status geral
test_endpoint "GET" "/" "Status geral do serviço"

# 2. Teste de status da conexão
test_endpoint "GET" "/status" "Status da conexão WhatsApp"

# 3. Teste de QR Code (se disponível)
test_endpoint "GET" "/qr" "QR Code (se disponível)"

# 4. Teste de envio de mensagem (DESCOMENTE E ADICIONE SEU NÚMERO)
# NUMERO="5511999999999"
# test_endpoint "POST" "/send" "Enviar mensagem de teste" \
#     "{\"to\": \"$NUMERO\", \"message\": \"Teste da API! 🚀\"}"

echo "=================================="
echo "✅ Testes concluídos!"
echo ""
echo "💡 Dicas:"
echo "  - Para testar envio de mensagens, descomente e configure a seção 4 no script"
echo "  - Verifique se o WhatsApp está conectado antes de enviar mensagens"
echo "  - Use 'docker logs -f whatsapp-baileys' para ver os logs em tempo real"

