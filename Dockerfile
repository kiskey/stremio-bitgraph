# Stage 1: Build dependencies
FROM node:18-alpine AS builder
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install

# Stage 2: Create the final image
FROM node:18-alpine
WORKDIR /usr/src/app

# Copy dependencies from the builder stage
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Copy application source code
COPY ./src ./src
COPY ./public ./public

# Copy package.json to ensure correct runtime behavior
COPY package.json .

# Expose the application port
EXPOSE 7000

# Set default environment variables (can be overridden)
ENV PORT=7000

# Start the application
CMD [ "node", "src/addon.js" ]
