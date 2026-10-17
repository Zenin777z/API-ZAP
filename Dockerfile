FROM node:20-alpine

WORKDIR /app

# Instala dependências básicas de compilação caso necessárias
RUN apk add --no-cache git

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# Expõe a porta padrão
EXPOSE 3333

CMD ["node", "server.js"]
