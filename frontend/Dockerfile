# ── Stage 1: build the React app ─────────────────────────────────────────────
FROM node:20.14-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY public ./public
COPY src ./src

# REACT_APP_BACKEND_URL is baked into the JS bundle at build time.
# Pass it as a build arg so docker-compose can set it per environment.
ARG REACT_APP_BACKEND_URL=http://localhost:3000
ENV REACT_APP_BACKEND_URL=$REACT_APP_BACKEND_URL

RUN npm run build

# ── Stage 2: serve with nginx ─────────────────────────────────────────────────
# The build output is static HTML/JS/CSS — nginx serves it with zero Node.js overhead.
FROM nginx:1.27-alpine AS runtime

# Remove the default nginx config and replace with ours
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the built React app from stage 1
COPY --from=builder /app/build /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
