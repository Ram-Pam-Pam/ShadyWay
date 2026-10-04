# ETAP 1: Budowanie aplikacji
FROM node:20-alpine AS builder

WORKDIR /app

# Kopiowanie plików zależności i ich instalacja (npm ci jest szybsze i bezpieczniejsze niż npm install)
COPY package.json package-lock.json ./
RUN npm ci

# Kopiowanie reszty kodu i budowanie aplikacji (np. frontend w Vite + backend)
COPY . .
RUN npm run build

# ETAP 2: Środowisko produkcyjne
FROM node:20-alpine

WORKDIR /app

# Kopiowanie tylko plików definiujących zależności
COPY package.json package-lock.json ./

# Instalacja tylko pakietów produkcyjnych (bez devDependencies)
RUN npm ci --omit=dev

# Skopiowanie zbudowanych plików z pierwszego etapu (zazwyczaj folder dist lub build)
COPY --from=builder /app/dist ./dist

# Skopiowanie ewentualnych folderów z danymi, które aplikacja musi odczytywać (np. Twój folder data/)
COPY data ./data

# Ustawienie zmiennej środowiskowej na produkcję
ENV NODE_ENV=production

# Otwarcie portu, na którym działa serwer (zmień na swój, jeśli to nie 3000)
EXPOSE 3000

# Komenda uruchamiająca aplikację (zmień jeśli w package.json masz inną, np. "npm run preview" lub "node dist/index.js")
CMD ["npm", "start"]