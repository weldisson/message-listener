FROM node:20-alpine

WORKDIR /app

# Instala dependências mínimas do sistema
RUN apk add --no-cache git

# Copia package.json e instala dependências
COPY package*.json ./
RUN npm ci --only=production

# Copia o código da aplicação
COPY . .

# Cria diretório para autenticação
RUN mkdir -p auth_info_baileys

# Expõe a porta
EXPOSE 3000

# Comando para iniciar a aplicação
CMD ["npm", "start"]

