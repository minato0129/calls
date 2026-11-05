# ---------- 開発用: Vite 開発サーバー(ソースはボリュームでマウント、HMR 有効) ----------
FROM node:22-alpine AS dev
WORKDIR /app
EXPOSE 5173
CMD ["sh", "-c", "npm install && npm run dev -- --host 0.0.0.0 --port 5173"]

# ---------- 本番用ビルド ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ビルド結果を配信するだけのコンテナ(入口の nginx から転送される)
FROM nginx:1.27-alpine AS prod
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
