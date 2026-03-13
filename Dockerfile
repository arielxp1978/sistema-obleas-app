FROM node:20-alpine

WORKDIR /app

# Copiar dependencias primero (para cache de Docker)
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# Copiar el resto del código
COPY . .

# Crear directorios necesarios
RUN mkdir -p data/periodos uploads

EXPOSE 3000

CMD ["node", "server.js"]
