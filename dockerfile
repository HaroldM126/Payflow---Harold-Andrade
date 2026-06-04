#etapa 1: build
FROM node:20-alpine AS builder

# Establecer el directorio de trabajo
WORKDIR /app

COPY package*.json ./

# Instalar dependencias
RUN npm ci

COPY . .

RUN npm run build

#etapa 2: run (Image final)
FROM node:20-alpine

# Directorio de trabajo
WORKDIR /app

#Activar optimizaciones de rendimiento
ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=development

COPY --from=builder /app/dist ./dist

CMD ["node", "dist/main.js"]
