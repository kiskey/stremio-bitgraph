# Dockerfile
# Defines the Docker image for the Stremio Real-Debrid Addon.

# Use an official Node.js runtime as the base image
FROM node:20-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json (if exists) to the working directory
# This allows caching of dependencies
COPY package*.json ./

# Install dependencies
# The --omit=dev flag ensures dev dependencies are not installed in production
RUN npm install --omit=dev

# Copy the rest of the application code to the working directory
COPY . .

# Generate Prisma client for the production environment
# This command connects to your database and generates the Prisma client.
# Ensure your DATABASE_URL is available during the build stage if your Prisma schema relies on it.
# If you are only using environment variables at runtime, you can skip this build step
# and rely on the client being generated during `npm install` (if dev deps are included)
# or generate it locally before building the image.
# For production, it's safer to generate here to ensure consistency with the schema.
RUN npx prisma generate --data-proxy false

# Expose the port the app runs on
EXPOSE 7000

# Command to run the application
# Use 'npm start' as defined in package.json
CMD ["npm", "start"]
