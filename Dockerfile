FROM node:20-alpine

WORKDIR /app

# Instala dependências do sistema necessárias
RUN apk add --no-cache \
    git \
    python3 \
    make \
    g++ \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev

# Copia package.json e instala dependências
COPY package*.json ./
RUN npm install

# Copia o código da aplicação
COPY . .

# Cria diretório para autenticação
RUN mkdir -p auth_info_baileys

# Expõe a porta
EXPOSE 3000

# Comando para iniciar a aplicação
CMD ["npm", "start"]

